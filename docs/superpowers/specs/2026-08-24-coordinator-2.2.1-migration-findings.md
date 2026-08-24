# essaim ↔ mcp-coordinator 2.2.1 — Constats de migration

**Date:** 2026-08-24
**Portée:** ce qu'il faut changer dans essaim pour fonctionner contre `mcp-coordinator@2.2.1`.
**Méthode:** chaque affirmation ci-dessous a été lue dans le code, des deux côtés. Rien n'est déduit d'un
message de commit seul. Les points non vérifiés sont marqués **NON VÉRIFIÉ** et n'ont pas de tâche associée.

Sources : `C:\Users\gagno\projet\essaim-new` (essaim, HEAD `57c37d4`) et
`C:\Users\gagno\projet\mcp-coordinator-new` (coordinator `main`, v2.2.1, HEAD `42ac8d0`).

---

## 0. Le point de départ

| | |
|---|---|
| essaim épingle | `"mcp-coordinator": "^0.13.0"` (`package.json`) |
| essaim a installé | `0.13.0` (`node_modules/mcp-coordinator/package.json`) |
| Source du coordinator | `2.2.1` |

Le caret sur une version `0.x` ne remonte pas au-delà de `0.x` : `^0.13.0` ne résoudra jamais `1.x` ni `2.x`.
La dépendance est donc figée deux majeures en arrière et `npm update` ne la bougera pas.

---

## 1. RUPTURE — Les topics MQTT sont scopés par organisation

**C'est la rupture qui compte.** Sans elle corrigée, essaim se connecte, s'abonne à rien, et ne reçoit
plus aucune notification push — sans erreur visible.

### Ce que publie le coordinator 2.2.1

`src/mqtt-bridge.ts:298` et `:321` publient sur `coordinator/${orgId}/consultations/new`. Le segment `orgId`
est présent sur **toutes** les formes :

```
coordinator/${orgId}/consultations/new
coordinator/${orgId}/consultations/${threadId}/messages
coordinator/${orgId}/consultations/${threadId}/status
coordinator/${orgId}/consultations/${threadId}/claimed
coordinator/${orgId}/consultations/${threadId}/completed
coordinator/${orgId}/broadcast
coordinator/${orgId}/agents/${agentId}/status
```

Il n'existe **aucune publication non scopée** en 2.2.1. La seule occurrence de la chaîne
`coordinator/consultations/new` dans `src/` est un **commentaire** (`src/server-setup.ts:171`) ; l'appel réel
juste en dessous passe `event.org_id` et publie la forme scopée. Les autres occurrences sont dans
`docs/index.html` et ses sauvegardes.

### Ce à quoi essaim s'abonne

`src/agent-loop/mqtt-listener.ts:108-116`, constante `TOPICS` — les sept formes **sans** segment org :

```
coordinator/consultations/new
coordinator/consultations/+/messages
coordinator/consultations/+/status
coordinator/consultations/+/claimed
coordinator/consultations/+/completed
coordinator/broadcast
coordinator/agents/+/status
```

### Pourquoi un joker ne sauve pas la mise

`src/mqtt-broker.ts:205-218`, `createAedesAuthorizeSubscribeHook` :

```js
const org = c.org;
if (!org) return cb(new Error("MQTT client missing org"), null);
const prefix = `coordinator/${org}/`;
if (!sub.topic.startsWith(prefix)) {
  logger.warn({ client_id: c.id, org, topic: sub.topic }, "MQTT subscribe denied (cross-org)");
  return cb(null, null);
}
```

Le test est un `startsWith` sur `coordinator/<org>/`. Un abonnement `coordinator/+/consultations/new` ne
commence pas par ce préfixe : **refusé**. Les sept topics actuels d'essaim : **refusés**.

Le refus est `cb(null, null)` — l'abonnement est rejeté, pas la connexion. Côté serveur il y a un `warn` ;
côté client, un code d'échec dans le SUBACK. essaim se connecte normalement et n'entend plus rien.

### D'où vient l'org

