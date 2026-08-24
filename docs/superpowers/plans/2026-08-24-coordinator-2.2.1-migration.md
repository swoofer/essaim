# Migration essaim → mcp-coordinator 2.2.1 — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire fonctionner essaim contre `mcp-coordinator@2.2.1` — dont la rupture décisive est que les topics MQTT sont désormais scopés par organisation, ce qui rend muette toute la coordination push sans lever la moindre erreur.

**Architecture:** essaim dispose déjà de l'org qu'il lui faut : elle est dans le claim `org` du `COORDINATOR_TOKEN` qu'il envoie en mot de passe MQTT. On décode ce claim côté client (jamais on ne le vérifie — le serveur reste l'autorité), on préfixe les sept topics, on décale les index de parsing, et on rend bruyant tout refus d'abonnement. Le reste est du nettoyage : deux endpoints supprimés côté serveur, un plancher Node, et une vérification des corps REST maintenant validés par zod.

**Tech Stack:** TypeScript (ESM, `tsc` → `dist/`), vitest (`fileParallelism: false`), `mqtt@^5`, Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-08-24-coordinator-2.2.1-migration-findings.md`

## Global Constraints

- Plancher Node : `>=22`. Valeur imposée par `mcp-coordinator@2.2.1` (`engines: {"node": ">=22"}`).
- Dépendance cible : `"mcp-coordinator": "^2.2.1"`. Un caret sur `^0.13.0` ne remonte jamais en 1.x/2.x.
- Aucun script de lint ni de format n'existe. La CI est exactement `npm install && npm test && npm run build`. Ne pas en inventer.
- Garde-fou CI `no-domain-artifacts` : le nom du client ne doit apparaître dans **aucun** fichier suivi hors `.github/workflows/test.yml`. Ne jamais l'écrire ailleurs, y compris dans un commentaire ou un message de commit.
- `vitest.config.ts` ne ramasse que `tests/**/*.test.ts`. Les tests shell (`tests/*.test.sh`) sont montés automatiquement par `tests/unit/shell-scripts.test.ts` — aucune inscription manuelle.
- Un test chmod est Windows-only et se skippe ailleurs. Un skip sur macOS/Linux n'est pas un échec.
- Commits en Conventional Commits (`CONTRIBUTING.md:34`).

---

## File Structure

| Fichier | Responsabilité | Tâche |
|---|---|---|
| `package.json` | plancher Node + version de la dépendance | 1 |
| `src/agent-loop/mqtt-listener.ts` | dérivation de l'org, topics scopés, parsing décalé, diagnostic des refus | 2, 3 |
| `tests/unit/mqtt-org-scoping.test.ts` | **créé** — org depuis le token, construction des topics, classification décalée | 2 |
| `tests/unit/mqtt-diagnostics.test.ts` | **créé** — un abonnement refusé est journalisé au niveau `warn` | 3 |
| `src/orchestrator/orchestrator.ts` | retrait de l'appel `/api/run-config` | 4 |
| `src/agent-loop/agent-loop.ts` | retrait de l'appel `/api/token-usage` | 4 |
| `README.md`, `CLAUDE.md` | plancher Node, forme des topics | 7 |

`mqtt-listener.ts` fait 15 K et porte déjà une responsabilité claire — recevoir et classer les événements poussés. Les tâches 2 et 3 restent dedans. Pas de découpage : ce serait une restructuration non demandée.

---

## Task 1: Monter le plancher Node et prendre la dépendance

**Files:**
- Modify: `package.json` (clés `engines` et `dependencies.mcp-coordinator`)

**Interfaces:**
- Consumes: rien.
- Produces: un `node_modules/mcp-coordinator` en 2.2.x, et l'inventaire écrit de ce qui casse — dont les tâches 2 à 6 sont la réponse. Aucune signature de code.

- [ ] **Step 1: Constater l'état de départ**

```bash
node -p "require('./package.json').engines.node"
node -p "require('./package.json').dependencies['mcp-coordinator']"
node -p "require('./node_modules/mcp-coordinator/package.json').version"
```

Attendu : `>=20`, `^0.13.0`, `0.13.0`.

- [ ] **Step 2: Modifier les deux clés**

Dans `package.json`, remplacer `"mcp-coordinator": "^0.13.0",` par :

```json
"mcp-coordinator": "^2.2.1",
```

et remplacer `"engines": { "node": ">=20" }` par :

```json
"engines": { "node": ">=22" }
```

- [ ] **Step 3: Installer et vérifier la version résolue**

```bash
npm install
node -p "require('./node_modules/mcp-coordinator/package.json').version"
```

Attendu : une version `2.2.x`. Si npm rend encore `0.13.0`, le caret n'a pas été modifié — relire l'étape 2.

- [ ] **Step 4: Prendre l'inventaire des dégâts, sans rien corriger**

```bash
npm test 2>&1 | tail -40
npm run build 2>&1 | tail -20
```

Consigner la liste des échecs dans le message de commit. **Ne rien réparer ici** : chaque réparation a sa tâche. Une erreur `tsc` liée aux types du coordinator est attendue à ce stade.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(deps): passe a mcp-coordinator 2.2.1 et au plancher Node 22"
```

---

## Task 2: Scoper les topics MQTT par organisation

C'est la tâche qui débloque la coordination. Sans elle, essaim se connecte et n'entend rien.

**Files:**
- Modify: `src/agent-loop/mqtt-listener.ts` (constante `TOPICS` lignes 108-116 ; `classifyTopic` lignes 118-141 ; `buildInterrupt` lignes 144-178 ; l'appel `subscribe` ligne 361)
- Test: `tests/unit/mqtt-org-scoping.test.ts` (créé)

**Interfaces:**
- Consumes: `coordinatorToken()` depuis `../coordinator-auth.js`, déjà importé ligne 4.
- Produces:
  - `export function orgFromToken(token: string | undefined): string`
  - `export function topicsForOrg(org: string): string[]`
  - `export function classifyTopic(topic: string, payload: Record<string, unknown>): InterruptType | null` — signature inchangée, indices décalés de un, ajout du mot-clé `export`.
  - `export function buildInterrupt(type: InterruptType, topic: string, payload: Record<string, unknown>): MqttInterrupt` — idem.

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `tests/unit/mqtt-org-scoping.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import {
  orgFromToken,
  topicsForOrg,
  classifyTopic,
  buildInterrupt,
} from "../../src/agent-loop/mqtt-listener.js";

/** Fabrique un JWT non signé : seule la charge utile compte, on ne vérifie jamais. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

describe("orgFromToken", () => {
  it("lit le claim org", () => {
    expect(orgFromToken(jwt({ org: "acme", sub: "agent-1" }))).toBe("acme");
  });

  it("retombe sur 'default' quand le claim manque, comme le coordinator", () => {
    expect(orgFromToken(jwt({ sub: "agent-1" }))).toBe("default");
  });

  it("retombe sur 'default' sans token", () => {
    expect(orgFromToken(undefined)).toBe("default");
  });

  it("retombe sur 'default' sur un token illisible plutot que de jeter", () => {
    expect(orgFromToken("pas-un-jwt")).toBe("default");
    expect(orgFromToken("a.!!!.c")).toBe("default");
  });
});

describe("topicsForOrg", () => {
  it("prefixe les sept topics par coordinator/<org>/", () => {
    expect(topicsForOrg("acme")).toEqual([
      "coordinator/acme/consultations/new",
      "coordinator/acme/consultations/+/messages",
      "coordinator/acme/consultations/+/status",
      "coordinator/acme/consultations/+/claimed",
      "coordinator/acme/consultations/+/completed",
      "coordinator/acme/broadcast",
      "coordinator/acme/agents/+/status",
    ]);
  });

  it("chaque topic commence par le prefixe que l'ACL du coordinator exige", () => {
    for (const t of topicsForOrg("acme")) {
      expect(t.startsWith("coordinator/acme/")).toBe(true);
    }
  });
});

describe("classifyTopic sur la forme scopee", () => {
  it("classe une nouvelle consultation", () => {
    expect(classifyTopic("coordinator/acme/consultations/new", {})).toBe("consultation_new");
  });

  it("classe un message de thread", () => {
    expect(classifyTopic("coordinator/acme/consultations/t1/messages", {})).toBe(
      "consultation_message",
    );
  });

  it("distingue resolved de resolving sur le topic status", () => {
    expect(classifyTopic("coordinator/acme/consultations/t1/status", { status: "resolved" })).toBe(
      "consultation_resolved",
    );
    expect(classifyTopic("coordinator/acme/consultations/t1/status", { status: "proposed" })).toBe(
      "consultation_resolving",
    );
  });

  it("classe claimed et completed", () => {
    expect(classifyTopic("coordinator/acme/consultations/t1/claimed", {})).toBe(
      "consultation_claimed",
    );
    expect(classifyTopic("coordinator/acme/consultations/t1/completed", {})).toBe(
      "consultation_completed",
    );
  });

  it("classe le statut d'agent", () => {
    expect(classifyTopic("coordinator/acme/agents/a1/status", { status: "offline" })).toBe(
      "agent_offline",
    );
    expect(classifyTopic("coordinator/acme/agents/a1/status", { status: "online" })).toBe(
      "agent_online",
    );
  });

  it("classe le broadcast", () => {
    expect(classifyTopic("coordinator/acme/broadcast", {})).toBe("broadcast");
  });

  it("ignore l'ancienne forme non scopee, que le coordinator ne publie plus", () => {
    expect(classifyTopic("coordinator/consultations/new", {})).toBeNull();
  });
});

describe("buildInterrupt sur la forme scopee", () => {
  it("extrait le threadId du topic", () => {
    const i = buildInterrupt("consultation_message", "coordinator/acme/consultations/t42/messages", {});
    expect(i.threadId).toBe("t42");
  });

  it("laisse la charge utile primer sur le topic", () => {
    const i = buildInterrupt("consultation_message", "coordinator/acme/consultations/t42/messages", {
      thread_id: "t99",
    });
    expect(i.threadId).toBe("t99");
  });

  it("extrait l'agentId d'un topic de statut", () => {
    const i = buildInterrupt("agent_offline", "coordinator/acme/agents/a7/status", {});
    expect(i.agentId).toBe("a7");
  });
});
```

- [ ] **Step 2: Lancer les tests pour les voir échouer**

```bash
npx vitest run tests/unit/mqtt-org-scoping.test.ts
```

Attendu : ÉCHEC — `orgFromToken` et `topicsForOrg` ne sont pas exportés.

- [ ] **Step 3: Ajouter la dérivation de l'org et la construction des topics**

Dans `src/agent-loop/mqtt-listener.ts`, remplacer la constante `TOPICS` (lignes 108-116) par :

```ts
/**
 * Le segment org de chaque topic du coordinator (#330). Le coordinator le tire du
 * claim `org` du token et refuse — SILENCIEUSEMENT, via `cb(null, null)` dans
 * `authorizeSubscribe` — tout abonnement hors de `coordinator/<org>/`. Un joker
 * `coordinator/+/...` est refuse aussi : le test est un `startsWith` sur le prefixe.
 *
 * On decode, on ne verifie jamais : le serveur reste l'autorite, on n'a besoin que
 * du prefixe de routage. Le repli sur "default" reproduit exactement celui du
 * coordinator (`src/auth.ts:126`), sans quoi un token sans claim `org` s'abonnerait
 * a un prefixe que le serveur n'emploie pas.
 */
export function orgFromToken(token: string | undefined): string {
  if (!token) return "default";
  const parts = token.split(".");
  if (parts.length < 2) return "default";
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.org === "string" && payload.org ? payload.org : "default";
  } catch {
    return "default";
  }
}

/** Les sept topics auxquels l'agent s'abonne, prefixes par son org. */
export function topicsForOrg(org: string): string[] {
  const p = `coordinator/${org}`;
  return [
    `${p}/consultations/new`,
    `${p}/consultations/+/messages`,
    `${p}/consultations/+/status`,
    `${p}/consultations/+/claimed`,
    `${p}/consultations/+/completed`,
    `${p}/broadcast`,
    `${p}/agents/+/status`,
  ];
}
```

- [ ] **Step 4: Décaler les index de parsing**

Remplacer `classifyTopic` en entier. `parts[1]` est désormais l'org — jamais testée ici, puisque l'ACL du serveur garantit qu'on ne reçoit que la sienne :

```ts
export function classifyTopic(
  topic: string,
  payload: Record<string, unknown>,
): InterruptType | null {
  const parts = topic.split("/");
  // coordinator/<org>/... : le genre est en [2], l'identifiant en [3], la feuille en [4].
  if (parts[0] !== "coordinator" || parts.length < 3) return null;

  if (parts[2] === "consultations") {
    if (parts[3] === "new") return "consultation_new";
    if (parts[4] === "messages") return "consultation_message";
    if (parts[4] === "claimed") return "consultation_claimed";
    if (parts[4] === "completed") return "consultation_completed";
    if (parts[4] === "status") {
      const status = payload.status as string | undefined;
      if (status === "resolved") return "consultation_resolved";
      return "consultation_resolving";
    }
  }

  if (parts[2] === "agents" && parts[4] === "status") {
    const status = payload.status as string | undefined;
    if (status === "offline") return "agent_offline";
    return "agent_online";
  }

  if (parts[2] === "broadcast") return "broadcast";

  return null;
}
```

Dans `buildInterrupt`, ajouter `export` devant la déclaration, puis remplacer le bloc d'extraction du threadId :

```ts
  // Extrait le threadId : coordinator/<org>/consultations/{id}/messages|status|claimed|completed
  if (parts[2] === "consultations" && parts.length >= 5 && parts[3] !== "new") {
    interrupt.threadId = parts[3];
  }