`src/mqtt-broker.ts:170` attache l'org au client Aedes depuis le résultat de `authenticate()`, qui vérifie
le token transmis dans le champ `password` du CONNECT — exactement ce qu'envoie essaim
(`src/agent-loop/mqtt-listener.ts:344`).

Côté claims, `src/auth.ts:126`, `:161`, `:227` lisent tous :

```js
typeof payload.org === "string" ? payload.org : "default"
```

**L'org est donc déjà dans le `COORDINATOR_TOKEN` d'essaim.** essaim ne le lit simplement jamais : `grep`
sur `org_id|orgId|org` dans `src/agent-loop/mqtt-listener.ts` et `src/coordinator-auth.ts` ne renvoie
**rien**.

### Effet de bord : les index de parsing se décalent

`classifyTopic` (`mqtt-listener.ts:118-141`) et `buildInterrupt` (`:144-178`) indexent en dur sur la forme
non scopée — `parts[1]` pour le genre, `parts[2]` pour l'identifiant, `parts[3]` pour la feuille. Avec le
segment org, tout se décale de un. Les deux fonctions doivent suivre, sinon les messages qui arrivent sont
mal classés.

---

## 2. RUPTURE — Deux endpoints ont disparu

Vérifié dans les deux sens :

| Endpoint | 0.13.0 (installé) | 2.2.1 (source) |
|---|---|---|
| `/api/run-config` | présent (`node_modules/mcp-coordinator/dist/src/http/handle-rest.js`) | **absent** — zéro occurrence dans `src/` |
| `/api/token-usage` | présent (idem) | **absent** — zéro occurrence dans `src/` |

Ce sont de vraies suppressions, pas des endpoints qui n'auraient jamais existé.

Appelés par essaim :

- `/api/run-config` — `src/orchestrator/orchestrator.ts:232`, pousse l'en-tête de run vers le dashboard.
- `/api/token-usage` — `src/agent-loop/agent-loop.ts:457`, pousse la télémétrie par tour.

**Les deux dégradent en silence.** `postJson` (`orchestrator.ts:49-63`) attrape tout, journalise un `warn`
et rend `false` ; `postTokenUsageSse` (`agent-loop.ts:456`) est enveloppé dans un `try/catch`. Un run
continue. On perd l'en-tête de run et la télémétrie de tokens, rien d'autre.

Les routes REST réellement servies en 2.2.1 (`src/http/handle-rest.ts`) :

```
/api/announce /api/approve-resolution /api/check-conflict /api/check-interrupt /api/claim-task
/api/hot-files /api/introspection-response /api/log-file /api/pending-introspections
/api/post-to-thread /api/propose-resolution /api/quota /api/register /api/reset
/api/scoring-stats /api/session-start /api/session-stop /api/status /api/threads-active
/api/unclaim-task
```

Plus `POST /api/working-files/start` et `POST /api/working-files/stop` (`handle-rest.ts:106-107`), qui
gatent aussi sur la méthode — ce sont **les chemins exacts** qu'appellent `scripts/pre_track_activity.sh:83`
et `scripts/track_activity.sh:146`. Rien à changer là.

---

## 3. RUPTURE — Plancher Node

| | |
|---|---|
| coordinator 2.2.1 | `engines: {"node": ">=22"}` |
| essaim | `engines: {"node": ">=20"}` |

Motif déclaré dans le CHANGELOG du coordinator (v2.0.0) : `better-sqlite3@13` exige Node ≥ 22, et Node 20
est en fin de vie depuis le 2026-04-30.

La CI d'essaim tourne déjà en Node 24 (`.github/workflows/test.yml`) — seule la déclaration est périmée,
mais elle laisse un utilisateur en Node 20 installer un ensemble qui ne peut pas fonctionner.

---

## 4. Ruptures d'ops, sans changement de code essaim

Depuis le CHANGELOG du coordinator, sections `⚠ BREAKING CHANGES` :

- **v1.0.0** — les JWT exigent désormais un claim `typ` (`"access"` / `"refresh"`). Les tokens émis avant
  cette version sont rejetés : tout le monde se ré-authentifie après montée.