```

et le bloc d'extraction de l'agentId :

```ts
  // Topic de statut d'agent : coordinator/<org>/agents/{agentId}/status
  if (parts[2] === "agents" && parts[4] === "status") {
    interrupt.agentId = parts[3];
  }
```

- [ ] **Step 5: Brancher l'abonnement sur l'org du token**

Remplacer l'appel `client!.subscribe(TOPICS, ...)` (ligne 361) par :

```ts
          const org = orgFromToken(coordinatorToken());
          const topics = topicsForOrg(org);
          client!.subscribe(topics, (err) => {
            if (err) {
              reject(err);
              return;
            }
            log.info("connected", { url, org });
            resolve();
          });
```

- [ ] **Step 6: Lancer les tests pour les voir passer**

```bash
npx vitest run tests/unit/mqtt-org-scoping.test.ts
```

Attendu : PASS sur les 15 cas.

- [ ] **Step 7: Lancer toute la suite**

```bash
npm test
```

Attendu : aucun nouvel échec par rapport à l'inventaire de la tâche 1.

- [ ] **Step 8: Commit**

```bash
git add src/agent-loop/mqtt-listener.ts tests/unit/mqtt-org-scoping.test.ts
git commit -m "fix(mqtt): scope les topics par organisation, comme le coordinator 2.x les publie"
```

---

## Task 3: Rendre bruyant un abonnement refusé

Sans cette tâche, la tâche 2 est invérifiable en production : un mauvais préfixe redonne exactement le silence d'aujourd'hui. C'est ce trou qui a laissé l'issue #33 survivre à un pilote entier.

**Files:**
- Modify: `src/agent-loop/mqtt-listener.ts` (callback de `subscribe` posé en tâche 2 ; handler `close` lignes 393-396 ; ajout d'un handler `error`)
- Test: `tests/unit/mqtt-diagnostics.test.ts` (créé)

**Interfaces:**
- Consumes: `topicsForOrg`, `orgFromToken` de la tâche 2.
- Produces: `export function grantedTopics(granted: Array<{ topic: string; qos: number }>): { ok: string[]; refused: string[] }` — partitionne le retour de `subscribe`. Un QoS ≥ 128 est un refus (code d'échec SUBACK, MQTT 3.1.1 §3.9.3).

- [ ] **Step 1: Écrire le test qui échoue**

Créer `tests/unit/mqtt-diagnostics.test.ts` :

```ts
import { describe, it, expect } from "vitest";
import { grantedTopics } from "../../src/agent-loop/mqtt-listener.js";

describe("grantedTopics", () => {
  it("separe les abonnements accordes des refuses", () => {
    const r = grantedTopics([
      { topic: "coordinator/acme/broadcast", qos: 0 },
      { topic: "coordinator/acme/consultations/new", qos: 1 },
      { topic: "coordinator/autre/broadcast", qos: 128 },
    ]);
    expect(r.ok).toEqual([
      "coordinator/acme/broadcast",
      "coordinator/acme/consultations/new",
    ]);
    expect(r.refused).toEqual(["coordinator/autre/broadcast"]);
  });

  it("traite tout QoS >= 128 comme un refus", () => {
    const r = grantedTopics([{ topic: "t", qos: 135 }]);
    expect(r.refused).toEqual(["t"]);
    expect(r.ok).toEqual([]);
  });

  it("rend deux listes vides sur une entree vide", () => {
    expect(grantedTopics([])).toEqual({ ok: [], refused: [] });
  });
});
```

- [ ] **Step 2: Lancer le test pour le voir échouer**

```bash
npx vitest run tests/unit/mqtt-diagnostics.test.ts
```

Attendu : ÉCHEC — `grantedTopics` n'est pas exporté.

- [ ] **Step 3: Implémenter la partition**

Dans `src/agent-loop/mqtt-listener.ts` :

```ts
/**
 * MQTT 3.1.1 §3.9.3 : le SUBACK rend un code par topic, et tout code >= 128 est
 * un echec. Le coordinator refuse par `cb(null, null)` dans `authorizeSubscribe`,
 * ce qui arrive ici sous cette forme, sans erreur de connexion. Un refus non
 * signale, c'est un run entier sans coordination et sans un mot (#33).
 */