- **v1.0.0** — les corps REST sont validés par zod, avec un 400 structuré en retour. Un champ qui dévie ne
  passe plus en silence.

**NON VÉRIFIÉ :** je n'ai pas comparé les schémas zod de 2.2.1 aux corps que construit essaim
(`/api/announce`, `/api/register`, `/api/claim-task`…). C'est l'objet d'une tâche de vérification, pas d'une
affirmation.

---

## 5. Ce qui ne casse PAS — vérifié

Trois inquiétudes levées, chacune dans le code :

- **Le contrôle d'origine sur l'upgrade WS** (commit `a7583c8`, #436) ne verrouille pas essaim.
  `src/mqtt-broker.ts:393` utilise `isAllowedOrigin`, et le message de commit énonce la raison du choix :
  le helper renvoie **vrai pour un header `Origin` absent**, parce que c'est le modèle same-origin du
  navigateur qu'il défend. Il cite « mqtt.js in Node » comme client concerné — c'est celui d'essaim.

- **Les scopes de service token** (#426) sont **fail-open** pour tout ce qui n'est pas un service token.
  `src/tools/tool-scopes.ts:31-36` : « Phase 1 agent tokens, Phase 2 cookie sessions and stdio's synthetic
  claims carry none, and must keep working exactly as before […] `undefined` therefore means unrestricted ».
  Les tokens d'essaim sont des tokens agent Phase 1. Aucun changement requis.

- **`#424` ne concerne pas `/api/claim-task`.** Le commit porte sur les claims de session MCP
  (`getSessionClaims`) et sur le message d'erreur qui distingue « aucun id de session » de « id inconnu de
  ce process ». Aucun rapport avec le work-stealing REST d'essaim. *(J'avais avancé le contraire avant
  vérification ; c'était faux.)*

---

## 6. L'issue #33 devrait tomber avec la montée

`src/mqtt-broker.ts:381-395` porte un vrai handler d'upgrade `/mqtt` en 2.2.1.

Le sondage du coordinator déployé (2026-07-20, consigné en mémoire projet) avait établi que la v0.13.0
**404** cet upgrade même avec un Bearer valide — c'est la cause racine de l'issue #33 d'essaim, dont le
texte décrit une boucle `disconnected` pendant tout un run derrière un ingress.

Le volet backoff de #33 est déjà livré côté essaim (`mqtt-listener.ts:185-186` :
`RECONNECT_PERIOD_MS = 5_000`, `MAX_RECONNECT_ATTEMPTS = 5`, puis `giveUp`).

**NON VÉRIFIÉ :** l'état actuel du coordinator *déployé*. La note de mémoire a un mois. Fermer #33 demande
de re-sonder la prod, ce qui exige un token valide et l'accord de l'opérateur.

---

## 7. Le trou de diagnostic qui a laissé #33 survivre

`mqtt-listener.ts:393-396` :

```js
client.on("close", () => {
  isConnected = false;
  log.debug("disconnected");
});
```

Message nu, au niveau `debug`, donc invisible au niveau de log par défaut. Il n'existe **aucun**
`client.on("error")` dans le fichier — les erreurs d'upgrade sont avalées.

Avec la rupture §1, ce trou devient franchement dangereux : un abonnement refusé pour cause d'org est
silencieux des deux côtés du point de vue d'essaim. Le même run se terminerait « normalement », sans
coordination, sans un mot.

---

## 8. Piste, non chiffrée

`#430` rend acquittable un lot drainé (`getQueuedMessages`), en opt-in, l'ancien contrat restant valide.
essaim expose `wait_for_message` et `get_queued_messages` aux agents
(`src/orchestrator/agent-launcher.ts:33-34`, `:120-121`), mais ce sont les agents qui les appellent via le
LLM — pas du code essaim.

**NON VÉRIFIÉ :** comment l'acquittement s'exprime dans l'appel d'outil, et donc s'il faut toucher au
catalogue BCE. À instruire avant toute tâche.