export function grantedTopics(
  granted: Array<{ topic: string; qos: number }>,
): { ok: string[]; refused: string[] } {
  const ok: string[] = [];
  const refused: string[] = [];
  for (const g of granted) {
    (g.qos >= 128 ? refused : ok).push(g.topic);
  }
  return { ok, refused };
}
```

- [ ] **Step 4: Exploiter la partition et remonter les vraies causes**

Remplacer le callback de `subscribe` posé en tâche 2 par :

```ts
          client!.subscribe(topics, (err, granted) => {
            if (err) {
              reject(err);
              return;
            }
            const { ok, refused } = grantedTopics(granted ?? []);
            if (refused.length > 0) {
              log.warn("subscriptions refused by the coordinator", { org, refused });
            }
            log.info("connected", { url, org, subscribed: ok.length });
            resolve();
          });
```

Puis, juste après le handler `close` (lignes 393-396), ajouter un handler `error` :

```ts
        // Sans ceci, une erreur d'upgrade WS ou d'authentification est purement
        // avalee : `close` ne porte aucune cause, et son niveau debug la masque.
        client.on("error", (err: Error) => {
          log.warn("mqtt error", { url, message: err.message });
        });
```

- [ ] **Step 5: Lancer les tests pour les voir passer**

```bash
npx vitest run tests/unit/mqtt-diagnostics.test.ts && npm test
```

Attendu : PASS sur les 3 cas, et aucun nouvel échec dans la suite.

- [ ] **Step 6: Commit**

```bash
git add src/agent-loop/mqtt-listener.ts tests/unit/mqtt-diagnostics.test.ts
git commit -m "fix(mqtt): signale un abonnement refuse et la vraie cause d'une deconnexion"
```

---

## Task 4: Retirer les deux endpoints supprimés côté serveur

**Files:**
- Modify: `src/orchestrator/orchestrator.ts:231-241` (bloc `/api/run-config`)
- Modify: `src/agent-loop/agent-loop.ts` (fonction `postTokenUsageSse` à partir de la ligne 455, et tous ses appels)

**Interfaces:**
- Consumes: rien des tâches précédentes.
- Produces: rien. Suppression pure.

- [ ] **Step 1: Confirmer l'absence côté coordinator avant de supprimer**

```bash
grep -rn "run-config\|token-usage" /c/Users/gagno/projet/mcp-coordinator-new/src/ || echo "absents de 2.2.1 - confirme"
```

Attendu : `absents de 2.2.1 - confirme`. **Si l'un des deux apparaît, arrêter cette tâche** : la route a été restaurée et il n'y a rien à supprimer.

- [ ] **Step 2: Retirer l'appel /api/run-config**

Dans `src/orchestrator/orchestrator.ts`, supprimer le commentaire `// 1b. Push run config to dashboard` et l'appel `await postJson(...)` qui le suit, jusqu'au `});` fermant inclus. Le remplacer par :

```ts
  // L'en-tete de run partait vers /api/run-config, route supprimee dans le
  // coordinator 2.x. postJson avalait deja l'echec ; on ne garde pas un appel
  // dont on sait qu'il ne peut plus aboutir.
```

- [ ] **Step 3: Retirer l'appel /api/token-usage**

Dans `src/agent-loop/agent-loop.ts`, supprimer la fonction `postTokenUsageSse` en entier, puis localiser et retirer chacun de ses appels :

```bash
grep -n "postTokenUsageSse" src/agent-loop/agent-loop.ts
```

Supprimer toutes les lignes que cette commande renvoie. Le compteur de tokens local (`formatTokens`, le rapport par run dans `reports/`) est indépendant et reste en place.

- [ ] **Step 4: Vérifier qu'il ne reste aucune référence**

```bash
grep -rn "run-config\|token-usage\|postTokenUsageSse" src/ cli/ scripts/ || echo "aucune reference - propre"
npm run build
```

Attendu : `aucune reference - propre`, puis un build `tsc` sans erreur.

- [ ] **Step 5: Lancer la suite**

```bash
npm test
```

Attendu : aucun nouvel échec. Si un test référence l'un des deux endpoints, le supprimer dans le même commit — il teste une route qui n'existe plus.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/orchestrator.ts src/agent-loop/agent-loop.ts
git commit -m "fix(coordinator): retire les appels aux deux routes supprimees en 2.x"
```

---

## Task 5: Vérifier les corps REST contre les schémas zod

Depuis la v1.0.0 du coordinator, les corps REST sont validés par zod et rendent un 400 structuré. La spec marque ce point **NON VÉRIFIÉ** : cette tâche le tranche.

**Files:**
- Read only: `/c/Users/gagno/projet/mcp-coordinator-new/src/http/rest-handlers.ts` et les schémas qu'il importe
- Modify: le ou les fichiers essaim dont un corps dévie — inconnu avant l'étape 3

**Interfaces:**
- Consumes: rien.
- Produces: soit rien (si tout concorde), soit des corrections de corps de requête. Aucune nouvelle signature.

- [ ] **Step 1: Extraire les schémas des routes qu'essaim appelle**

```bash
grep -rn "BodySchema\|z.object" /c/Users/gagno/projet/mcp-coordinator-new/src/http/rest-handlers.ts | head -40
```

- [ ] **Step 2: Lister les corps qu'envoie essaim**

```bash
grep -rn "JSON.stringify({" -A 12 src/agent-loop/agent-loop.ts src/agent-loop/work-stealing.ts src/orchestrator/orchestrator.ts | head -60
```

- [ ] **Step 3: Comparer champ par champ**

Pour chacune des routes qu'essaim appelle — `/api/announce`, `/api/register`, `/api/claim-task`, `/api/unclaim-task`, `/api/post-to-thread`, `/api/propose-resolution`, `/api/approve-resolution`, `/api/threads-active`, `/api/session-start`, `/api/session-stop`, `/api/log-file`, `/api/hot-files`, `/api/quota`, `/api/check-interrupt`, `/api/reset` — vérifier que tout champ marqué requis par le schéma est bien émis, et qu'aucun champ émis n'est rejeté par un `.strict()`.

Consigner le résultat dans le message de commit, y compris s'il est « aucun écart ».

- [ ] **Step 4: Corriger les écarts trouvés**

Aucun code n'est donné ici : il dépend entièrement de ce que l'étape 3 révèle. S'il n'y a aucun écart, passer à l'étape 5 sans modification — c'est un résultat valide, pas un échec de tâche.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(coordinator): aligne les corps REST sur les schemas zod de 2.x"
```

Si aucun écart n'a été trouvé, ne rien committer et le noter dans le rapport de tâche.

---

## Task 6: Vérification de bout en bout contre un coordinator 2.2.1

**Files:**
- Aucun fichier modifié. Tâche de vérification.

**Interfaces:**
- Consumes: tout ce qui précède.
- Produces: le verdict local sur l'issue #33.

- [ ] **Step 1: Lancer un coordinator 2.2.1 en local**

```bash
npx mcp-coordinator serve --port 3100
```

Laisser tourner dans un terminal séparé.

- [ ] **Step 2: Vérifier que /mqtt répond bien à l'upgrade WebSocket**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:3100/mqtt
```

Attendu : `101`. Un `404` signifie qu'un coordinator 0.13.0 tourne encore — revérifier la tâche 1.

- [ ] **Step 3: Lancer un swarm réel et observer les abonnements**

```bash
LOG_LEVEL=debug npm run dev -- run raid -p . --agents 2 --timeout 5 2>&1 | grep -i "connected\|refused\|mqtt error"
```

Attendu : une ligne `connected` portant `org` et `subscribed: 7`. **Aucune** ligne `subscriptions refused`. Si `subscribed` est inférieur à 7, le préfixe d'org ne correspond pas à celui du serveur — comparer avec le claim `org` réellement porté par le token et relire la tâche 2.

- [ ] **Step 4: Confirmer qu'un événement poussé arrive**

```bash
LOG_LEVEL=debug npm run dev -- run raid -p . --agents 2 --timeout 5 2>&1 | grep -i "interrupt\|consultation_"
```

Attendu : au moins un `consultation_new` ou `consultation_message`. C'est la preuve que la chaîne push fonctionne de bout en bout — le point que l'issue #33 mettait en défaut.

- [ ] **Step 5: Consigner le verdict sur #33**

Si les étapes 2 à 4 passent, l'écrire dans l'issue #33 en précisant que la vérification est **locale**. Fermer l'issue demande en plus une vérification contre le coordinator déployé, qui exige un token valide et l'accord de l'opérateur — hors périmètre de ce plan.

- [ ] **Step 6: Pas de commit**

Aucun fichier modifié. Reporter le résultat dans le rapport de tâche.

---

## Task 7: Mettre la documentation en accord avec le code

**Files:**
- Modify: `CLAUDE.md` (section « Three-repo split »)
- Modify: `README.md` (prérequis Node)

**Interfaces:**
- Consumes: les faits établis par les tâches 1 à 6.
- Produces: rien de programmatique.

- [ ] **Step 1: Relever ce que la doc affirme**

```bash
grep -n "Node\|node" README.md | head -10
grep -n "mcp-coordinator" CLAUDE.md README.md | head -10
```

- [ ] **Step 2: Corriger le prérequis Node dans README.md**

Remplacer toute mention d'un plancher Node 20 par Node 22, en cohérence avec `package.json`.

- [ ] **Step 3: Documenter la forme scopée des topics dans CLAUDE.md**

Dans la section « Three-repo split », après la phrase sur les semantics appartenant à mcp-coordinator, ajouter :

```markdown
Les topics MQTT sont scopés par organisation depuis le coordinator 2.x :
`coordinator/<org>/consultations/...`. L'org vient du claim `org` du
`COORDINATOR_TOKEN`, et le broker refuse silencieusement tout abonnement hors de
ce préfixe — joker compris. Voir `orgFromToken` dans `src/agent-loop/mqtt-listener.ts`.
```

- [ ] **Step 4: Vérifier que le garde-fou CI reste vert**

```bash
git add -A
git grep -In -i 'mekova' -- . ':!.github/workflows/test.yml' && echo "ECHEC - terme reintroduit" || echo "OK"
```

Attendu : `OK`.

- [ ] **Step 5: Lancer la suite complète et le build une dernière fois**

```bash
npm test && npm run build
```

Attendu : tout au vert.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: plancher Node 22 et topics MQTT scopes par organisation"
```

---

## Ordre et dépendances

```
Task 1 (deps + Node)
   |
   +--> Task 2 (topics scopes) --> Task 3 (diagnostic) --+
   |                                                      |
   +--> Task 4 (endpoints supprimes) --------------------+--> Task 6 (bout en bout) --> Task 7 (docs)
   |                                                      |
   +--> Task 5 (corps REST) -----------------------------+
```

Les tâches 2, 4 et 5 sont indépendantes entre elles et peuvent se mener en parallèle après la tâche 1. La tâche 3 s'appuie sur la 2. La tâche 6 exige que 2, 3, 4 et 5 soient faites.

---

## Ce que ce plan ne fait PAS

Trois points figurent dans les constats sans tâche associée, faute d'être vérifiés — les traiter demanderait une décision ou un accès que ce plan n'a pas :

1. **Fermer l'issue #33 pour de bon.** La tâche 6 la vérifie en local. Le verdict sur le coordinator *déployé* exige de re-sonder la prod : token valide et accord de l'opérateur.
2. **Adopter l'acquittement de lot drainé (#430).** Il faut d'abord établir comment l'acquittement s'exprime dans l'appel d'outil MCP, et si cela impose de toucher le catalogue BCE.
3. **Retirer `check-interrupt` des 24 presets qui le portent encore.** Ce behavior est marqué déprécié, mais il porte aujourd'hui la coordination quand le push est en panne. Ne rien y toucher tant que la tâche 6 n'est pas verte.
4. **Faire ré-émettre les tokens.** La v1.0.0 du coordinator exige un claim `typ` (`"access"` / `"refresh"`) et rejette tout JWT émis avant. Aucun code essaim n'est en cause : c'est une action d'ops sur le déploiement, et tout porteur d'un ancien `COORDINATOR_TOKEN` devra se ré-authentifier. La tâche 6 n'y est pas exposée — un coordinator lancé en local part d'une base neuve et mint un token conforme.
