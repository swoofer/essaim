# Observabilité et non-duplication du travail — plan d'implémentation

> **Pour les agents d'exécution :** SOUS-COMPÉTENCE REQUISE — utilisez `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans` pour dérouler ce plan tâche par tâche. Les étapes utilisent la syntaxe à cases (`- [ ]`) pour le suivi.

**Goal :** Faire arriver aux agents l'information qu'on croit déjà leur donner, rendre le coût d'un run ventilable par phase, et fermer le dernier moyen qu'a un agent headless de se suspendre.

**Architecture :** Cinq correctifs indépendants, tous côté TypeScript, aucun changement de YAML ni de dépôt tiers. Quatre visent des angles morts d'observation ou d'information ; un seul (Tâche 3) touche à la coordination. Ils sont ordonnés par rapport gain/coût : la Tâche 1 attaque le poste le plus lourd et se mesure sur un seul run, la Tâche 2 fournit l'instrument qui rendra les suivantes mesurables.

**Tech Stack :** TypeScript ESM strict, Node ≥ 22, pnpm 10, vitest 4 (`fileParallelism: false`), tsc pour le build. Aucun lint, aucun formateur — n'en inventez pas.

**Spec :** Ce plan est issu de deux analyses multi-agents adversariales menées le 2026-08-26 sur ce dépôt et sur les 8 rapports de run de `reports/`. Les constats chiffrés sont cités dans le contexte de chaque tâche. Il n'y a pas de document de spec séparé : les mesures et le code cité SONT la spec.

## Contexte : pourquoi ces cinq-là

Une comparaison avec un orchestrateur concurrent a d'abord suggéré qu'essaim gaspillait des tokens de cache. Les mesures l'ont réfuté : **essaim tourne déjà à 91,6 % de taux de cache** (25 773 049 tokens lus contre 2 352 294 écrits sur 62 envois, 10 agents, 4 runs). Tout l'enjeu du préfixe invariant que joue le concurrent tient dans 8,4 % de l'entrée, et il le paie en sérialisant ses démarrages.

Le vrai gisement est ailleurs : **8 847 827 tokens d'entrée (31,5 %) ont payé des correctifs strictement identiques**. Dans `reports/report-1787693175739.json`, les trois sentinelles écrivent le même patch sur le même fichier. Cause vérifiée : les agents ne savent pas quelle tâche ils ont réclamée (Tâche 1).

## Contraintes globales

Ces exigences s'appliquent implicitement à **toutes** les tâches. Une tâche qui en viole une doit être arrêtée, pas contournée.

- **Le lancement des agents reste parallèle.** Le limiteur de concurrence de `src/orchestrator/orchestrator.ts:80-99` ne doit acquérir aucun verrou supplémentaire. Toute solution qui sérialise les démarrages est refusée, quel qu'en soit le gain.
- **L'isolation par worktree git reste entière** (`src/orchestrator/workspace.ts:44-46`).
- **Le modèle et l'effort restent choisis par phase** (`src/agent-loop/effort.ts`) : `discover` en mid, `review` en low avec un autre modèle, `execute` en mid/high.
- **Les prompts restent assemblés par promptweave**, jamais écrits en littéraux. Aucun fichier de `behaviors/`, `presets/`, `compositions/` ou `templates/` n'est modifié par ce plan.
- **Les deux garde-fous restent armés** : quota (`src/orchestrator/preflight.ts`, `src/agent-loop/agent-loop.ts`) et falsifiabilité (`src/agent-loop/falsifiability.ts`).
- **Garde-fou CI** : le job `no-domain-artifacts` de `.github/workflows/test.yml` fait échouer toute PR réintroduisant du contenu de catalogue spécifique à un client. Le terme interdit n'est épelé que dans ce fichier de workflow — ne le recopiez nulle part ailleurs, y compris dans un message de commit.
- **Commandes** : `pnpm test` (suite complète), `npx vitest run tests/unit/X.test.ts` (un fichier), `npx vitest run -t "nom"` (un cas), `pnpm build` (tsc). La CI exécute exactement `pnpm install && pnpm test && pnpm build` sur Node 24.
- **Un commit par tâche**, message en conventional commits, terminé par la ligne `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Ordre d'exécution et pourquoi

| # | Tâche | Coût | Gain |
|---|-------|------|------|
| 1 | Injecter les params runtime | petit | Jusqu'à 31,5 % de l'entrée — plafond, pas garantie |
| 2 | Persister `turnDetails` + `exitReason` | petit | Zéro token, mais seul moyen de ventiler par phase |
| 3 | Rétrécir la fenêtre de claim | moyen | Non chiffrable séparément — **à faire seulement si 1 ne suffit pas** |
| 4 | Bloquer `AskUserQuestion` | petit | Supprime un mode de panne, pas une économie |
| 5 | Capter `compact_boundary` | moyen | Tranche une décision d'effort prise à l'aveugle |

**L'ordre 1 → 2 → 3 compte.** La Tâche 1 explique à elle seule les diffs identiques observés. Si vous faites la 3 en même temps, vous ne saurez jamais laquelle des deux a payé. Faites la 1, relancez un run, mesurez ; n'attaquez la 3 que s'il reste des correctifs redondants.

Les tâches 4 et 5 sont indépendantes des trois premières et peuvent être menées dans n'importe quel ordre.

## Protocole de mesure

Aucun outil nouveau. `reports/` contient déjà, par agent : `input`, `output`, `cache read`, `cache write`, taux de cache, et le champ `diff`.

**Référence actuelle, à battre :**

| run | agents | cache read | cache write | taux |
|---|---|---|---|---|
| `report-1787624502539` | 2 | 2,3 M | 364 k | 86 % |
| `report-1787627306971` | 3 | 8,8 M | 1,03 M | 88-90 % |
| `report-1787693175739` | 3 | 10,0 M | 607 k | 94 % |
| `report-1787758307294` | 2 | 4,6 M | 357 k | 93 % |

Après la Tâche 1, relancer `sentinelle` sur le même seed et vérifier **trois** choses :

1. **Plus aucune paire de `diff` identiques entre agents** — visible à l'œil dans le JSON.
2. **La somme (input + cacheRead + cacheCreation) divisée par le nombre de correctifs DISTINCTS livrés doit chuter.** Référence : 10 595 812 tokens pour 1 seul correctif distinct sur `report-1787693175739`.
3. **Le taux de cache par agent ne doit PAS descendre** sous sa bande de référence (raid 86-90 %, sentinelle 91-95 %). S'il baisse, le correctif a abîmé le préfixe — arrêtez et regardez de plus près.

## Ce qu'il ne faut pas faire

Ces pistes ont été explorées et écartées avec preuve. Ne les ressuscitez pas.

- **Le préfixe caché invariant protégé par un verrou par modèle.** Sérialise les démarrages (contrainte globale n°1) pour un poste 3,7× plus petit que celui de la Tâche 1.
- **Réordonner les sections YAML pour « mettre le statique devant ».** Mécanisme inexistant : le prompt part en UN seul argument `-p`, aplati sur une ligne par `promptWithThinking.replace(/\n+/g, " \\n ")` (`src/agent-loop/claude-stream.ts:163-165`). C'est un bloc indivisible ; déplacer des octets à l'intérieur rapporte exactement zéro.
- **Unifier les modèles entre phases.** Casse la contrainte globale n°3. Et l'écart invoqué pour le justifier (raid 86-90 % contre sentinelle 91-95 %) confond deux templates, deux missions et deux plafonds de tours.
- **Toucher à `freshSessionPerTask` avant la Tâche 2.** Le drapeau est codé en dur depuis les commits d'import (`src/orchestrator/agent-launcher.ts:176`) : aucun run avec `false` n'existe, il n'y a pas de contrefactuelle. Tout son coût possible tient de toute façon dans les 8,4 % de cache write.
- **Chasser `--allowedTools`.** Il est inerte sous `--dangerously-skip-permissions`, et le dépôt le dit lui-même (`src/agent-loop/claude-stream.ts:176-178`). Le nettoyer est une question de clarté, pas de tokens.
- **Partager un répertoire entre agents** pour aligner le `cwd`. Casse la contrainte globale n°2, pour un gain invérifiable depuis ce dépôt.
- **Monter `maxTurns` sur la foi de `error_max_turns` tant que la Tâche 5 n'est pas faite.** Compaction et plafond produisent le même octet en sortie et leurs remèdes sont de signe opposé.
- **Convertir les tokens en dollars.** `total_cost_usd` vaut 0 partout sous abonnement OAuth (`src/orchestrator/reporter.ts:147`). Toute somme en dollars serait une estimation habillée en mesure.

---

### Tâche 1 : Injecter réellement current_task / my_discoveries / existing_threads dans les prompts de phase

**Objectif :** Faire arriver la description de la tâche réclamée et les deux listes de la phase review dans le prompt réellement envoyé au LLM, alors que promptweave a aplati leurs marqueurs à l'assemblage.

**Fichiers :**
- Modifier : `src/agent-loop/agent-loop.ts` (327-329 (insertion du helper), 905-908 (phase review), 1060 (phase execute)) — boucle d'un agent ; contient les trois .replace() qui ne trouvent jamais rien
- Test : `tests/unit/agent-loop.test.ts` (insertion avant la ligne 1611 ; la ligne 776 existante doit rester verte) — tests de la boucle ; mocke claude-stream via vi.mock, mockSend capture chaque prompt envoyé

**Interfaces :**
- Consomme : `phase.prompt: string` et `phase.name: string` (AgentLoopConfig.phases, src/agent-loop/agent-loop.ts:56-68) ; `task.description: string` (Task, src/agent-loop/work-stealing.ts:8) ; `fetchExistingThreads(url: string): Promise<string>` et `parseReviewActions(output: string)` (mêmes fichier) ; `discoveryContent: string`, variable locale de runAgentLoop alimentée par la réponse de la phase discover.
- Produit : `function injectRuntimeParam(prompt: string, param: string, heading: string, value: string): string` — module-privé dans src/agent-loop/agent-loop.ts (NON exporté). Substitue `{{params.<param>}}` s'il est présent dans `prompt`, sinon concatène `\n\n## <heading>\n<value>` ; renvoie `prompt` inchangé si `value` est vide. Tout futur param rempli à l'exécution doit passer par lui.

**Contexte nécessaire :**

essaim lance N agents Claude Code sur des worktrees git. Un agent ne rédige pas son prompt : il est ASSEMBLÉ par promptweave (moteur maison) à partir de YAML — `behaviors/*.yaml` déclarent des `params` et des `sections`, un `preset` liste les behaviors, un `template` fait le swarm. Le prompt final est du Handlebars rendu UNE fois, au build, avant le lancement de l'agent.

Trois params sont censés être remplis non pas au build mais à l'exécution, par la boucle d'agent (`src/agent-loop/agent-loop.ts`) : `current_task` (la tâche que l'agent vient de réclamer au coordinateur), `my_discoveries` et `existing_threads` (les deux listes que la phase review doit comparer pour dédupliquer). La boucle fait ça avec un `.replace()` sur le marqueur `{{params.current_task}}` dans `phase.prompt`.

Le bug : ces params sont déclarés `default: ""` dans le YAML. À l'assemblage ils valent donc `""`, et Handlebars fait disparaître le marqueur AVANT que la boucle ne le voie. Deux disparitions différentes selon le behavior :
- `behaviors/phase-execute.yaml` (et `behaviors/security-fix.yaml`) entourent le marqueur d'un `{{#if params.current_task}} … {{/if}}` : avec `""` le bloc entier est SUPPRIMÉ, le marqueur n'existe plus.
- `behaviors/phase-review.yaml` interpole `{{params.my_discoveries}}` nu : avec `""` le marqueur est REMPLACÉ par une chaîne vide, il n'existe plus non plus.

Dans les deux cas le `.replace()` de l'agent-loop ne trouve rien à remplacer et la donnée est jetée en silence. Conséquence mesurée : l'agent de la phase execute n'apprend jamais quel fichier corriger (le preset lui dit « corrige la vulnérabilité du fichier de ta tâche » sans jamais nommer le fichier), et la phase review, dont le seul métier est de trier NEW/DUPLICATE/ENRICHES, compare deux listes vides — trois agents ont écrit le même patch sur le même fichier.

Deux contraintes encadrent le correctif. (1) `tests/unit/agent-loop.test.ts` ligne 776 assert une ÉGALITÉ EXACTE sur un prompt de test qui, lui, contient encore le marqueur : `expect(executePrompt).toBe("Fix this: Null pointer in auth.ts:42");`. Un correctif qui concatènerait toujours la donnée en fin de prompt casserait ce test. Il faut donc garder la substitution quand le marqueur a survécu, et ne concaténer qu'à défaut. (2) `tests/unit/catalog-lint.test.ts` refuse tout param déclaré dans un YAML qu'aucune section n'interpole (`findUnusedParams`) : on ne peut donc PAS supprimer la déclaration ni le `{{params.…}}` du YAML. Le correctif est entièrement côté TypeScript, aucun YAML ne bouge.

**Pourquoi le test discrimine :** Les deux tests utilisent un `phase.prompt` SANS marqueur — exactement ce que promptweave produit après aplatissement — donc avant le patch le `.replace()` laisse le prompt intact et le `toContain` échoue, alors qu'après le patch le helper concatène la donnée en fin de prompt.

- [ ] **Étape 1 : Repérer le point d'insertion des deux tests**

Ouvre `C:/Users/gagno/projet/essaim-new/tests/unit/agent-loop.test.ts`. Le `describe("runAgentLoop — phased mode", …)` commence ligne 469 et se ferme ligne 1611 par `});`. Le dernier test du bloc finit ligne 1610 :

```
1607:    // full mode → pass the session-level list through (no filter)
1608:    const discoverOpts = mockSend.mock.calls[0][1];
1609:    expect(discoverOpts.allowedTools).toEqual(["Read", "Edit", "mcp__coordinator__list_threads"]);
1610:  });
1611: });
```

Les deux tests des étapes 2 et 7 s'insèrent ENTRE la ligne 1610 et la ligne 1611, donc à l'intérieur du describe (ils dépendent de son `beforeEach`, qui reset `mockSend`, `mockClaimNextTask`, `mockFetchExistingThreads`, etc.).

- [ ] **Étape 2 : Écrire le test rouge de la phase execute**

Colle ce bloc entre la ligne 1610 (`  });`) et la ligne 1611 (`});`) de `tests/unit/agent-loop.test.ts` :

```ts

  // promptweave aplatit `current_task` à l'assemblage : déclaré `default: ""`
  // dans behaviors/phase-execute.yaml, le bloc `{{#if params.current_task}}`
  // qui l'entoure est supprimé en entier et le marqueur n'existe plus dans le
  // prompt rendu. Le prompt ci-dessous est donc celui que l'agent reçoit
  // VRAIMENT. Mesuré : trois agents ont patché le même fichier faute de savoir
  // quelle tâche ils avaient réclamée.
  it("injecte la tâche réclamée quand le marqueur a disparu du prompt assemblé", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false },
        {
          name: "execute",
          // Prompt assemblé réel : plus aucun {{params.current_task}} dedans.
          prompt: "## Tâche assignée\n\nCorrige la vulnérabilité du fichier de ta tâche.",
          toolsMode: "full",
          loop: true,
        },
      ],
    });

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) {
        return { id: "t-1", description: "src/render.ts:42 — XSS dans renderName()", file: undefined, severity: undefined };
      }
      return null;
    });

    mockSend.mockResolvedValueOnce({
      content: "DONE: échappement ajouté",
      toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1",
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // call 0 = discover, call 1 = execute
    const executePrompt = mockSend.mock.calls[1][0] as string;
    expect(executePrompt).toContain("src/render.ts:42 — XSS dans renderName()");
  });
```

- [ ] **Étape 3 : Vérifier que le test est ROUGE**

Lance :

```
npx vitest run tests/unit/agent-loop.test.ts -t "quand le marqueur a disparu"
```

Attendu : 1 test, ÉCHEC, avec un message du type `expected '## Tâche assignée\n\nCorrige la vulnérabilité du fichier de ta tâche.' to contain 'src/render.ts:42 — XSS dans renderName()'`. Si le test PASSE, arrête-toi : le prompt de ta config contient encore un marqueur, corrige-le avant d'aller plus loin.

- [ ] **Étape 4 : Ajouter le helper d'injection dans agent-loop.ts**

Dans `C:/Users/gagno/projet/essaim-new/src/agent-loop/agent-loop.ts`, la ligne 327 ferme `formatCoordinationContext` et la ligne 329 est le commentaire `// ── Coordinator REST helpers ───────────────────────────────────────────`. Insère ce bloc dans la ligne vide 328, donc entre les deux :

```ts
// promptweave APLATIT les params runtime à l'assemblage. `current_task`,
// `my_discoveries` et `existing_threads` sont déclarés `default: ""` dans
// behaviors/phase-execute.yaml, behaviors/security-fix.yaml et
// behaviors/phase-review.yaml : au rendu du prompt ils valent "", donc le
// marqueur DISPARAÎT — le bloc `{{#if params.current_task}}` est supprimé en
// entier, `{{params.my_discoveries}}` est interpolé à vide. Les `.replace()`
// d'ici ne trouvaient alors plus rien : l'agent d'execute ne savait jamais
// quelle tâche il avait réclamée, et la phase review dédoublonnait sur deux
// listes vides.
//
// On garde la substitution quand le marqueur a survécu (un prompt qui le
// contient encore doit être substitué en place, pas se voir accoler un second
// bloc), et on ne concatène qu'à défaut.
function injectRuntimeParam(prompt: string, param: string, heading: string, value: string): string {
  if (!value) return prompt;
  const marker = `{{params.${param}}}`;
  // split/join et pas replace : `value` est du texte produit par un LLM, et
  // String.replace interprète `$&`, `$'` et `` $` `` dans le remplacement.
  if (prompt.includes(marker)) return prompt.split(marker).join(value);
  return `${prompt}\n\n## ${heading}\n${value}`;
}
```

- [ ] **Étape 5 : Brancher la phase execute sur le helper**

Toujours dans `src/agent-loop/agent-loop.ts`, la ligne 1060 est exactement :

```ts
              let taskPrompt = phase.prompt.replace(/\{\{params\.current_task\}\}/g, task.description);
```

Remplace-la par :

```ts
              let taskPrompt = injectRuntimeParam(phase.prompt, "current_task", "Détails de la tâche", task.description);
```

Garde `let` : les lignes 1061-1069 juste en dessous font `taskPrompt += …` pour le bloc « Déjà livré sur ce fichier ». L'indentation est de 14 espaces. Le titre « Détails de la tâche » reprend mot pour mot le libellé du bloc `{{#if}}` de behaviors/phase-execute.yaml.

- [ ] **Étape 6 : Vérifier le VERT et la non-régression du test d'égalité exacte**

Lance le fichier complet :

```
npx vitest run tests/unit/agent-loop.test.ts
```

Attendu : tout vert. Deux tests à surveiller nommément :
- le nouveau « injecte la tâche réclamée quand le marqueur a disparu du prompt assemblé » passe désormais ;
- l'ancien, ligne 776, qui fait `expect(executePrompt).toBe("Fix this: Null pointer in auth.ts:42");` sur un prompt `"Fix this: {{params.current_task}}"`, reste vert : le marqueur y est présent, donc le helper substitue en place et ne concatène rien.

- [ ] **Étape 7 : Commit du premier cycle**

```
git add src/agent-loop/agent-loop.ts tests/unit/agent-loop.test.ts
git commit -m "fix(agent-loop): la tâche réclamée n'atteignait jamais le prompt d'execute"
```

- [ ] **Étape 8 : Écrire le test rouge de la phase review**

Colle ce bloc juste après le test de l'étape 2, toujours avant le `});` qui ferme le describe `runAgentLoop — phased mode` :

```ts

  // Même aplatissement côté review : `{{params.my_discoveries}}` et
  // `{{params.existing_threads}}` sont déclarés `default: ""` dans
  // behaviors/phase-review.yaml et interpolés à VIDE à l'assemblage. Les deux
  // .replace() ne trouvaient rien : la phase censée dédoublonner NEW/DUPLICATE/
  // ENRICHES recevait deux listes vides.
  it("injecte discoveries et threads quand les marqueurs ont disparu du prompt de review", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Find bugs", toolsMode: "read_only", loop: false },
        // Prompt assemblé réel : les deux marqueurs ont été aplatis.
        { name: "review", prompt: "## DATA À ANALYSER\n\nDédoublonne et réponds par REVIEW:.", toolsMode: "none", loop: false },
        { name: "execute", prompt: "Corrige.", toolsMode: "full", loop: true },
      ],
    });

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/auth.ts | 42 | Missing null check | critical",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Missing null check", file: "src/auth.ts", line: 42, severity: "critical" },
    ]);
    mockFetchExistingThreads.mockResolvedValue("- [t-existing] Vieux bug dans auth.ts");

    mockSend.mockResolvedValueOnce({
      content: "REVIEW:\n(aucune action)",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "Missing null check" }]);

    // Pool vide : la phase execute ne déclenche aucun send supplémentaire.
    mockClaimNextTask.mockResolvedValue(null);

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // call 0 = discover, call 1 = review
    const reviewPrompt = mockSend.mock.calls[1][0] as string;
    expect(reviewPrompt).toContain("DISCOVERY:\nsrc/auth.ts | 42 | Missing null check | critical");
    expect(reviewPrompt).toContain("- [t-existing] Vieux bug dans auth.ts");
  });
```

- [ ] **Étape 9 : Vérifier que le test review est ROUGE**

```
npx vitest run tests/unit/agent-loop.test.ts -t "du prompt de review"
```

Attendu : ÉCHEC sur la première assertion, `expected '## DATA À ANALYSER\n\nDédoublonne et réponds par REVIEW:.' to contain 'DISCOVERY:…'`.

- [ ] **Étape 10 : Brancher la phase review sur le helper**

Dans `src/agent-loop/agent-loop.ts`, les lignes 905 à 908 sont exactement :

```ts
              // Inject both lists into the review prompt
              const reviewPrompt = phase.prompt
                .replace(/\{\{params\.my_discoveries\}\}/g, discoveryContent)
                .replace(/\{\{params\.existing_threads\}\}/g, existingThreads);
```

Remplace ces quatre lignes par :

```ts
              // Inject both lists into the review prompt — substitution quand le
              // marqueur a survécu à l'assemblage, concaténation sinon.
              let reviewPrompt = injectRuntimeParam(
                phase.prompt, "my_discoveries",
                "Tes trouvailles (de la phase discovery)", discoveryContent,
              );
              reviewPrompt = injectRuntimeParam(
                reviewPrompt, "existing_threads",
                "Threads déjà ouverts par d'autres agents", existingThreads,
              );
```

Indentation : 14 espaces. `const` devient `let` parce que la variable est réaffectée ; elle reste lue telle quelle plus bas (ligne 914 pour le log `${reviewPrompt.length}`, ligne 917 pour le `send(reviewPrompt, …)`). Les deux titres reprennent mot pour mot les sous-titres `### Tes trouvailles (de la phase discovery)` et `### Threads déjà ouverts par d'autres agents` de behaviors/phase-review.yaml.

- [ ] **Étape 11 : Vérifier le VERT complet, le catalogue et le build**

```
pnpm test
pnpm build
```

Attendu : toute la suite verte, y compris `tests/unit/catalog-lint.test.ts` (« aucun behavior ne déclare un param que rien ne peut lire ») — aucun YAML n'a été touché, les trois params restent déclarés ET interpolés, donc `findUnusedParams` renvoie toujours `[]`. `pnpm build` doit finir sans erreur TypeScript.

- [ ] **Étape 12 : Commit du second cycle**

```
git add src/agent-loop/agent-loop.ts tests/unit/agent-loop.test.ts
git commit -m "fix(agent-loop): la phase review dédoublonnait sur deux listes vides"
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**Étape 4 — le garde `if (!value) return prompt;` est placé AVANT la détection du marqueur, ce qui introduit une régression que le plan n'annonce pas. Le code actuel (lignes 907-908 et 1060) fait un `.replace()` inconditionnel : quand le marqueur est présent et la valeur vide, il blanchit le marqueur. Le helper proposé, lui, retourne le prompt tel quel — le littéral `{{params.my_discoveries}}` part alors au LLM. Cas réel : `discoveryContent` est initialisé à `""` (agent-loop.ts:850, remis à zéro à chaque cycle de re-discover) et n'est alimenté que par la phase `discover` (ligne 871) ; un preset qui déclare `review` sans `discover`, ou une réponse discover vide, laisse le marqueur en clair dans le prompt de review. Aucun test existant ne le rattrape (aucun n'assert sur `reviewPrompt`), donc la régression passe silencieusement. Second défaut dans le même bloc : le commentaire contient de l'échappement Markdown qui a fuité du plan vers le code — `String.replace interprète `$&`, `$'` et `` $` `` dans le remplacement.` Ça compile (c'est un `//`), mais ce n'est pas du texte prêt à coller. Correction : replier le test de vacuité sur la seule branche de concaténation, et réécrire le commentaire sans backticks échappés. Même longueur, comportement historique préservé quand le marqueur a survécu.**

// promptweave APLATIT les params runtime à l'assemblage. `current_task`,
// `my_discoveries` et `existing_threads` sont déclarés `default: ""` dans
// behaviors/phase-execute.yaml, behaviors/security-fix.yaml et
// behaviors/phase-review.yaml : au rendu du prompt ils valent "", donc le
// marqueur DISPARAÎT — le bloc `{{#if params.current_task}}` est supprimé en
// entier, `{{params.my_discoveries}}` est interpolé à vide. Les `.replace()`
// d'ici ne trouvaient alors plus rien : l'agent d'execute ne savait jamais
// quelle tâche il avait réclamée, et la phase review dédoublonnait sur deux
// listes vides.
//
// On garde la substitution quand le marqueur a survécu (un prompt qui le
// contient encore doit être substitué en place, pas se voir accoler un second
// bloc), et on ne concatène qu'à défaut. Le marqueur survivant est substitué
// MÊME par une valeur vide : c'est ce que faisait le .replace() d'origine, et
// laisser un {{params.…}} littéral partir au LLM serait pire que rien.
function injectRuntimeParam(prompt: string, param: string, heading: string, value: string): string {
  const marker = `{{params.${param}}}`;
  // split/join et pas replace : value est du texte produit par un LLM, et
  // String.replace interprète les motifs $&, $' et $backtick dans le remplacement.
  if (prompt.includes(marker)) return prompt.split(marker).join(value);
  return value ? `${prompt}\n\n## ${heading}\n${value}` : prompt;
}

**Étape 5 — la justification du titre est fausse sur deux points vérifiables. (a) behaviors/phase-execute.yaml ligne 49 contient exactement `Détails de la tâche:` (avec deux-points, et ce n'est pas un titre Markdown mais une ligne de texte nue), pas `Détails de la tâche` : « reprend mot pour mot le libellé » est inexact. (b) Surtout, behaviors/security-fix.yaml ligne 37 utilise un libellé DIFFÉRENT — `Détails du finding (issu du thread coordinateur) :` — alors que le plan affirme en risque #4 que ce behavior passe par la même ligne 1060 (c'est vrai : security-fix.yaml lignes 5-8 déclarent `phase: name: execute` / `loop: true`). Le titre unique « Détails de la tâche » sera donc concaténé aussi aux prompts de la sentinelle, où il ne correspond à rien dans le YAML. Ce n'est pas bloquant (le helper concatène en fin de prompt, hors de toute section), mais la phrase de justification doit être corrigée pour ne pas induire en erreur le développeur qui ira relire le YAML.**

Remplacer la dernière phrase de l'étape 5 par :

« Le titre « Détails de la tâche » reprend le libellé du bloc `{{#if}}` de behaviors/phase-execute.yaml ligne 49 (`Détails de la tâche:`, sans les deux-points). Attention : behaviors/security-fix.yaml, qui déclare la même phase `execute` (lignes 5-8) et passe donc par la même ligne 1060, utilise un libellé différent à sa ligne 37 — `Détails du finding (issu du thread coordinateur) :`. Le bloc concaténé porte le même titre pour les deux behaviors ; c'est acceptable parce qu'il est ajouté en fin de prompt, hors de toute section YAML, et qu'aucun parseur ne lit ce titre. »

**Risques :**
- Le test ligne 776 de tests/unit/agent-loop.test.ts assert une ÉGALITÉ EXACTE (`toBe("Fix this: Null pointer in auth.ts:42")`) sur un prompt qui contient encore `{{params.current_task}}`. Un helper qui concatènerait toujours au lieu de substituer quand le marqueur existe le casse. Signal : ce seul test échoue avec un `expected … to be …` où la chaîne reçue a un `\n\n## Détails de la tâche` en trop.
- `fetchExistingThreads` renvoie la chaîne littérale `"(aucun thread actif)"` quand le coordinateur n'a rien : elle est non vide, donc le helper l'injecte. C'est voulu (la phase review doit savoir qu'il n'y a rien à comparer), mais ça allonge chaque prompt de review de deux lignes. Signal : le log `Review: sending prompt to LLM (N chars)` en `LOG_LEVEL=debug` monte d'une cinquantaine de caractères.
- Le passage de `const reviewPrompt` à `let reviewPrompt` (ligne 906) ne doit pas casser les deux lectures qui suivent, lignes 914 et 917. Signal : `pnpm build` refuse à la compilation si l'une a été renommée par erreur.
- `behaviors/security-fix.yaml` déclare le même `current_task` avec la même phase `name: execute` : il passe par la ligne 1060, donc le correctif couvre raid ET sentinelle d'un coup. Si un futur behavior déclarait une phase d'un autre nom avec un param runtime, il ne serait pas couvert — il faudrait rappeler `injectRuntimeParam` à son propre site.
- Le helper concatène en FIN de prompt, donc la donnée n'est plus au milieu de la section 030 comme le voulait le YAML. Pour un prompt long, la tâche arrive après les consignes plutôt qu'avant. Signal : un agent qui répondrait aux consignes générales en ignorant le bloc final — à surveiller sur le premier vrai run, le remède serait de faire porter le marqueur à promptweave plutôt que de l'aplatir.


---

### Tâche 2 : Persister turnDetails et exitReason dans le rapport de run

**Objectif :** Faire survivre les métriques par-envoi (`turnDetails`) et la cause de sortie (`exitReason`) de l'agent-loop jusqu'au JSON du rapport, en ajoutant deux champs optionnels à `AgentResult` et deux lignes de recopie dans l'orchestrateur.

**Fichiers :**
- Modifier : `src/orchestrator/types.ts` (1-3 (imports) et 121-123 (fin de l'interface AgentResult)) — Ajoute les deux champs optionnels `turn_details` et `exit_reason` à `AgentResult`. Ligne 122 vérifiée : `  cost_by_model?: Record<string, number>;` ; ligne 123 : `}`.
- Modifier : `src/orchestrator/orchestrator.ts` (608-614) — Le bloc de recopie loopResult → AgentResult. Ligne 613 vérifiée : `      agentResults[i].cost_by_model = loopResult.costByModel;` ; ligne 614 : `    }`. On y ajoute deux lignes.
- Test : `tests/unit/orchestrator-run.test.ts` (7-8 (imports) et 479 (fin de fichier)) — Harnais existant qui mocke `launchAgentLoop` et appelle le vrai `runProject`. Ligne 479 vérifiée : `});` (dernière ligne). On y ajoute un `describe` final.
- Modifier : `src/agent-loop/agent-loop.ts` (71-80, 82-94, 96-113 (LECTURE SEULE — aucune modification)) — Source des types réutilisés. Ligne 82 vérifiée : `export interface TurnDetail {` ; ligne 113 : `  turnDetails: TurnDetail[];` ; ligne 71 : `export type ExitReason =`.
- Modifier : `src/orchestrator/reporter.ts` (85 (LECTURE SEULE — aucune modification)) — Preuve que rien n'est à faire ici. Ligne 85 vérifiée : `  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));` — replacer `null`, donc sérialisation exhaustive.

**Interfaces :**
- Consomme : src/agent-loop/agent-loop.ts (aucune modification) : `export type ExitReason = "done" | "yielded" | "max_turns" | "budget_exceeded" | "process_died" | "deadline_exceeded" | "aborted" | "rate_limited" | "error"` (l.71-80) ; `export interface TurnDetail { turn: number; phase: string; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number; durationMs: number; toolCallCount: number; contentLength: number; }` (l.82-94) ; `export interface AgentLoopResult` avec `exitReason: ExitReason` (l.98) et `turnDetails: TurnDetail[]` (l.113). — src/orchestrator/reporter.ts (aucune modification) : `export function writeReport(results: RunResult[], outputDir: string): string` (l.80), retourne le chemin du `.md` ; le `.json` frère se déduit par `mdPath.replace(/\.md$/, ".json")`.
- Produit : src/orchestrator/types.ts, interface `AgentResult`, deux champs optionnels ajoutés après `cost_by_model` : `turn_details?: TurnDetail[]` et `exit_reason?: ExitReason` (`TurnDetail` et `ExitReason` importés en `import type` depuis `../agent-loop/agent-loop.js`). Ils sont peuplés par `src/orchestrator/orchestrator.ts` dans le bloc `if (loopResult)` (l.608-616 après patch) et sortent tels quels dans `reports/<base>.json` — donc lisibles par toute tâche ultérieure via `JSON.parse(readFileSync(jsonPath)).[0].agent_results[i].turn_details`. Le Markdown reste inchangé : aucune section « tokens par phase » n'existe encore.

**Contexte nécessaire :**

essaim est un orchestrateur qui lance N agents Claude Code en parallèle sur des worktrees git ; chaque agent tourne dans une « boucle d'agent » (`src/agent-loop/agent-loop.ts`) qui envoie des messages au CLI Claude tour après tour. À chaque envoi, la boucle construit un objet `TurnDetail` (fichier `src/agent-loop/agent-loop.ts`, ligne 578 : `const detail: TurnDetail = {`) qui porte le numéro de tour, la phase (`discover` / `review` / `execute` / `main` / `coordination`), le modèle, les quatre compteurs de tokens (input, output, cache read, cache creation), le coût, la durée, le nombre d'appels d'outils et la longueur du contenu. Ces objets s'accumulent dans `turnDetails` et ressortent dans `AgentLoopResult` (`turnDetails: TurnDetail[]`, ligne 113 du même fichier), aux côtés de `exitReason` (ligne 98) qui dit POURQUOI la boucle s'est arrêtée. L'orchestrateur récupère ces résultats dans une `Map<string, AgentLoopResult>` (`orchestrator.ts` ligne 512) puis, ligne 600, appelle `collectAgentResults(workspace)` qui fabrique un `AgentResult` par agent — un type distinct, en snake_case, défini dans `src/orchestrator/types.ts` lignes 102-123. La jonction entre les deux se fait lignes 605-614 de `orchestrator.ts`, et c'est là qu'est le trou : le bloc recopie `turnsCount`, `totalCostUsd`, `tokens`, `costByPhase`, `costByModel`, et s'arrête. `turnDetails` et `exitReason` sont calculés, agrégés, retournés… puis jetés. La conséquence pratique est double. D'abord `cost_by_phase` ne porte que des dollars, et sous abonnement OAuth l'API ne renvoie aucun prix par appel : toutes ces valeurs valent 0, donc la ventilation par phase est structurellement vide alors que les TOKENS par phase, eux, sont bien mesurés et existent dans `turnDetails`. Ensuite un agent qui meurt apparaît en `exit_code: 1` sans aucune métrique attachée, et rien ne distingue « mort avant d'avoir rien dépensé » de « a beaucoup dépensé puis est mort » — trois agents sur treize sont dans ce cas dans les rapports existants. Le rapport final est écrit par `src/orchestrator/reporter.ts` : `writeReport()` (ligne 80) produit un `.json` et un `.md` partageant le même basename, et retourne le chemin du `.md`. Point important pour la suite : la ligne 85 est `fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));` — le deuxième argument de `JSON.stringify` est `null`, donc il n'y a NI replacer NI liste blanche de champs. Tout champ ajouté à `AgentResult` part automatiquement dans le JSON, sans une ligne à toucher côté reporter. Le Markdown, lui, est composé à la main champ par champ et n'affichera rien de nouveau — c'est délibéré et hors périmètre de cette tâche.

**Pourquoi le test discrimine :** Sans le patch, le bloc `if (loopResult)` de `src/orchestrator/orchestrator.ts` (lignes 608-614) ne recopie que 5 champs : `agent.exit_reason` et `agent.turn_details` relus depuis le JSON écrit valent `undefined`, et `expect(agent.exit_reason).toBe("process_died")` échoue.

- [ ] **Étape 1 : Écrire le test rouge — imports**

Dans `C:/Users/gagno/projet/essaim-new/tests/unit/orchestrator-run.test.ts`, remplacer les lignes 7 et 8, qui sont actuellement exactement :

```ts
import type { AgentConfig, MiniProject } from "../../src/orchestrator/types.js";
import type { AgentLoopResult } from "../../src/agent-loop/agent-loop.js";
```

par :

```ts
import type { AgentConfig, MiniProject, RunResult } from "../../src/orchestrator/types.js";
import type { AgentLoopResult, TurnDetail } from "../../src/agent-loop/agent-loop.js";
import { writeReport } from "../../src/orchestrator/reporter.js";
```

`reporter.js` n'est mocké nulle part dans ce fichier (les `vi.mock` couvrent `mcp-coordinator`, `agent-launcher.js`, `metrics.js`, `preflight.js` uniquement) — un import statique est donc sûr ; vitest hisse de toute façon les `vi.mock` au-dessus des imports.

- [ ] **Étape 2 : Écrire le test rouge — le cas**

Toujours dans `C:/Users/gagno/projet/essaim-new/tests/unit/orchestrator-run.test.ts`, ajouter à la FIN du fichier (après la ligne 479, qui est `});`) :

```ts

// ── turnDetails / exitReason survivent jusqu'au JSON du rapport ─────────────

describe("runProject — turn details et exit reason dans le rapport", () => {
  it("recopie turnDetails et exitReason de l'agent-loop jusque dans le JSON écrit", async () => {
    // Sans le patch, le bloc `if (loopResult)` de l'orchestrateur ne reprend que
    // turnsCount / totalCostUsd / tokens / costBy* : la ventilation des TOKENS par
    // phase et la cause de sortie sont calculées puis jetées. Un agent mort
    // n'apparaît alors qu'en `exit 1`, sans rien pour distinguer « mort avant
    // d'avoir dépensé » de « a dépensé puis est mort ».
    const turnDetails: TurnDetail[] = [
      {
        turn: 1, phase: "discover", model: "claude-haiku-4-5",
        inputTokens: 120, outputTokens: 40, cacheReadTokens: 900, cacheCreationTokens: 300,
        costUsd: 0, durationMs: 1500, toolCallCount: 3, contentLength: 512,
      },
      {
        turn: 2, phase: "execute", model: "claude-opus-4-6",
        inputTokens: 80, outputTokens: 220, cacheReadTokens: 1800, cacheCreationTokens: 0,
        costUsd: 0, durationMs: 4200, toolCallCount: 7, contentLength: 2048,
      },
    ];

    vi.stubGlobal("fetch", makeFetchMock({ a1: true }));
    vi.mocked(launchAgentLoop).mockImplementation(async (agent) => ({
      ...makeLoopResult(agent.id, "process_died"),
      turnDetails,
    }));

    const project = makeProject({
      agents: [makeAgent({ id: "a1", name: "Agent A" })],
      workspace: { type: "none", base: TMP_DIR },
    });

    const result = await runProject(project, "with_coordinator", false, {
      coordinatorUrl: "http://coordinator.test",
    });

    // Le rapport s'écrit dans un dossier jetable : `reports/` est gitignoré et
    // n'a pas à recevoir les écritures d'un test. writeReport retourne le chemin
    // du .md ; le .json partage le même basename (reporter.ts:82-87).
    const outDir = path.join(TMP_DIR, "report-out");
    const mdPath = writeReport([result], outDir);
    const jsonPath = mdPath.replace(/\.md$/, ".json");
    const written = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as RunResult[];

    const agent = written[0].agent_results.find((a) => a.agent_id === "a1")!;
    expect(agent.exit_reason).toBe("process_died");
    expect(agent.turn_details).toHaveLength(2);
    // La ventilation par phase — le point de tout l'exercice — arrive intacte.
    expect(agent.turn_details!.map((d) => d.phase)).toEqual(["discover", "execute"]);
    expect(agent.turn_details![0].cacheReadTokens).toBe(900);
    expect(agent.turn_details![1].outputTokens).toBe(220);
  });
});
```

Tout ce que ce bloc utilise existe déjà au niveau module dans le fichier : `makeFetchMock` (l.102), `makeAgent` (l.61), `makeProject` (l.72), `makeLoopResult` (l.85), `TMP_DIR` (l.126, un `mkdtempSync` fait en `beforeEach` et supprimé en `afterEach`), `launchAgentLoop` et `runProject` (l.55-56).

- [ ] **Étape 3 : Vérifier que le test est rouge**

Lancer :

```
npx vitest run tests/unit/orchestrator-run.test.ts -t "recopie turnDetails"
```

Résultat attendu : 1 test, 1 échec, avec

```
AssertionError: expected undefined to be 'process_died'
```

sur la ligne `expect(agent.exit_reason).toBe("process_died")`. Si le test PASSE à ce stade, c'est que les deux champs ont déjà été ajoutés — vérifier `src/orchestrator/types.ts` et `src/orchestrator/orchestrator.ts` avant de continuer.

(Vitest transpile sans vérifier les types : l'accès à `agent.exit_reason`, encore inexistant sur `AgentResult`, n'empêche pas l'exécution. C'est bien `undefined` au runtime qui fait échouer le test.)

- [ ] **Étape 4 : Ajouter les deux champs à AgentResult**

Dans `C:/Users/gagno/projet/essaim-new/src/orchestrator/types.ts` :

1) Après la ligne 3, qui est exactement :

```ts
import type { MiniProjectSecurity, SecurityRunLedger } from "../security/types.js";
```

ajouter :

```ts
import type { TurnDetail, ExitReason } from "../agent-loop/agent-loop.js";
```

(`import type` n'émet aucun import runtime — le tsconfig n'active pas `verbatimModuleSyntax` — donc pas de cycle à l'exécution malgré types.ts → agent-loop.ts → scanner.ts → types.ts. `orchestrator.ts` fait déjà exactement le même `import type` depuis agent-loop.js, ligne 22.)

2) Remplacer les lignes 122-123, qui sont exactement :

```ts
  cost_by_model?: Record<string, number>;
}
```

par :

```ts
  cost_by_model?: Record<string, number>;
  // Per-turn detail: the only place tokens are attributable to a PHASE.
  // cost_by_phase holds dollars only, and those are all 0 under an OAuth
  // subscription — the phase breakdown it feeds is structurally empty.
  turn_details?: TurnDetail[];
  // Why the loop stopped. exit_code alone cannot tell "died before spending
  // anything" from "spent, then died".
  exit_reason?: ExitReason;
}
```

`TurnDetail` est défini `src/agent-loop/agent-loop.ts:82-94` et `ExitReason` `src/agent-loop/agent-loop.ts:71-80` (union de `"done" | "yielded" | "max_turns" | "budget_exceeded" | "process_died" | "deadline_exceeded" | "aborted" | "rate_limited" | "error"`).

- [ ] **Étape 5 : Recopier les deux champs dans l'orchestrateur**

Dans `C:/Users/gagno/projet/essaim-new/src/orchestrator/orchestrator.ts`, remplacer les lignes 613-614, qui sont exactement :

```ts
      agentResults[i].cost_by_model = loopResult.costByModel;
    }
```

par :

```ts
      agentResults[i].cost_by_model = loopResult.costByModel;
      agentResults[i].turn_details = loopResult.turnDetails;
      agentResults[i].exit_reason = loopResult.exitReason;
    }
```

C'est tout le correctif de production. Rien à changer dans `src/orchestrator/reporter.ts` : la ligne 85 est `fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));` — le replacer (2e argument) vaut `null`, donc `JSON.stringify` sérialise toutes les propriétés énumérables. Il n'y a aucune liste blanche de champs, aucune fonction `toJSON`, aucune projection intermédiaire entre `RunResult` et le disque : les deux nouveaux champs partent seuls dans le JSON. (Le `.md`, lui, est composé champ par champ lignes 88-207 et n'affichera rien de nouveau — délibérément hors périmètre.)

- [ ] **Étape 6 : Vérifier que le test est vert, puis le fichier entier, puis la suite**

Dans l'ordre :

```
npx vitest run tests/unit/orchestrator-run.test.ts -t "recopie turnDetails"
```
attendu : `1 passed`.

```
npx vitest run tests/unit/orchestrator-run.test.ts
```
attendu : tous les tests du fichier passent (aucun ne lit `turn_details` ni `exit_reason`, l'ajout est purement additif).

```
pnpm test
```
attendu : suite complète verte.

```
pnpm build
```
attendu : `tsc` sans erreur. Cette étape n'est pas cosmétique : le `include` de `tsconfig.json` couvre `tests/**/*.ts`, donc si l'étape 4 a été sautée, `pnpm build` échoue sur `Property 'exit_reason' does not exist on type 'AgentResult'` alors même que vitest passait.

- [ ] **Étape 7 : Commiter**

```
git add src/orchestrator/types.ts src/orchestrator/orchestrator.ts tests/unit/orchestrator-run.test.ts
git commit -m "feat(report): turnDetails et exitReason survivent jusqu'au JSON du rapport"
```

Message complet si un corps est souhaité (le dépôt utilise des commits conventionnels rédigés en français) :

```
feat(report): turnDetails et exitReason survivent jusqu'au JSON du rapport

Le bloc de recopie loopResult -> AgentResult ne reprenait que turnsCount,
totalCostUsd, tokens et les deux ventilations en dollars. turnDetails, seule
source de tokens attribuables a une phase, et exitReason, seule facon de
distinguer un agent mort avant d'avoir depense d'un agent mort apres, etaient
calcules puis jetes. JSON.stringify du reporter n'a pas de replacer : les deux
champs partent seuls dans le rapport.
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**Numéro de ligne faux dans la note de fin de l'étape 2 : « `launchAgentLoop` et `runProject` (l.55-56) ». Lecture réelle de tests/unit/orchestrator-run.test.ts : l.55 = `const { startServer } = await import("mcp-coordinator");`, l.56 = `const { launchAgentLoop } = await import("../../src/orchestrator/agent-launcher.js");`, l.57 = `const { runProject } = await import("../../src/orchestrator/orchestrator.js");`. Le décalage d'un rang fait pointer la citation sur `startServer`. Tout le reste de cette note est exact (makeFetchMock l.102, makeAgent l.61, makeProject l.72, makeLoopResult l.85, TMP_DIR l.126).**

Tout ce que ce bloc utilise existe déjà au niveau module dans le fichier : `makeFetchMock` (l.102), `makeAgent` (l.61), `makeProject` (l.72), `makeLoopResult` (l.85), `TMP_DIR` (l.126, un `mkdtempSync` fait en `beforeEach` et supprimé en `afterEach`), `launchAgentLoop` (l.56) et `runProject` (l.57) — l.55 étant `startServer`, importé de la même façon via `await import`.

**Métadonnée contradictoire dans `fichiers` : les entrées `src/agent-loop/agent-loop.ts` et `src/orchestrator/reporter.ts` portent `"action": "modifier"` alors que leur champ `role` dit « LECTURE SEULE — aucune modification ». Un implémenteur qui lit le champ `action` (ou un outil qui le parse) croira devoir éditer ces deux fichiers, alors que le correctif ne touche que types.ts, orchestrator.ts et le fichier de test. Vérifié : aucune ligne d'agent-loop.ts ni de reporter.ts n'est modifiée par les étapes 1 à 7.**

Remplacer les deux entrées par :

  {
   "chemin": "C:/Users/gagno/projet/essaim-new/src/agent-loop/agent-loop.ts",
   "action": "lire",
   "lignes": "71-80, 82-94, 96-113",
   "role": "Source des types réutilisés, AUCUNE modification. Ligne 71 vérifiée : `export type ExitReason =` ; ligne 82 : `export interface TurnDetail {` ; ligne 96 : `export interface AgentLoopResult {` ; ligne 98 : `  exitReason: ExitReason;` ; ligne 113 : `  turnDetails: TurnDetail[];`."
  },
  {
   "chemin": "C:/Users/gagno/projet/essaim-new/src/orchestrator/reporter.ts",
   "action": "lire",
   "lignes": "85",
   "role": "Preuve que rien n'est à faire ici, AUCUNE modification. Ligne 85 vérifiée : `  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));` — replacer `null`, donc sérialisation exhaustive."
  }

**Risques :**
- Taille du rapport JSON : `turnDetails` peut faire jusqu'à 60 entrées par agent (le profil d'effort `max` plafonne maxTurns à 60, cf. `src/agent-loop/effort.ts`), × 11 champs × N agents. Un raid à 13 agents peut ajouter quelques centaines de Ko au `.json`. Se voit en comparant la taille de deux fichiers `reports/*.json` avant/après. Aucun impact sur le `.md`.
- Cycle d'import types.ts → agent-loop.ts → scanner.ts → types.ts : inoffensif car l'arête ajoutée est un `import type` et le tsconfig n'active pas `verbatimModuleSyntax`, donc aucun `import` runtime n'est émis depuis types.js (qui ne contient d'ailleurs que des interfaces). Si un jour `verbatimModuleSyntax` est activé, `pnpm build` le signalera ; le repli serait de dupliquer les deux types dans types.ts.
- `pnpm build` type-vérifie aussi `tests/**/*.ts` (via le `include` du tsconfig) : oublier l'étape 4 donne une suite vitest verte et un build rouge. Toujours enchaîner `pnpm test` puis `pnpm build`.
- Un agent dont la promesse d'agent-loop a REJETÉ n'entre jamais dans la Map `agentLoopResults` (`orchestrator.ts` lignes 528-533 : le `set` n'a lieu que dans la branche `r.status === "fulfilled"`). Ce cas-là reste sans `turn_details` ni `exit_reason`, exactement comme avant — le correctif ne couvre que les boucles qui se terminent proprement en rendant un `AgentLoopResult`, y compris avec un `exitReason` d'échec comme `process_died` ou `budget_exceeded`.
- Consommateurs externes du JSON : `AgentResult` est réexporté publiquement par `src/index.ts` (ligne 12). Les deux champs étant optionnels, aucun consommateur existant ne casse, mais un parseur strict (schéma JSON en mode `additionalProperties: false`) sur les rapports rejetterait le nouveau format. Rien de tel dans ce dépôt — `grep -rn "additionalProperties" src/ cli/` ne remonte aucun schéma sur AgentResult.


---

### Tâche 3 : Rétrécir la fenêtre de réclamation concurrente sur un même fichier (relecture post-claim + départage déterministe par agent_id)

**Objectif :** Après un claim réussi, relire les threads actifs et relâcher le nôtre si un pair au plus petit `agent_id` détient déjà une réclamation ouverte sur l'un de nos fichiers cibles — sans verrou, sans sérialiser les démarrages.

**Fichiers :**
- Modifier : `src/agent-loop/work-stealing.ts` (142-151 (computeBusyFiles, référence), 209-211 (branche succès du claim, point d'insertion), 268-280 (unclaimTask, réutilisé)) — Ajout du helper findLosingConflict après computeBusyFiles, et de la relecture post-claim dans la branche succès de claimNextTask
- Test : `tests/unit/claim-dedup.test.ts` (1-139 (fichier existant ; le nouveau describe s'ajoute à la fin, après la ligne 139)) — Fichier de test déjà dédié à la dédup par fichier (#30) et à la fenêtre TOCTOU — le faux coordinateur y est déjà en place

**Interfaces :**
- Consomme : Existants dans src/agent-loop/work-stealing.ts, inchangés : `function threadFiles(thread: Record<string, unknown>): string[]` (ligne 20) ; `async function fetchActiveThreads(coordinatorUrl: string): Promise<Array<Record<string, unknown>> | null>` (ligne 117, renvoie null si le coordinateur est injoignable ou répond non-ok) ; `function computeBusyFiles(openThreads: Array<Record<string, unknown>>, agentId: string): Set<string>` (ligne 142) ; `export async function unclaimTask(coordinatorUrl: string, threadId: string, agentId: string): Promise<void>` (ligne 268, avale ses erreurs). Endpoints du coordinateur : POST /api/threads-active, POST /api/claim-task, POST /api/unclaim-task.
- Produit : Nouveau helper NON exporté (module-privé) dans src/agent-loop/work-stealing.ts : `function findLosingConflict(openThreads: Array<Record<string, unknown>>, agentId: string, ownFiles: string[]): { file: string; winner: string } | null`. Attend une liste déjà filtrée sur `status === "open"`, comme computeBusyFiles. La signature publique `export async function claimNextTask(coordinatorUrl: string, agentId: string): Promise<Task | null>` (ligne 158) et le type `Task` (ligne 8) sont INCHANGÉS — aucun appelant à adapter. Seul le comportement change : claimNextTask peut désormais renvoyer null là où il renvoyait une Task, ce que src/agent-loop/agent-loop.ts:1010 gère déjà via son branchement `if (!task)`.

**Contexte nécessaire :**

Le dépôt `essaim` est un orchestrateur qui lance N agents Claude Code en parallèle, chacun dans son propre worktree git, coordonnés par un serveur externe (`mcp-coordinator`) qui joue le rôle de tableau de tâches partagé. Une « tâche » est un *thread* côté coordinateur : un objet `{ id, status, claimed_by, target_files, subject }`. Un agent s'approprie une tâche via `POST /api/claim-task`, que le coordinateur implémente en `UPDATE ... WHERE claimed_by IS NULL` — c'est-à-dire atomique **sur le thread_id, et uniquement sur lui**.

Le problème métier (issue #30) est qu'un même bug peut engendrer plusieurs threads distincts visant le **même fichier** : trois agents chasseurs qui découvrent indépendamment le même défaut postent trois découvertes, donc trois threads. L'atomicité par thread ne protège de rien ici : chaque agent en prend un, et les trois écrivent un test de reproduction quasi identique dans trois worktrees. Le garde-fou existant est donc structurel plutôt que sémantique : `computeBusyFiles` (src/agent-loop/work-stealing.ts:142) parcourt les threads ouverts, retient les fichiers dont le `claimed_by` est un autre agent que nous, et `claimNextTask` écarte tout candidat qui touche un de ces fichiers.

Le bug à corriger est que ce garde est calculé sur un **instantané pris avant le claim**. `claimNextTask` (ligne 158) commence par `const threads = await fetchActiveThreads(coordinatorUrl);` (ligne 162), calcule `let busyFiles = computeBusyFiles(open, agentId);` (ligne 169), puis boucle et tente les claims. Au démarrage parallèle du essaim, les N agents exécutent leur `fetchActiveThreads` quasi simultanément, **avant** que le moindre `claim-task` n'ait atterri : chaque instantané montre donc `claimed_by: null` partout. Le garde ne peut pas se déclencher au premier tour — ce n'est pas un réglage à ajuster, c'est structurel. Le code le reconnaît déjà à la ligne 228 : « claim-task is atomic only on thread_id, not on file, so a race can still land in the gap ».

Un correctif partiel existe déjà, mais seulement sur le chemin de l'échec : quand un claim est **perdu** (`success: false`), les lignes 232-235 refont un `fetchActiveThreads` et recalculent `busyFiles` avant d'évaluer le candidat suivant. Le chemin du **succès** (ligne 209) ne fait aucune revérification : il journalise, construit la `Task` et la renvoie immédiatement.

La correction consiste à ajouter cette même relecture sur le chemin du succès, puis à départager. Le départage doit être **déterministe et sans communication** : deux agents qui découvrent le conflit chacun de leur côté doivent aboutir à des conclusions opposées et complémentaires (l'un garde, l'autre relâche) sans échanger le moindre message. Comparer des horodatages ne le garantit pas (horloges distinctes, `claimed_at` pas nécessairement exposé). Comparer les `agent_id` le garantit : c'est un ordre total fixe, et chaque agent connaît le sien ainsi que celui du pair (via `claimed_by`). Convention retenue : le plus petit `agent_id` en ordre lexicographique garde le fichier, les autres appellent `unclaimTask` (ligne 268) et poursuivent la boucle. Corollaire important : l'agent au plus petit id ne relâche jamais, donc un conflit ne peut pas faire relâcher tout le monde et perdre le travail.

Il faut être clair sur la portée : ceci **rétrécit** la fenêtre, il ne la ferme pas. Si les deux relectures partent toutes deux avant que le claim de l'autre n'ait atterri, aucun des deux ne voit le conflit et les deux gardent. La vraie atomicité par fichier exige un changement côté coordinateur (un `UPDATE` conditionné sur les fichiers, pas seulement sur le thread_id), hors du périmètre de ce dépôt.

**Pourquoi le test discrimine :** Sans le patch, la branche succès de `claimNextTask` (work-stealing.ts:209-222) renvoie la `Task` immédiatement après `success: true` : elle ne refait aucun `threads-active` et n'appelle jamais `unclaim-task` — donc `expect(task).toBeNull()` reçoit `{ id: 't1', … }` et `expect(activeCount()).toBe(2)` reçoit `1`, alors que le faux coordinateur ne révèle la réclamation concurrente de `agent-1` que dans son **deuxième** instantané, exactement comme dans la vraie course.

- [ ] **Étape 1 : Écrire le test rouge — ajouter un describe à la fin de tests/unit/claim-dedup.test.ts**

Ouvrir `tests/unit/claim-dedup.test.ts`. Le fichier fait 139 lignes et se termine par l'accolade fermante `});` du describe « claimNextTask — refetch après course perdue (fenêtre TOCTOU réduite, pas fermée) ». Le type `Thread` (ligne 14 : `type Thread = Record<string, unknown>;`) et les hooks `beforeEach(() => vi.restoreAllMocks());` / `afterEach(() => vi.unstubAllGlobals());` (lignes 30-31) sont déjà en place et s'appliquent à tout le fichier — ne rien redéclarer.

Coller ce bloc **après la ligne 139**, à la fin du fichier :

```ts

describe('claimNextTask — re-vérification APRÈS le claim (démarrage parallèle)', () => {
  // Le garde `computeBusyFiles` est calculé sur un instantané pris AVANT le
  // claim. Au démarrage parallèle, les N instantanés précèdent les N claims :
  // aucun agent n'y voit la réclamation d'un pair, le garde ne peut pas se
  // déclencher au premier tour. D'où une seconde lecture APRÈS le claim.

  // Faux coordinateur à deux temps : le PREMIER /api/threads-active renvoie
  // l'instantané pré-claim, tous les suivants l'instantané post-claim.
  function mockRace(before: Thread[], after: Thread[]) {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    const activeCount = () => calls.filter((c) => c.url.endsWith('/api/threads-active')).length;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
      calls.push({ url, body });
      if (url.endsWith('/api/threads-active')) {
        return new Response(JSON.stringify(activeCount() === 1 ? before : after), { status: 200 });
      }
      if (url.endsWith('/api/claim-task')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    return { fetchMock, calls, activeCount };
  }

  it('relâche le thread quand un pair au plus petit id détient le même fichier', async () => {
    // Pré-claim : src/report.ts a l'air libre — le claim du pair n'a pas atterri.
    const before: Thread[] = [
      { id: 't1', status: 'open', claimed_by: null, target_files: ['src/report.ts'], subject: 'bug report' },
    ];
    // Post-claim : le claim de agent-1 sur le MÊME fichier est devenu visible.
    const after: Thread[] = [
      { id: 't1', status: 'open', claimed_by: 'agent-2', target_files: ['src/report.ts'], subject: 'bug report' },
      { id: 't9', status: 'open', claimed_by: 'agent-1', target_files: ['src/report.ts'], subject: 'même fichier' },
    ];
    const { fetchMock, calls, activeCount } = mockRace(before, after);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'agent-2');

    // 'agent-1' < 'agent-2' → on perd le départage, on relâche.
    expect(task).toBeNull();
    expect(activeCount()).toBe(2); // la relecture post-claim a bien eu lieu
    const unclaims = calls.filter((c) => c.url.endsWith('/api/unclaim-task'));
    expect(unclaims).toHaveLength(1);
    expect(unclaims[0].body).toMatchObject({ thread_id: 't1', agent_id: 'agent-2' });
  });

  it('garde le thread quand c\'est NOUS qui avons le plus petit id', async () => {
    const before: Thread[] = [
      { id: 't1', status: 'open', claimed_by: null, target_files: ['src/report.ts'], subject: 'bug report' },
    ];
    const after: Thread[] = [
      { id: 't1', status: 'open', claimed_by: 'agent-0', target_files: ['src/report.ts'], subject: 'bug report' },
      { id: 't9', status: 'open', claimed_by: 'agent-1', target_files: ['src/report.ts'], subject: 'même fichier' },
    ];
    const { fetchMock, calls, activeCount } = mockRace(before, after);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'agent-0');

    // 'agent-1' > 'agent-0' → on gagne, on garde. Le pair, lui, compare la MÊME
    // paire et conclut l'inverse — sans qu'on ait eu à lui parler.
    expect(task?.id).toBe('t1');
    expect(activeCount()).toBe(2); // la relecture a eu lieu et a conclu « on garde »
    expect(calls.filter((c) => c.url.endsWith('/api/unclaim-task'))).toHaveLength(0);
  });

  it('un thread sans fichier cible ne paie pas la relecture (coût borné)', async () => {
    const before: Thread[] = [
      { id: 't1', status: 'open', claimed_by: null, target_files: [], subject: 'sans fichier' },
    ];
    const { fetchMock, activeCount } = mockRace(before, before);
    vi.stubGlobal('fetch', fetchMock);

    const task = await claimNextTask('https://c', 'agent-2');

    expect(task?.id).toBe('t1');
    expect(activeCount()).toBe(1); // un seul threads-active : aucun fetch supplémentaire
  });
});
```

Aucun autre import n'est nécessaire : `describe`, `it`, `expect`, `vi` sont déjà importés en ligne 2, et `claimNextTask` en ligne 3.

- [ ] **Étape 2 : Vérifier que le test est ROUGE**

Lancer :

```
npx vitest run tests/unit/claim-dedup.test.ts
```

Résultat attendu : **2 tests échouent sur 8** (les 5 anciens et le troisième nouveau passent).

- « relâche le thread quand un pair au plus petit id détient le même fichier » échoue sur `expect(task).toBeNull()` — vitest affiche un objet reçu de la forme `{ id: 't1', description: 'bug report', file: 'src/report.ts', … }` au lieu de `null`. Sans le patch, la branche succès (work-stealing.ts:209) renvoie la Task directement, sans jamais relire ni relâcher.
- « garde le thread quand c'est NOUS qui avons le plus petit id » échoue sur `expect(activeCount()).toBe(2)` avec `expected 1 to be 2` — sans le patch il n'y a qu'un seul `/api/threads-active`, celui de la ligne 162.
- « un thread sans fichier cible ne paie pas la relecture » passe déjà : c'est un garde-fou de coût, pas un test de régression du bug. C'est normal et attendu.

Si le premier test passe dès maintenant, s'arrêter : le faux coordinateur ne reproduit pas la course et le reste de la tâche ne prouverait rien.

- [ ] **Étape 3 : Ajouter le helper findLosingConflict dans src/agent-loop/work-stealing.ts**

Dans `src/agent-loop/work-stealing.ts`, la fonction `computeBusyFiles` se termine à la ligne 151 par `}`, suivie d'une ligne vide (152) puis du bloc JSDoc `/**` de `claimNextTask` (ligne 153).

Insérer ce bloc **entre la ligne 151 et la ligne 153** (donc juste après l'accolade fermante de `computeBusyFiles`, avant le JSDoc de `claimNextTask`) :

```ts

// Départage post-claim (#30, suite). `computeBusyFiles` ci-dessus est calculé
// sur un instantané pris AVANT le claim : au démarrage parallèle, les N
// instantanés précèdent les N claims, donc aucun agent n'y voit la réclamation
// d'un pair et le garde ne peut STRUCTURELLEMENT pas se déclencher au premier
// tour. On relit donc les threads APRÈS un claim réussi, quand les
// réclamations concurrentes sont enfin visibles.
//
// Le départage se fait sur l'IDENTIFIANT D'AGENT, jamais sur l'horodatage : le
// plus petit agent_id (ordre lexicographique) garde le fichier, les autres
// relâchent. Les deux côtés comparent la même paire et concluent l'inverse
// l'un de l'autre sans échanger un seul message — pas de verrou, pas de
// sérialisation des démarrages. Corollaire utile : l'agent au plus petit id ne
// relâche jamais, donc un conflit ne peut pas faire relâcher TOUT LE MONDE et
// perdre le travail.
//
// Renvoie le premier conflit PERDU, ou null si on garde le thread.
function findLosingConflict(
  openThreads: Array<Record<string, unknown>>,
  agentId: string,
  ownFiles: string[],
): { file: string; winner: string } | null {
  if (ownFiles.length === 0) return null;
  const mine = new Set(ownFiles);
  for (const t of openThreads) {
    const owner = t.claimed_by as string | null | undefined;
    if (!owner || owner === agentId) continue;
    if (owner > agentId) continue; // id plus grand que le nôtre : c'est lui qui relâchera
    const file = threadFiles(t).find((f) => mine.has(f));
    if (file) return { file, winner: owner };
  }
  return null;
}
```

Notes de conformité au fichier : `threadFiles` est le helper existant de la ligne 20 (`function threadFiles(thread: Record<string, unknown>): string[]`). Le paramètre s'appelle `openThreads` et la fonction ne re-filtre pas `status` — exactement le même contrat que `computeBusyFiles(openThreads, agentId)` ligne 142, qui reçoit toujours une liste déjà filtrée sur `status === "open"`.

- [ ] **Étape 4 : Brancher la relecture dans la branche succès de claimNextTask**

Toujours dans `src/agent-loop/work-stealing.ts`, à l'intérieur de `claimNextTask`, les lignes 209 à 211 sont actuellement :

```ts
      if ((result as Record<string, unknown>).success === true) {
        log.info(`claimed thread=${threadId}: ${subject.slice(0, 80)}`);
        const relatedDone = files.flatMap((f) => doneByFile.get(f) ?? []);
```

(les numéros ont bougé de +32 environ après l'insertion de l'étape 3 ; se repérer sur le texte, pas sur le numéro)

Remplacer ces trois lignes par :

```ts
      if ((result as Record<string, unknown>).success === true) {
        log.info(`claimed thread=${threadId}: ${subject.slice(0, 80)}`);

        // Relecture post-claim : voir findLosingConflict. Un seul threads-active
        // de plus, et seulement pour un thread qui cible des fichiers — un
        // thread sans target_files ne peut pas entrer en conflit de fichier.
        if (files.length > 0) {
          const after = await fetchActiveThreads(coordinatorUrl);
          if (after !== null) {
            const afterOpen = after.filter((t) => t.status === "open");
            // Instantané frais : il resservira au candidat suivant si on relâche.
            busyFiles = computeBusyFiles(afterOpen, agentId);
            const lost = findLosingConflict(afterOpen, agentId, files);
            if (lost) {
              log.info(`post-claim: ${lost.file} aussi réclamé par ${lost.winner} (id plus petit) — on relâche thread=${threadId}`);
              await unclaimTask(coordinatorUrl, threadId, agentId);
              continue;
            }
          }
        }

        const relatedDone = files.flatMap((f) => doneByFile.get(f) ?? []);
```

Le reste de la branche (le `if (relatedDone.length > 0)` et le `return { id: threadId, … }`) reste inchangé.

Trois points qui font que ça compile et se comporte bien :
- `busyFiles` est déclaré `let` à la ligne 169 (`let busyFiles = computeBusyFiles(open, agentId);`), il est donc réassignable — c'est déjà ce que fait la ligne 234 sur le chemin de l'échec.
- `unclaimTask` est déclarée plus bas dans le module (ligne 268, `export async function unclaimTask(coordinatorUrl: string, threadId: string, agentId: string): Promise<void>`) ; les déclarations de fonction sont hoistées, l'appel depuis `claimNextTask` est valide. Elle avale ses propres erreurs via `.catch`, donc pas de `try` supplémentaire ici.
- `continue` reprend la boucle `for (const thread of threads)` de la ligne 184, qui itère sur l'instantané d'origine. Notre thread relâché est derrière nous dans l'itération : on ne le retentera pas dans cet appel, ce qui est voulu (le retenter ne ferait que relancer la même course).

- [ ] **Étape 5 : Vérifier que le test est VERT**

Lancer :

```
npx vitest run tests/unit/claim-dedup.test.ts
```

Attendu : **8 tests passés, 0 échec**.

Puis vérifier que les deux autres fichiers qui exercent `claimNextTask` ne régressent pas :

```
npx vitest run tests/unit/work-stealing.test.ts tests/unit/run-id.test.ts
```

Attendu : tout passe. En particulier `work-stealing.test.ts` ligne 93 (`expect(mockFetch).toHaveBeenCalledTimes(2)`) reste valide parce que ses threads n'ont pas de `target_files` — `files.length === 0`, donc pas de fetch supplémentaire. Et les deux cas de `run-id.test.ts` qui appellent `claimNextTask` renvoient `[]` : aucun claim, aucune relecture.

- [ ] **Étape 6 : Suite complète et build**

Lancer, dans cet ordre, exactement ce que fait la CI :

```
pnpm test
pnpm build
```

Attendu : `pnpm test` passe intégralement (vitest, `fileParallelism: false`), et `pnpm build` (tsc → dist) se termine sans erreur de type. Il n'y a ni lint ni format dans ce dépôt — ne pas en chercher.

Si `tsc` se plaint sur `owner > agentId`, vérifier que la ligne `if (!owner || owner === agentId) continue;` la précède bien : c'est elle qui restreint `owner` à `string` (le `!owner` élimine `null` et `undefined`).

- [ ] **Étape 7 : Commit**

Message de commit exact (convention du dépôt : conventional commits, sujet en français) :

```
fix(work-stealing): le garde par fichier ne pouvait pas se déclencher au premier tour

computeBusyFiles était calculé sur un instantané pris AVANT le claim. Au
démarrage parallèle, les N instantanés précèdent les N claims : aucun agent n'y
voit la réclamation d'un pair, le garde ne pouvait structurellement pas jouer.

On relit désormais les threads actifs APRÈS un claim réussi qui cible des
fichiers, et on départage sur l'agent_id (le plus petit garde, les autres
unclaim). Deux agents comparent la même paire et concluent l'inverse sans se
parler : pas de verrou, pas de sérialisation des démarrages.

La fenêtre est rétrécie, pas fermée — si les deux relectures partent avant que
le claim d'en face n'atterrisse, les deux gardent. La vraie atomicité par
fichier reste côté coordinateur.

Coût : un POST /api/threads-active de plus par claim réussi, borné à un par
claim et sauté quand le thread n'a pas de target_files.
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**Étape 2 — comptage de tests faux. Le plan annonce « 2 tests échouent sur 8 (les 5 anciens et le troisième nouveau passent) ». Or tests/unit/claim-dedup.test.ts contient 6 `it(`, pas 5 : cinq dans le describe « un seul agent par fichier (#30) » (lignes 34, 48, 60, 70, 80) et un sixième dans le describe « refetch après course perdue » (ligne 100 : `it('après un claim perdu, re-fetch threads-active et exclut le fichier devenu occupé avant le candidat suivant', async () => {`). Avec les 3 nouveaux cas le total est 9, pas 8. Un dev qui suit la consigne « Si le premier test passe dès maintenant, s'arrêter » et voit 9 tests au lieu de 8 croira s'être trompé de fichier.**

Remplacer le premier paragraphe de résultat attendu de l'étape 2 par :

Résultat attendu : **2 tests échouent sur 9** (les 6 anciens et le troisième nouveau passent).

Le fichier contenait déjà 6 cas : 5 dans le describe « claimNextTask — un seul agent par fichier (#30) » et 1 dans le describe « claimNextTask — refetch après course perdue (fenêtre TOCTOU réduite, pas fermée) ». Le nouveau bloc en ajoute 3.

**Étape 5 — même comptage faux : « Attendu : **8 tests passés, 0 échec**. » Il y a 9 tests dans claim-dedup.test.ts une fois le nouveau describe ajouté (6 existants + 3 nouveaux).**

Remplacer la ligne de l'étape 5 par :

Attendu : **9 tests passés, 0 échec**.

**Étape 2 — l'objet reçu décrit avec une ellipse « … » n'est pas l'objet réel. La branche succès (work-stealing.ts:215-221) construit toujours les cinq champs, y compris `severity` et `relatedDone` à `undefined` (`relatedDone.length > 0 ? relatedDone : undefined` avec `doneByFile` vide dans ce test). Un dev qui compare son diff vitest à la description fournie ne retrouvera pas ce qu'on lui a annoncé.**

Remplacer la première puce de l'étape 2 par :

- « relâche le thread quand un pair au plus petit id détient le même fichier » échoue sur `expect(task).toBeNull()` — vitest affiche l'objet reçu `{ id: 't1', description: 'bug report', file: 'src/report.ts', severity: undefined, relatedDone: undefined }` au lieu de `null`. Sans le patch, la branche succès (work-stealing.ts:215-221) renvoie cette Task directement, sans jamais relire ni relâcher.

**contexte_necessaire — la citation attribuée à la seule « ligne 228 » s'étale en réalité sur les lignes 228 à 230, et le plan tronque la phrase au milieu (« …still land in the gap »), alors que le texte réel se termine par « …between this refetch and the next claim attempt. ». Lignes exactes : 228 `      // claim-task is atomic only on thread_id, not on file, so a race can`, 229 `      // still land in the gap between this refetch and the next claim`, 230 `      // attempt. Closing it fully needs server-side atomicity over the file,`.**

Remplacer la phrase du contexte par :

Le code le reconnaît déjà aux lignes 228-230 : « claim-task is atomic only on thread_id, not on file, so a race can still land in the gap between this refetch and the next claim attempt ».

**risques — le cas `fetchActiveThreads` renvoyant `null` sur le chemin du succès n'est pas documenté. Le code de l'étape 4 fait `if (after !== null) { … }` : si le coordinateur devient injoignable ou répond non-ok juste après un claim réussi (work-stealing.ts:127 et 131 renvoient `null` dans ces deux cas), on garde le thread sans avoir rien vérifié. C'est le bon défaut, mais c'est un comportement silencieux qu'aucune ligne du plan n'annonce, et c'est exactement le trou par lequel le doublon #30 revient sur un coordinateur qui flappe.**

Ajouter ce sixième élément au tableau `risques` :

Coordinateur injoignable pendant la relecture : `fetchActiveThreads` renvoie `null` (work-stealing.ts:127 sur réponse non-ok, 131 sur exception réseau) et le `if (after !== null)` fait tomber le contrôle — on garde le thread sans avoir départagé. C'est le défaut sûr (on ne relâche pas du travail à cause d'un hoquet réseau), mais il rouvre entièrement la fenêtre #30 pour ce claim-là. Repérable par `fetchActiveThreads: threads-active failed` ou `fetchActiveThreads: coordinator unreachable` dans les logs pino, immédiatement après un `claimed thread=…`.

**Risques :**
- La fenêtre est rétrécie, PAS fermée. Si les deux relectures partent chacune avant que le claim d'en face n'ait atterri côté coordinateur, aucun des deux ne voit le conflit et les deux gardent leur thread — le doublon (#30) se reproduit. La vraie atomicité par fichier exige un UPDATE conditionné sur les fichiers côté mcp-coordinator, hors du périmètre de ce dépôt. Ne pas vendre ce correctif comme une garantie.
- Coût : un POST /api/threads-active supplémentaire par claim RÉUSSI qui cible des fichiers. Borné à un par claim (le `continue` ne peut relancer qu'autant de claims qu'il y a de threads ouverts), et sauté entièrement quand `target_files` est vide. Acceptable parce que `claimNextTask` est appelé une fois par tour de la boucle d'exécution (src/agent-loop/agent-loop.ts:1008) et que chaque tour contient un appel LLM complet de plusieurs dizaines de secondes : un POST HTTP est du bruit à côté. À surveiller seulement si le pool de threads devient très grand ET que les départages sont systématiquement perdus.
- Biais déterministe assumé : l'agent au plus petit agent_id gagne TOUS les conflits de fichier du run. Ce n'est pas de la famine (le perdant poursuit la boucle et prend un autre thread), mais sur un run où tous les threads visent le même fichier, `agent-2` relâchera systématiquement au profit de `agent-1`. Repérable dans les logs par la répétition de `post-claim: … on relâche thread=…` toujours par le même agent.
- Si `/api/unclaim-task` échoue, `unclaimTask` avale l'erreur (work-stealing.ts:277-279, `log.warn("unclaimTask failed")`). On aura fait `continue` alors que le thread reste `claimed_by` nous côté coordinateur : il devient invisible aux autres agents jusqu'au timeout du coordinateur. Dégradation sûre (on perd un thread, on ne duplique pas de travail), mais à repérer via le `unclaimTask failed` dans les logs pino.
- Effet de bord bénin : sur le chemin du succès, `busyFiles` est désormais réassigné avec l'instantané frais avant de décider. Si on garde le thread, la valeur est jetée puisqu'on `return`. Si on relâche, elle sert au candidat suivant — c'est voulu, et cohérent avec ce que fait déjà la ligne 234 sur le chemin de l'échec.
- Les tests existants ont été vérifiés compatibles : `tests/unit/work-stealing.test.ts` (threads sans `target_files` → pas de fetch en plus, l'assertion `toHaveBeenCalledTimes(2)` ligne 93 tient), `tests/unit/run-id.test.ts` (threads-active renvoie `[]`, aucun claim), et les 5 cas existants de `claim-dedup.test.ts` (leurs relectures ne révèlent aucun pair au plus petit id sur un fichier partagé). `tests/unit/agent-loop.test.ts` mocke entièrement le module work-stealing et n'est pas concerné.


---

### Tâche 4 : Bloquer AskUserQuestion sur les DIX envois de la session

**Objectif :** Interdire `AskUserQuestion` dans le wrapper `send` partagé, pour qu'aucun agent headless ne puisse se suspendre sur une question à un humain absent — et corriger les commentaires qui affirment à tort que `--dangerously-skip-permissions` auto-approuve *tous* les outils.

> **Lisez la section « Corrections de relecture » de cette tâche AVANT ses étapes.** La rédaction initiale plaçait le garde dans `disallowedForMode()`, ce qui ne couvre que les **5 envois de phase** (lignes 870, 917, 943, 1073, 1118). Les **5 autres** envois de la même session ne passent aucune option et seraient restés ouverts : coordination (lignes 729, 757, 770) et **tout le mode one-shot** (lignes 1212, 1233), c'est-à-dire le chemin de n'importe quel preset sans behavior phasé. Le garde va donc dans le wrapper `send` (lignes 553-555), point de passage unique des dix. Les étapes ci-dessous restent valables pour les tests et le contexte ; leur étape d'implémentation est remplacée par celle de la section de correction.

**Fichiers :**
- Modifier : `src/agent-loop/agent-loop.ts` (261-299) — Contient les trois tableaux de deny (`ALL_USER_TOOLS` l.266-270, `WRITE_USER_TOOLS` l.271, `NESTED_AGENT_TOOLS` l.276) et la fonction `disallowedForMode` (l.291-299) qui les combine par mode.
- Modifier : `src/agent-loop/claude-stream.ts` (76-79 et 176-178) — Deux commentaires qui décrivent le bypass de permissions comme total. Aucun code n'y change.
- Test : `tests/unit/agent-loop.test.ts` (1336-1415) — Les deux tests existants sur `disallowedTools` : « passes per-phase disallowedTools based on toolsMode » (l.1336-1385, couvre read_only + none) et « disallowedTools only blocks nested-agent tools in full mode » (l.1387-1415, couvre full).

**Interfaces :**
- Consomme : Déjà présents dans le dépôt, inchangés : `function disallowedForMode(toolsMode: "read_only" | "full" | "none"): string[]` (src/agent-loop/agent-loop.ts l.291) ; `SendOptions.disallowedTools?: string[]` (src/agent-loop/claude-stream.ts l.80) ; `const WRITE_USER_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit"]` (agent-loop.ts l.271).
- Produit : `const ALWAYS_BLOCKED_TOOLS: readonly string[] = ["Task", "Agent", "AskUserQuestion"]` remplace `NESTED_AGENT_TOOLS` (module-local, non exporté — aucun autre fichier ne peut l'importer). `ALL_USER_TOOLS` conserve son type `readonly string[]` et passe de 15 à 16 entrées avec l'ajout de "AskUserQuestion". La signature de `disallowedForMode` est strictement inchangée : `(toolsMode: "read_only" | "full" | "none") => string[]`, et ses quatre sites d'appel (agent-loop.ts l.868, 912, 941, 1071) n'ont rien à modifier.

**Contexte nécessaire :**

essaim lance N agents Claude Code en parallèle sur des worktrees git, sans aucun humain devant l'écran. Chaque agent tourne en trois phases : `discover` (toolsMode `read_only`), `review` (toolsMode `none`), `execute` (toolsMode `full`, boucle de work-stealing où l'agent réclame une tâche, la fait, la rend).

L'orchestrateur pose en dur `--dangerously-skip-permissions` sur le CLI Claude Code (`src/agent-loop/claude-stream.ts` l.186 : `if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");`). Ce drapeau rend `--allowedTools` purement indicatif : tout outil qui n'aurait besoin que d'une permission est auto-approuvé. La seule barrière qui mord encore est `--disallowedTools`, une liste de deny explicite. C'est exactement ce que construit `disallowedForMode` dans `src/agent-loop/agent-loop.ts`, dont le résultat part dans `send({ ..., disallowedTools: phaseBlocked })` aux quatre sites d'appel (l.868, 912, 941, 1071).

État vérifié de `disallowedForMode` (l.291-299) — quel tableau couvre quel mode :
- `full` → `[...NESTED_AGENT_TOOLS]` (l.295)
- `none` → `[...ALL_USER_TOOLS]` (l.296)
- `read_only` → `[...WRITE_USER_TOOLS, ...NESTED_AGENT_TOOLS]` (l.298)

Donc `NESTED_AGENT_TOOLS` couvre `full` ET `read_only` ; `ALL_USER_TOOLS` couvre uniquement `none`. Il faut la chaîne dans les DEUX tableaux pour couvrir les trois modes.

Le contenu exact aujourd'hui : `ALL_USER_TOOLS` (l.266-270) contient Read, Write, Edit, Bash, Glob, Grep, NotebookEdit, WebFetch, WebSearch, Task, Agent, TodoWrite, ExitPlanMode, Skill, ToolSearch — 15 entrées. `NESTED_AGENT_TOOLS` (l.276) vaut exactement `["Task", "Agent"]`. `WRITE_USER_TOOLS` (l.271) vaut `["Write", "Edit", "NotebookEdit"]`.

Le bug : `AskUserQuestion` — le built-in de Claude Code qui pose une question à choix multiples et *attend une réponse humaine* — n'apparaît nulle part. `git grep AskUserQuestion` sur les fichiers suivis rend zéro occurrence (sortie 1). Il n'est ni autorisé ni interdit : le système l'ignore.

Le point non évident, et c'est ce qui rend le bug réel : `--dangerously-skip-permissions` N'AUTORISE PAS cet outil. La branche `requiresUserInteraction` du binaire est évaluée AVANT la branche du bypass, donc le drapeau ne le débloque jamais — mais il ne le bloque pas non plus. Seule une règle de deny mord. Conséquence : un agent headless qui appelle `AskUserQuestion` reste suspendu, sa tâche toujours réclamée donc invisible pour les autres agents du run, jusqu'au deadline.

Le renommage : une fois `AskUserQuestion` ajouté, `NESTED_AGENT_TOOLS` vaudra `["Task", "Agent", "AskUserQuestion"]` et son nom ment. Ce tableau est en réalité « ce qui est bloqué dans tous les modes ». Il a exactement 4 occurrences dans les fichiers suivis, toutes dans `src/agent-loop/agent-loop.ts` (l.276 déclaration, l.294 commentaire, l.295, l.298) — vérifié par `git grep NESTED_AGENT`, aucune dans les tests ni la doc. Le nouveau nom retenu : `ALWAYS_BLOCKED_TOOLS`.

Aucun test n'assied d'égalité stricte ni de longueur sur ces listes (`git grep disallowedTools -- tests` : seulement `toContain` et `arrayContaining`), donc l'ajout est additif et ne casse rien.

**Pourquoi le test discrimine :** Sans le patch, la chaîne « AskUserQuestion » n'existe nulle part dans le dépôt (`git grep AskUserQuestion` sort avec le code 1), donc les trois `toContain("AskUserQuestion")` — un par mode : `read_only` via `discoverBlocked`, `none` via `reviewBlocked`, `full` via l'`arrayContaining` — échouent nécessairement, et le seul moyen de les faire passer est d'ajouter la chaîne aux deux tableaux que `disallowedForMode` combine.

- [ ] **Étape 1 : Écrire les assertions rouges dans tests/unit/agent-loop.test.ts**

Trois modifications dans ce fichier.

(a) Dans le test « passes per-phase disallowedTools based on toolsMode », remplacer le bloc l.1369-1384 :

```ts
    // discover (read_only): block write tools
    const discoverBlocked = mockSend.mock.calls[0][1].disallowedTools;
    expect(discoverBlocked).toContain("Write");
    expect(discoverBlocked).toContain("Edit");
    expect(discoverBlocked).toContain("NotebookEdit");
    expect(discoverBlocked).not.toContain("Read");
    expect(discoverBlocked).not.toContain("Bash");

    // review (none): block ALL user-facing tools
    const reviewBlocked = mockSend.mock.calls[1][1].disallowedTools;
    expect(reviewBlocked).toContain("Read");
    expect(reviewBlocked).toContain("Bash");
    expect(reviewBlocked).toContain("Grep");
    expect(reviewBlocked).toContain("Edit");
    expect(reviewBlocked).toContain("Write");
    expect(reviewBlocked).toContain("Skill");  // meta tool also blocked
```

par :

```ts
    // discover (read_only): block write tools
    const discoverBlocked = mockSend.mock.calls[0][1].disallowedTools;
    expect(discoverBlocked).toContain("Write");
    expect(discoverBlocked).toContain("Edit");
    expect(discoverBlocked).toContain("NotebookEdit");
    expect(discoverBlocked).not.toContain("Read");
    expect(discoverBlocked).not.toContain("Bash");
    // AskUserQuestion attend une réponse humaine qu'un run headless n'a pas,
    // et --dangerously-skip-permissions ne l'auto-approuve pas : seule une
    // règle de deny empêche l'agent de rester suspendu, tâche réclamée.
    expect(discoverBlocked).toContain("AskUserQuestion");

    // review (none): block ALL user-facing tools
    const reviewBlocked = mockSend.mock.calls[1][1].disallowedTools;
    expect(reviewBlocked).toContain("Read");
    expect(reviewBlocked).toContain("Bash");
    expect(reviewBlocked).toContain("Grep");
    expect(reviewBlocked).toContain("Edit");
    expect(reviewBlocked).toContain("Write");
    expect(reviewBlocked).toContain("Skill");  // meta tool also blocked
    expect(reviewBlocked).toContain("AskUserQuestion");
```

(b) Renommer le titre du second test, l.1387 :

```ts
  it("disallowedTools only blocks nested-agent tools in full mode", async () => {
```

devient :

```ts
  it("disallowedTools blocks nested-agent and human-interaction tools in full mode", async () => {
```

(c) Dans ce même test, remplacer le bloc l.1409-1414 :

```ts
    // Nested-agent tools (Task / Agent) stay blocked even in full mode — they
    // spawn sub-sessions whose tool calls escape the outer turn budget.
    const blocked = mockSend.mock.calls[0][1].disallowedTools;
    expect(blocked).toEqual(expect.arrayContaining(["Task", "Agent"]));
    expect(blocked).not.toContain("Read");
    expect(blocked).not.toContain("Edit");
```

par :

```ts
    // Task / Agent spawn sub-sessions whose tool calls escape the outer turn
    // budget; AskUserQuestion hangs the turn on a human who isn't there.
    // Both stay blocked even in full mode — the permission bypass grants
    // neither, and only the deny list actually stops AskUserQuestion.
    const blocked = mockSend.mock.calls[0][1].disallowedTools;
    expect(blocked).toEqual(expect.arrayContaining(["Task", "Agent", "AskUserQuestion"]));
    expect(blocked).not.toContain("Read");
    expect(blocked).not.toContain("Edit");
```

- [ ] **Étape 2 : Vérifier le rouge**

Lancer :

```
npx vitest run tests/unit/agent-loop.test.ts
```

Attendu : exactement 2 tests en échec, tous les autres du fichier verts.

- « passes per-phase disallowedTools based on toolsMode » : `AssertionError: expected [ 'Write', 'Edit', 'NotebookEdit', 'Task', 'Agent' ] to include 'AskUserQuestion'` (la première des deux nouvelles assertions, sur `discoverBlocked`).
- « disallowedTools blocks nested-agent and human-interaction tools in full mode » : échec de `arrayContaining`, le tableau reçu étant `[ 'Task', 'Agent' ]`.

Si les tests passent au vert à cette étape, arrêter : c'est que le patch a déjà été appliqué, ou que la source lue n'est pas celle qui tourne.

- [ ] **Étape 3 : Patcher src/agent-loop/agent-loop.ts (tableaux + renommage + disallowedForMode)**

Une seule modification atomique : le renommage doit toucher les 4 occurrences en même temps, sinon `tsc` casse.

(a) Remplacer le bloc l.261-276 :

```ts
// Claude Code built-in tools that could be invoked even when not in
// --allowedTools. Used to build explicit --disallowedTools lists for modes
// that need hard blocks (since --dangerously-skip-permissions auto-approves
// every tool regardless of --allowedTools). Includes common user-facing and
// meta tools; MCP tools are never blocked.
const ALL_USER_TOOLS: readonly string[] = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "NotebookEdit", "WebFetch", "WebSearch",
  "Task", "Agent", "TodoWrite", "ExitPlanMode", "Skill", "ToolSearch",
];
const WRITE_USER_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit"];
// Spawning sub-agents from inside a work-stealing task multiplies cost/latency:
// each Agent call is another Claude session running its own tool loop, invisible
// in the outer turn count. We always block it — the work-stealing task itself
// is already an agent, nested agents just explode the budget.
const NESTED_AGENT_TOOLS: readonly string[] = ["Task", "Agent"];
```

par :

```ts
// Claude Code built-in tools that could be invoked even when not in
// --allowedTools. Used to build explicit --disallowedTools lists for modes
// that need hard blocks (--dangerously-skip-permissions auto-approves every
// permission-gated tool, which makes --allowedTools advisory). Includes
// common user-facing and meta tools; MCP tools are never blocked.
const ALL_USER_TOOLS: readonly string[] = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "NotebookEdit", "WebFetch", "WebSearch",
  "Task", "Agent", "TodoWrite", "ExitPlanMode", "Skill", "ToolSearch",
  "AskUserQuestion",
];
const WRITE_USER_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit"];
// Blocked in EVERY mode, full included.
// - Task/Agent: spawning sub-agents from inside a work-stealing task multiplies
//   cost/latency — each Agent call is another Claude session running its own
//   tool loop, invisible in the outer turn count. The work-stealing task is
//   already an agent; nested agents just explode the budget.
// - AskUserQuestion: it blocks on a human answering, and a headless run has no
//   human. --dangerously-skip-permissions does NOT auto-approve it (the
//   requiresUserInteraction branch is evaluated before the bypass), so a deny
//   rule is the only thing that stops the agent from hanging with its task
//   still claimed until the run deadline.
const ALWAYS_BLOCKED_TOOLS: readonly string[] = ["Task", "Agent", "AskUserQuestion"];
```

(b) Remplacer `disallowedForMode`, actuellement l.291-299 :

```ts
function disallowedForMode(
  toolsMode: "read_only" | "full" | "none",
): string[] {
  // Nested agents are blocked in every mode — see NESTED_AGENT_TOOLS comment.
  if (toolsMode === "full") return [...NESTED_AGENT_TOOLS];
  if (toolsMode === "none") return [...ALL_USER_TOOLS];
  // read_only: block write tools explicitly + nested agents
  return [...WRITE_USER_TOOLS, ...NESTED_AGENT_TOOLS];
}
```

par :

```ts
function disallowedForMode(
  toolsMode: "read_only" | "full" | "none",
): string[] {
  // Nested agents + AskUserQuestion are blocked in every mode — see the
  // ALWAYS_BLOCKED_TOOLS comment.
  if (toolsMode === "full") return [...ALWAYS_BLOCKED_TOOLS];
  if (toolsMode === "none") return [...ALL_USER_TOOLS];
  // read_only: block write tools explicitly + the always-blocked ones
  return [...WRITE_USER_TOOLS, ...ALWAYS_BLOCKED_TOOLS];
}
```

(Aucun doublon à craindre pour `none` : `ALL_USER_TOOLS` contenait déjà Task et Agent, et gagne maintenant AskUserQuestion.)

- [ ] **Étape 4 : Vérifier le vert et l'absence de reliquat du renommage**

```
npx vitest run tests/unit/agent-loop.test.ts
```

Attendu : tout le fichier vert, les deux tests de l'étape 2 inclus.

Puis confirmer que le renommage est complet — la commande doit ne rien afficher :

```
git grep -n NESTED_AGENT
```

Attendu : aucune sortie (code de retour 1). Si une ligne sort, c'est une occurrence oubliée.

Et confirmer que la nouvelle constante est bien référencée aux 3 endroits attendus :

```
git grep -n ALWAYS_BLOCKED_TOOLS
```

Attendu : 4 lignes dans `src/agent-loop/agent-loop.ts` — la déclaration, la mention dans le commentaire de `disallowedForMode`, et les deux `return` (branches `full` et `read_only`).

- [ ] **Étape 5 : Corriger les deux commentaires faux de src/agent-loop/claude-stream.ts**

Ces deux commentaires affirment que le bypass accorde *tous* les outils. C'est faux pour `AskUserQuestion`, et c'est précisément ce qui a fait croire que le deny était superflu.

(a) Remplacer l.76-79 (dans l'interface `SendOptions`) :

```ts
  // Explicit block list — bypasses the pre-approval loophole where
  // --dangerously-skip-permissions effectively grants every tool regardless
  // of what --allowedTools contains. Use this to strictly forbid tool names
  // for restricted phases (e.g. review phase = no Read/Bash/Edit).
```

par :

```ts
  // Explicit block list — bypasses the pre-approval loophole where
  // --dangerously-skip-permissions effectively grants every permission-gated
  // tool regardless of what --allowedTools contains, and is the only lever
  // against tools that require a human (AskUserQuestion), which the bypass
  // never grants either. Use this to strictly forbid tool names for
  // restricted phases (e.g. review phase = no Read/Bash/Edit).
```

(b) Remplacer l.176-178 (dans la construction des arguments CLI) :

```ts
  // Per-send disallowedTools is the only reliable way to block tools when
  // --dangerously-skip-permissions is set (that flag auto-approves every
  // tool, making --allowedTools effectively advisory).
```

par :

```ts
  // Per-send disallowedTools is the only reliable way to block tools when
  // --dangerously-skip-permissions is set: that flag auto-approves every tool
  // that merely needs a permission, making --allowedTools advisory. It does
  // NOT cover tools requiring a human (AskUserQuestion) — those are checked
  // before the bypass branch, so only a deny rule stops them.
```

Aucune ligne de code n'est touchée dans ce fichier.

- [ ] **Étape 6 : Suite complète + build**

```
pnpm test
pnpm build
```

Attendu : suite vitest entièrement verte (les tests de `tests/unit/claude-stream.test.ts` l.146-176 sur `--disallowedTools` ne touchent que des listes passées explicitement, ils sont indifférents au changement), et `tsc` sans erreur — c'est `pnpm build` qui rattraperait une occurrence de `NESTED_AGENT_TOOLS` oubliée à l'étape 3.

- [ ] **Étape 7 : Commit**

```
git add src/agent-loop/agent-loop.ts src/agent-loop/claude-stream.ts tests/unit/agent-loop.test.ts
git commit -m "fix(agent-loop): AskUserQuestion pouvait suspendre un agent headless jusqu'au deadline"
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**COUVERTURE INCOMPLÈTE — l'objectif « aucun agent headless ne peut se suspendre » est faux après le patch. `disallowedForMode` n'alimente QUE les 5 envois de phase (agent-loop.ts l.870, 917, 943, 1073, 1118). Cinq autres `send()` de la MÊME session, avec le même `--dangerously-skip-permissions`, ne passent AUCUNE option et gardent donc AskUserQuestion ouvert : coordination l.729 (`const resp = await send(` / `formatCoordinationContext(...)`), l.757 (`const respondResp = await send(\`Réponds au thread ${action.threadId}:\n${action.context}\`);`), l.770 (`const summaryResp = await send(`), et surtout le MODE ONE-SHOT l.1212 (`const initialResp = await send(config.prompt);`) et l.1233 (`const resp = await send("Continue. Prochaine action?");`) — la branche `else` du `if (config.phases && config.phases.length > 0)` de la l.823, commentée `// ── ONE-SHOT MODE (backward compat) ──` l.1210. C'est le chemin de tout preset sans behavior phasé (CLAUDE.md : « A preset with no phased behavior runs one-shot »), lancé lui aussi par `launchAgentLoop` avec `dangerouslySkipPermissions: true` (src/orchestrator/agent-launcher.ts l.177). Le patron des 5 étapes patche la donnée au lieu du point de passage : les 10 envois traversent tous le wrapper `send` de agent-loop.ts l.553-555.**

REMPLACER INTÉGRALEMENT L'ÉTAPE 3 par un seul garde dans le wrapper partagé. Dans src/agent-loop/agent-loop.ts, remplacer les lignes 553-555 :

```ts
  async function send(content: string, opts?: SendOptions): Promise<AssistantResponse> {
    logger.info(`Sending to claude (${content.length} chars): ${content.slice(0, 80)}...`);
    const resp = await claude.send(content, opts);
```

par :

```ts
  async function send(content: string, opts?: SendOptions): Promise<AssistantResponse> {
    logger.info(`Sending to claude (${content.length} chars): ${content.slice(0, 80)}...`);
    // AskUserQuestion attend une réponse humaine ; un run headless n'en a pas.
    // Le binaire renvoie "ask" sur requiresUserInteraction() AVANT d'évaluer
    // bypassPermissions : --dangerously-skip-permissions ne le débloque donc
    // jamais, mais ne le bloque pas non plus — seule une règle de deny mord.
    // Le merge se fait ici, pas dans disallowedForMode(), parce que la moitié
    // des envois de cette session ne passent aucune option : coordination
    // (l.729, 757, 770) et mode one-shot (l.1212, 1233).
    const blocked = new Set(opts?.disallowedTools ?? []);
    blocked.add("AskUserQuestion");
    const resp = await claude.send(content, { ...opts, disallowedTools: [...blocked] });
```

Toutes les propriétés de `SendOptions` (claude-stream.ts l.71-86) étant optionnelles, `{ ...opts, disallowedTools: [...blocked] }` est assignable à `SendOptions` même quand `opts` est `undefined` — compile en `strict`.

Avec ce garde, `ALL_USER_TOOLS`, `NESTED_AGENT_TOOLS` et `disallowedForMode` restent inchangés : plus de renommage à 4 sites, le risque n°1 du plan disparaît, et les trois assertions de l'étape 1 passent quand même au vert — read_only donne ["Write","Edit","NotebookEdit","Task","Agent","AskUserQuestion"], none donne les 15 de ALL_USER_TOOLS + "AskUserQuestion", full donne ["Task","Agent","AskUserQuestion"].

Non-régression vérifiée : aucun test n'utilise `expect(mockSend).toHaveBeenCalledWith(...)` ni une égalité stricte du 2ᵉ argument — uniquement `toMatchObject` (tests/unit/agent-loop.test.ts l.1040, 1210, 1271) et des lectures de propriété (l.1242, 1318, 1329, 1370, 1378, 1411, 1608). Ajouter la clé `disallowedTools` aux envois qui n'en avaient pas ne casse donc rien.

**La seconde session Claude n'est couverte par aucune des deux approches : `interruptClaude`, créé agent-loop.ts l.466-473 avec `dangerouslySkipPermissions: config.dangerouslySkipPermissions` (l.471), envoie l.684 `await interruptClaude.send(formatted, { maxTurns: 1 });` sans passer par le wrapper `send`. AskUserQuestion y reste disponible.**

Dans src/agent-loop/agent-loop.ts, remplacer la ligne 684 :

```ts
    await interruptClaude.send(formatted, { maxTurns: 1 });
```

par :

```ts
    await interruptClaude.send(formatted, { maxTurns: 1, disallowedTools: ["AskUserQuestion"] });
```

**L'étape 4 et deux items de `risques` ne survivent pas à la correction ci-dessus : `git grep -n NESTED_AGENT` et `git grep -n ALWAYS_BLOCKED_TOOLS` n'ont plus d'objet (aucun renommage), et l'item de risque « les compteurs du log changent : blocked= passe de 2 à 3 / 5 à 6 / 15 à 16 (l.869, 913, 942) » devient faux — ces trois `logger.info` lisent `phaseBlocked.length` / `reviewBlocked.length` / `otherBlocked.length` AVANT le merge du wrapper, donc les compteurs restent à 2, 5 et 15.**

Étape 4 réécrite :

```
npx vitest run tests/unit/agent-loop.test.ts
```

Attendu : tout le fichier vert, les deux tests de l'étape 2 inclus.

Puis vérifier que les DEUX points de deny existent, et seulement eux :

```
git grep -n 'AskUserQuestion"' -- src
```

Attendu : exactement 2 lignes, toutes deux dans `src/agent-loop/agent-loop.ts` — le `blocked.add("AskUserQuestion");` du wrapper `send` et le `disallowedTools: ["AskUserQuestion"]` de l'envoi d'interrupts. (Les commentaires de l'étape 5 écrivent `(AskUserQuestion)` sans guillemet et ne matchent pas ce motif.)

Et supprimer l'item de `risques` sur les compteurs `blocked=` : le merge est fait après la construction du log, les valeurs 2 / 5 / 15 ne bougent pas.

**Risques :**
- Renommage incomplet de NESTED_AGENT_TOOLS → ALWAYS_BLOCKED_TOOLS : il y a exactement 4 occurrences, toutes dans src/agent-loop/agent-loop.ts (l.276, 294, 295, 298) et aucune ailleurs dans les fichiers suivis. Une oubliée casse `pnpm build` avec « Cannot find name 'NESTED_AGENT_TOOLS' ». Se voit par `git grep -n NESTED_AGENT` (doit ne rien rendre) et par `pnpm build`.
- Le CLI Claude Code reçoit un nom d'outil de plus dans --disallowedTools. Les règles de deny sont des noms littéraux : un nom inconnu du binaire ne matche simplement jamais, il n'y a pas d'erreur de parsing. Aucun effet si la version installée ne connaît pas AskUserQuestion.
- Les compteurs du log changent : `blocked=` passe de 2 à 3 en mode full, de 5 à 6 en read_only, de 15 à 16 en none (src/agent-loop/agent-loop.ts l.869, 913, 942). Aucun test n'assied sur ces nombres (`git grep 'blocked=' -- tests` ne rend rien), mais un dashboard ou un parseur de logs externe qui les surveillerait verrait un saut ponctuel.
- Un agent en mode full ne pourra plus poser de question interactive — c'est l'effet recherché, mais si un preset comptait dessus pour lever une ambiguïté, il recevra désormais une erreur de permission au lieu d'attendre. Se voit dans le contenu de la réponse du tour, pas dans un test.


---

### Tâche 5 : Capter system/compact_boundary dans le parseur de flux et le remonter jusqu'à TurnDetail

**Objectif :** Faire compter au parseur de flux les événements de compaction de contexte émis par le CLI Claude, et exposer ce compteur (+ tokens avant/après) sur `AssistantResponse` puis sur `TurnDetail`, pour qu'un `error_max_turns` cesse d'être un diagnostic ambigu.

**Fichiers :**
- Modifier : `src/agent-loop/claude-stream.ts` (42, 52, 105, 117, 293, 309, 349-364) — Parseur du flux NDJSON du CLI Claude. Contient l'union `StreamEvent`, l'interface `AssistantResponse`, le handler d'événements et le `resolve(...)` qui clôt un tour.
- Modifier : `src/agent-loop/agent-loop.ts` (1, 93, 561, 589, 594-600) — Boucle de tours d'un agent. Contient `TurnDetail` (lignes 82-94) et la fonction `send()` qui accumule les métriques par tour (lignes 553-601).
- Test : `tests/unit/claude-stream.test.ts` (559-560) — Tests du parseur. Le describe `createClaudeStream (spawn-per-turn)` (ligne 332) mocke `child_process.spawn` et pousse du NDJSON dans `child.stdout` — c'est le patron à suivre pour injecter un faux événement de compaction.
- Test : `tests/unit/agent-loop.test.ts` (184-186) — Tests de la boucle. Mocke `claude-stream.js` entier via `vi.mock` et pilote les réponses par `mockSend`. Fournit `makeConfig()` (ligne 117) et `silentLogger` (ligne 110).
- Modifier : `src/agent-loop/effort.ts` (27-32) — LECTURE SEULE — à lire, pas à toucher. Contient le commentaire « 21 error_max_turns pour 19 tâches abandonnées » qui motive tout ce patch.

**Interfaces :**
- Consomme : Depuis src/agent-loop/claude-stream.ts (existant, non modifié dans sa signature) : `export function createClaudeStream(options: ClaudeStreamOptions): ClaudeStreamClient`, `interface ClaudeStreamClient { send(content: string, opts?: SendOptions): Promise<AssistantResponse>; close(): void; isAlive(): boolean; readonly sessionId: string | null }`, `export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }`, `export function createStreamParser(emitter: EventEmitter, readable: NodeJS.ReadableStream): void`, `AssistantResponse.subtype?: string`. Depuis src/logger.ts : `createLogger(component: string): Logger` avec `warn(msg: string, data?: Record<string, unknown>): void`. Depuis src/agent-loop/effort.ts (lecture seule) : `EFFORT_PROFILES: Record<ConcreteEffortLevel, EffortProfile>`. Depuis src/agent-loop/agent-loop.ts : `interface AgentLoopResult { ...; turnDetails: TurnDetail[] }`, `runAgentLoop(config: AgentLoopConfig, logger?: AgentLoopLogger): Promise<AgentLoopResult>`.
- Produit : Dans src/agent-loop/claude-stream.ts : `export interface CompactionInfo { count: number; preTokens: number; postTokens: number }` ; nouveau champ REQUIS `AssistantResponse.compaction: CompactionInfo` (toujours renseigné par le parseur, `{ count: 0, preTokens: 0, postTokens: 0 }` par défaut) ; nouveau membre de l'union `StreamEvent` : `{ type: "system"; subtype: "compact_boundary"; [k: string]: unknown }` ; fonction interne NON exportée `readCompactTokens(event: Record<string, unknown>): { pre: number; post: number }`. Dans src/agent-loop/agent-loop.ts : trois nouveaux champs REQUIS sur `TurnDetail` — `compactions: number`, `compactionPreTokens: number`, `compactionPostTokens: number` — donc lisibles depuis `AgentLoopResult.turnDetails[]` par toute tâche ultérieure (rapport de tokens, heuristique d'effort, tableau de bord).

**Contexte nécessaire :**

Ce dépôt (essaim) est un orchestrateur qui lance N agents Claude Code sur des worktrees git. Chaque « tour » d'agent est un processus `claude -p --output-format stream-json` séparé : `src/agent-loop/claude-stream.ts` le spawn, parse le NDJSON qui sort de stdout, et résout une `AssistantResponse` quand l'événement `{"type":"result",...}` arrive. Le parseur ne connaît qu'une poignée de types d'événements, énumérés dans l'union `StreamEvent` (lignes 104-111) : `system/init`, `system/hook_started`, `system/hook_response`, `assistant`, `rate_limit_event`, `result/success`, `result/error_max_budget_usd`. Le handler d'événements (lignes 297-367) est une chaîne de `if` : tout événement qui ne matche aucune branche tombe silencieusement du bas de la fonction — pas de `else`, pas même un `log.debug`. Un `grep -rn "compact" src/ cli/ tests/` rend actuellement zéro ligne : l'événement `system/compact_boundary`, que le CLI émet quand il compacte la fenêtre de contexte, est purement et simplement perdu.

Pourquoi ça compte : quand un agent finit un envoi sans avoir écrit son marqueur `DONE:`, la boucle de work-stealing abandonne la tâche et la déréclame (`src/agent-loop/agent-loop.ts` lignes 1126 et 1179). Le seul indice journalisé est `resp.subtype`, et `error_max_turns` y est un état terminal AMBIGU. Deux causes, deux remèdes OPPOSÉS : soit le plafond de tours était trop bas (remède : monter `maxTurns`), soit le contexte a débordé et a été compacté, ce qui a fait perdre à l'agent le fil de sa tâche (remède : DESCENDRE `maxTurns`, car monter le plafond ne fait que remplir la fenêtre plus vite et faire payer deux compactions pour le même abandon). Le dépôt a déjà tranché à l'aveugle sur cette base : `src/agent-loop/effort.ts` lignes 27-32 documente « sur un raid mesuré, 21 `error_max_turns` pour 19 tâches abandonnées — c'est le plafond, pas la qualité de l'agent, qui causait l'abandon », et a doublé `maxTurns` du profil `mid` de 8 à 16. Ce chiffre de 21 n'est pas qualifié : on ignore combien de ces abandons avaient vu une compaction. Ce patch produit exactement la donnée manquante.

CONTRAINTE MAJEURE, à intégrer dans la conception : la forme exacte du payload de `compact_boundary` n'est PAS vérifiable depuis ce dépôt. `node_modules/@anthropic-ai/` ne contient qu'un seul paquet, `sdk` en version 0.30.1 — le client HTTP de l'API Anthropic, pas les types du flux du CLI. Un `grep -rn "compact" node_modules/@anthropic-ai/` rend zéro. La lecture du payload doit donc être écrite en DÉFENSIF : champs optionnels, coercition explicite en nombre, `?? 0` / `|| 0` partout, aucune exception possible si la forme diffère de ce qu'on suppose. La forme supposée ici est `{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":N,"post_tokens":M}}`, avec tolérance des mêmes clés à la racine de l'événement. Le compteur d'occurrences (`count`) doit rester juste même si la forme du payload est totalement inconnue : on compte l'événement, et seuls ses tokens restent à 0.

Deux détails de plomberie à ne pas rater. (1) `src/agent-loop/agent-loop.ts` lit déjà `resp.tokens` de façon défensive à la ligne 561 (`const t: TokenUsage = resp.tokens ?? { ... }`) alors que `tokens` est un champ REQUIS de `AssistantResponse` — ce n'est pas de la paranoïa gratuite : les mocks de `tests/unit/agent-loop.test.ts` montent des réponses partielles sans ce champ (voir lignes 168-174). Le nouveau champ `compaction` doit être lu avec exactement la même prudence, sinon chacun des ~20 `mockSend.mockResolvedValue({...})` existants fait planter la boucle sur un accès à `undefined`. (2) `tsconfig.json` a `"include": ["src/**/*.ts", "cli/**/*.ts", "tests/**/*.ts"]` : `pnpm build` type-check aussi les tests. Il échouera donc pendant la phase rouge du TDD, c'est normal et attendu — on ne lance `pnpm build` qu'après le patch.

Enfin : `TurnDetail` (`src/agent-loop/agent-loop.ts` lignes 82-94) est une structure plate (`inputTokens`, `outputTokens`, `cacheReadTokens`…) accumulée dans `turnDetails[]` et renvoyée dans `AgentLoopResult`. Aucun autre fichier ne la consomme — `grep -rn "turnDetails" src/ cli/ tests/` ne trouve, hors `agent-loop.ts`, qu'un `turnDetails: []` dans `tests/unit/orchestrator-run.test.ts` ligne 97. Y ajouter des champs est donc purement additif.

**Pourquoi le test discrimine :** Sans le patch, `system/compact_boundary` ne matche aucune branche du handler et tombe silencieusement du bas de la fonction, donc `AssistantResponse` n'a aucun champ `compaction` et `expect(resp.compaction).toEqual({ count: 2, preTokens: 298000, postTokens: 82000 })` échoue sur `expected undefined` — aucune autre modification du parseur ne peut faire remonter ce compteur.

- [ ] **Étape 1 : Lire le commentaire qui motive le patch (aucune modification)**

Ouvre `C:/Users/gagno/projet/essaim-new/src/agent-loop/effort.ts` et lis les lignes 22-36 en entier. Tu dois y trouver exactement ceci :

```ts
export const EFFORT_PROFILES: Record<ConcreteEffortLevel, EffortProfile> = {
  // maxTurns needs headroom when thinking is enabled — thinking tokens count
  // against the turn limit, and with tools in the loop a "turn" can burn
  // multiple explorations before the model even attempts to synthesise text.
  low:  { model: "claude-haiku-4-5-20251001", thinking: "none",       maxTurns: 15 },
  // 8 → 16 : sur un raid mesuré, 21 `error_max_turns` pour 19 tâches
  // abandonnées — c'est le plafond, pas la qualité de l'agent, qui causait
  // l'abandon. On DOUBLE sans aller plus loin : à ~3,9 min pour 8 tours, un
  // mid à 25 produirait un envoi de ~12 min contre un timeout de run par
  // défaut de 15 min (orchestrator.ts), donc une mort par deadline en pleine
  // tâche — l'état le plus destructeur, puisqu'il la laisse réclamée.
  mid:  { model: "claude-sonnet-4-6",         thinking: "think",      maxTurns: 16 },
  high: { model: "claude-opus-4-6",           thinking: "think-hard", maxTurns: 20 },
  max:  { model: "claude-opus-4-6",           thinking: "ultrathink", maxTurns: 60 },
};
```

Retiens : le doublement de `mid` (8 → 16) repose sur l'hypothèse « c'est le plafond, pas la fenêtre de contexte ». Rien dans le dépôt ne permet aujourd'hui de vérifier cette hypothèse. C'est ce que le patch corrige. Ne modifie PAS ce fichier.

- [ ] **Étape 2 : Écrire les trois tests rouges du parseur**

Dans `C:/Users/gagno/projet/essaim-new/tests/unit/claude-stream.test.ts`, insère les trois tests ci-dessous à la fin du describe `createClaudeStream (spawn-per-turn)` : juste APRÈS le test `it("scrubs engine secrets from the env handed to the spawned claude child (buildChildEnv applied)", ...)` qui se termine ligne 559 par `  });`, et AVANT le `});` de fermeture du describe ligne 560.

```ts
  it("compte les compact_boundary et somme les tokens avant/après", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("long task");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"system","subtype":"init","session_id":"s-compact"}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":150000,"post_tokens":42000}}\n');
    child.stdout.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":148000,"post_tokens":40000}}\n');
    child.stdout.push('{"type":"result","subtype":"error_max_turns","cost_usd":0.05,"duration_ms":3000,"session_id":"s-compact"}\n');
    child.stdout.push(null);

    const resp = await p;
    expect(resp.compaction).toEqual({ count: 2, preTokens: 298000, postTokens: 82000 });
    // C'est la CONJONCTION qui lève l'ambiguïté : error_max_turns AVEC
    // compaction = fenêtre de contexte pleine, pas plafond de tours trop bas.
    expect(resp.subtype).toBe("error_max_turns");
    // Le contenu collecté avant la compaction n'est pas perdu.
    expect(resp.content).toBe("partial");

    client.close();
  });

  it("compte une compaction même quand le payload n'a pas la forme supposée", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("hello");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    // Trois formes hostiles : aucun metadata, metadata non-objet, tokens non-numériques.
    child.stdout.push('{"type":"system","subtype":"compact_boundary"}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":"pas-un-objet"}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":{"pre_tokens":"beaucoup","post_tokens":null}}\n');
    child.stdout.push('{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":100,"session_id":"s1"}\n');
    child.stdout.push(null);

    const resp = await p;
    // Le compteur reste juste quelle que soit la forme ; seuls les tokens tombent à 0.
    expect(resp.compaction).toEqual({ count: 3, preTokens: 0, postTokens: 0 });

    client.close();
  });

  it("expose compaction à zéro quand aucun compact_boundary n'arrive", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("court");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":100,"session_id":"s1"}\n');
    child.stdout.push(null);

    const resp = await p;
    // Champ toujours présent : l'appelant n'a jamais à tester undefined.
    expect(resp.compaction).toEqual({ count: 0, preTokens: 0, postTokens: 0 });

    client.close();
  });
```

- [ ] **Étape 3 : Vérifier que les trois tests sont ROUGES, et pour la bonne raison**

Lance exactement :

```
npx vitest run tests/unit/claude-stream.test.ts
```

Attendu : les trois nouveaux tests échouent, tous les autres passent. Les messages doivent ressembler à :

```
AssertionError: expected undefined to deeply equal { count: 2, preTokens: 298000, postTokens: 82000 }
AssertionError: expected undefined to deeply equal { count: 3, preTokens: 0, postTokens: 0 }
AssertionError: expected undefined to deeply equal { count: 0, preTokens: 0, postTokens: 0 }
```

Deux points de contrôle importants :
- Les tests DOIVENT échouer sur `expected undefined`, pas sur une exception. Si tu vois un `TypeError` ou un timeout, l'événement de compaction fait planter le handler et le diagnostic est différent — arrête-toi et relis le handler.
- Vitest passe par esbuild, qui n'exécute AUCUN type-check : `resp.compaction` sur un type qui n'a pas encore ce champ ne bloque pas l'exécution du test. C'est pour ça que l'échec est une assertion et non une erreur de compilation.

Ne lance PAS `pnpm build` à cette étape : `tsconfig.json` inclut `tests/**/*.ts`, donc `tsc` échouerait sur `Property 'compaction' does not exist on type 'AssistantResponse'`. C'est attendu tant que le patch n'est pas posé.

- [ ] **Étape 4 : Patcher claude-stream.ts — types (CompactionInfo, AssistantResponse, union StreamEvent)**

Trois insertions dans `C:/Users/gagno/projet/essaim-new/src/agent-loop/claude-stream.ts`.

**(a)** Juste APRÈS la fermeture de `interface TokenUsage` (le `}` de la ligne 42) et AVANT la ligne 44 `export interface AssistantResponse {`, insère :

```ts
/**
 * Compactions de contexte observées pendant UN envoi.
 *
 * C'est le signal qui lève l'ambiguïté de `error_max_turns`. Sans lui, un
 * abandon veut dire « plafond de tours trop bas » — remède : monter maxTurns.
 * Avec lui, il veut dire « la fenêtre de contexte a débordé », et le remède est
 * OPPOSÉ : DESCENDRE maxTurns, sinon on remplit la fenêtre plus vite et on paie
 * deux compactions pour le même abandon.
 *
 * Voir le commentaire de EFFORT_PROFILES.mid dans effort.ts : maxTurns y a été
 * DOUBLÉ (8 → 16) sur la foi de « 21 error_max_turns pour 19 tâches
 * abandonnées ». Ce compteur est ce qui permet enfin de qualifier ce 21.
 */
export interface CompactionInfo {
  /** Nombre d'événements system/compact_boundary reçus pendant l'envoi. */
  count: number;
  /** Somme des tokens de contexte AVANT compaction, tous événements confondus. */
  preTokens: number;
  /** Somme des tokens APRÈS compaction. 0 si le CLI ne publie pas ce champ. */
  postTokens: number;
}

```

**(b)** Dans `interface AssistantResponse`, juste APRÈS la ligne 52 `  tokens: TokenUsage;` et AVANT le bloc de commentaire `/**` qui documente `subtype`, insère :

```ts
  /**
   * Compactions subies pendant cet envoi. TOUJOURS présent — vaut
   * `{ count: 0, preTokens: 0, postTokens: 0 }` quand rien n'a été compacté,
   * pour que l'appelant n'ait jamais à tester undefined.
   */
  compaction: CompactionInfo;
```

**(c)** Dans l'union `StreamEvent`, juste APRÈS la ligne 105 (`  | { type: "system"; subtype: "init"; session_id?: string; [k: string]: unknown }`) et AVANT la ligne 106 (`  | { type: "system"; subtype: "hook_started"; [k: string]: unknown }`), insère :

```ts
  // Émis quand le CLI compacte la fenêtre de contexte. La forme du payload est
  // SUPPOSÉE (voir readCompactTokens) : d'où l'index signature plutôt que des
  // champs typés qu'on ne peut pas vérifier depuis ce dépôt.
  | { type: "system"; subtype: "compact_boundary"; [k: string]: unknown }
```

- [ ] **Étape 5 : Patcher claude-stream.ts — lecteur défensif, compteur, branche du handler, resolve**

Quatre modifications dans le même fichier.

**(a)** Juste APRÈS la ligne `const NOISE_SUBTYPES = new Set(["hook_started", "hook_response"]);` (ligne 117), insère :

```ts

/**
 * Lecture DÉFENSIVE du payload d'un compact_boundary.
 *
 * La forme exacte n'est PAS vérifiable depuis ce dépôt : node_modules ne
 * contient que @anthropic-ai/sdk (le client HTTP de l'API), jamais les types du
 * flux du CLI. On SUPPOSE `compact_metadata: { pre_tokens, post_tokens }` et on
 * tolère les mêmes clés à la racine de l'événement. Tout champ absent, non
 * numérique, null ou NaN vaut 0 — jamais une exception.
 *
 * Conséquence VOULUE : un événement de forme inconnue est quand même COMPTÉ par
 * l'appelant, seuls ses tokens restent à 0. Le compteur d'occurrences — la
 * moitié qui sert au diagnostic — reste juste quelle que soit la forme.
 */
function readCompactTokens(event: Record<string, unknown>): { pre: number; post: number } {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // `?? {}` couvre null/undefined ; un metadata non-objet (string, number)
  // donne simplement undefined sur ses propriétés, donc 0 après num().
  const meta = (event.compact_metadata ?? {}) as Record<string, unknown>;
  return {
    pre: num(meta.pre_tokens) || num(event.pre_tokens),
    post: num(meta.post_tokens) || num(event.post_tokens),
  };
}
```

**(b)** Dans `runOneTurn`, juste APRÈS la ligne 293 `    let firstEventLogged = false;`, insère :

```ts
    // Accumulé sur tout l'envoi : le CLI peut compacter plusieurs fois par tour.
    const compaction: CompactionInfo = { count: 0, preTokens: 0, postTokens: 0 };
```

**(c)** Dans le handler `emitter.on("event", ...)`, insère la branche ci-dessous juste AVANT la ligne 309 `      if (event.type === "system" && NOISE_SUBTYPES.has(event.subtype)) return;`. L'ordre compte : placée avant, elle ne peut jamais être avalée par un futur ajout à `NOISE_SUBTYPES`.

```ts
      if (event.type === "system" && event.subtype === "compact_boundary") {
        const { pre, post } = readCompactTokens(event as Record<string, unknown>);
        compaction.count++;
        compaction.preTokens += pre;
        compaction.postTokens += post;
        // warn et non debug : une compaction est l'explication la plus probable
        // d'un error_max_turns qui suit, et on veut la voir au niveau de log
        // par défaut (LOG_LEVEL=info).
        log.warn(`context compacted (#${compaction.count})`, { preTokens: pre, postTokens: post });
        return;
      }
```

**(d)** Remplace le bloc des lignes 349-364 (du `if (subtype !== "success") {` jusqu'au `});` fermant le `resolve`) par :

```ts
        if (subtype !== "success") {
          log.warn(`result with non-success subtype: ${subtype ?? "?"} — resolving with partial content`, { compactions: compaction.count });
        } else {
          log.info("turn complete", { durationMs: (eventRec.duration_ms as number) ?? 0, toolCalls: toolCalls.length, contentLength: content.length, rateLimited: isRateLimited, tokens, compactions: compaction.count });
        }
        resolve({
          content,
          toolCalls,
          costUsd: (eventRec.cost_usd as number) ?? 0,
          rateLimited: isRateLimited,
          rateLimitResetsAt,
          durationMs: (eventRec.duration_ms as number) ?? 0,
          sessionId: resultSessionId,
          tokens,
          // COPIE, pas la référence : le flush de fin de buffer (readable "end")
          // peut encore émettre un événement après le result, ce qui ferait
          // muter en douce un objet que l'appelant a déjà lu.
          compaction: { ...compaction },
          subtype,
        });
```

- [ ] **Étape 6 : Vérifier que les trois tests du parseur sont VERTS**

Lance exactement :

```
npx vitest run tests/unit/claude-stream.test.ts
```

Attendu : tous les tests du fichier passent, y compris les trois nouveaux. Le fichier comptait 30 tests avant, il en compte 33 maintenant.

Puis vérifie qu'aucun autre fichier n'a régressé :

```
pnpm test
```

Attendu : suite complète verte (`fileParallelism: false`, donc les fichiers passent en série).

- [ ] **Étape 7 : Commit du parseur**

```
git add src/agent-loop/claude-stream.ts tests/unit/claude-stream.test.ts
git commit -m "feat(stream): compter les compactions de contexte par envoi"
```

- [ ] **Étape 8 : Écrire les deux tests rouges de la boucle et vérifier le rouge**

Dans `C:/Users/gagno/projet/essaim-new/tests/unit/agent-loop.test.ts`, insère les deux tests ci-dessous dans le describe `runAgentLoop` : juste APRÈS le `});` de fermeture du test `it("completes when LLM says DONE on first turn", ...)` (ligne 184) et AVANT `it("iterates multiple turns until DONE", ...)` (ligne 186).

```ts
  it("reporte les compactions du tour dans turnDetails", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: patch posé",
      toolCalls: [],
      costUsd: 0.05,
      durationMs: 1000,
      sessionId: "s1",
      tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compaction: { count: 1, preTokens: 150000, postTokens: 42000 },
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.turnDetails).toHaveLength(1);
    expect(result.turnDetails[0]).toMatchObject({
      compactions: 1,
      compactionPreTokens: 150000,
      compactionPostTokens: 42000,
    });
  });

  it("un envoi sans champ compaction ne fait pas tomber la boucle", async () => {
    // Les ~20 mockSend existants de ce fichier montent des réponses partielles
    // sans `tokens` ni `compaction` : la lecture doit rester défensive.
    mockSend.mockResolvedValue({
      content: "DONE: ok",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("done");
    expect(result.turnDetails[0].compactions).toBe(0);
  });
```

Puis lance :

```
npx vitest run tests/unit/agent-loop.test.ts
```

Attendu : le premier nouveau test échoue avec `expected { turn: 1, phase: ..., contentLength: 16 } to match object { compactions: 1, ... }` (les trois clés sont absentes de l'objet reçu) ; le second échoue avec `expected undefined to be 0`. Tous les autres tests du fichier passent.

- [ ] **Étape 9 : Patcher agent-loop.ts — TurnDetail, lecture défensive, log**

Quatre modifications dans `C:/Users/gagno/projet/essaim-new/src/agent-loop/agent-loop.ts`.

**(a)** Ligne 1, ajoute `type CompactionInfo` à l'import existant. Remplace :

```ts
import { createClaudeStream, type ClaudeStreamClient, type AssistantResponse, type SendOptions, type TokenUsage, BudgetExceededError, AbortError } from "./claude-stream.js";
```

par :

```ts
import { createClaudeStream, type ClaudeStreamClient, type AssistantResponse, type SendOptions, type TokenUsage, type CompactionInfo, BudgetExceededError, AbortError } from "./claude-stream.js";
```

**(b)** Dans `interface TurnDetail`, juste APRÈS la ligne 93 `  contentLength: number;` et AVANT le `}` de la ligne 94, insère :

```ts
  // Compactions de contexte subies pendant ce tour. `compactions > 0` sur un
  // tour qui finit en error_max_turns veut dire « fenêtre de contexte pleine »,
  // pas « plafond de tours trop bas » — deux diagnostics aux remèdes opposés.
  compactions: number;
  compactionPreTokens: number;
  compactionPostTokens: number;
```

**(c)** Dans `send()`, juste APRÈS la ligne 561 (`const t: TokenUsage = resp.tokens ?? { ... };`), insère :

```ts
    // Même prudence que pour `tokens` juste au-dessus, et pour la même raison :
    // les tests de ce module montent des AssistantResponse partielles.
    const c: CompactionInfo = resp.compaction ?? { count: 0, preTokens: 0, postTokens: 0 };
```

**(d)** Dans le littéral `const detail: TurnDetail = {` (ligne 578), ajoute les trois champs juste APRÈS la ligne 589 `      contentLength: resp.content.length,` :

```ts
      compactions: c.count,
      compactionPreTokens: c.preTokens,
      compactionPostTokens: c.postTokens,
```

**(e)** Remplace le bloc `logger.info(...)` des lignes 594-600 par :

```ts
    // Suffixe conditionnel : n'apparaît que si le contexte a été compacté, pour
    // ne pas noyer la ligne de tour normale sous des zéros.
    const compactSuffix = c.count > 0
      ? ` compact=${c.count} (${formatTokens(c.preTokens)}→${formatTokens(c.postTokens)})`
      : "";

    logger.info(
      `Turn ${turnsCount} [${currentPhase}] ${model.split("-")[1] ?? model}: ` +
      `in=${formatTokens(t.inputTokens)} out=${formatTokens(t.outputTokens)} ` +
      `cache-r=${formatTokens(t.cacheReadTokens)} cache-w=${formatTokens(t.cacheCreationTokens)} ` +
      `hit=${cacheHitPct}% cost=$${resp.costUsd.toFixed(4)} ` +
      `(${resp.durationMs}ms, ${resp.toolCalls.length} tools)` + compactSuffix,
    );
```

- [ ] **Étape 10 : Vérifier le vert complet + build, puis commit**

Lance dans cet ordre :

```
npx vitest run tests/unit/agent-loop.test.ts
pnpm test
pnpm build
```

Attendu :
- Le fichier `agent-loop.test.ts` passe intégralement, les deux nouveaux tests inclus.
- `pnpm test` : suite complète verte, aucun autre fichier touché.
- `pnpm build` : `tsc` termine sans erreur. C'est cette commande qui valide que `CompactionInfo` est bien exporté, bien importé, et que `TurnDetail` est complètement renseigné partout où il est construit — esbuild ne l'aurait pas vu.

Puis :

```
git add src/agent-loop/agent-loop.ts tests/unit/agent-loop.test.ts
git commit -m "feat(agent-loop): exposer les compactions par tour dans turnDetails"
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**Étape 6 — compte de tests faux. La phrase « Le fichier comptait 30 tests avant, il en compte 33 maintenant. » est fausse : `tests/unit/claude-stream.test.ts` contient 37 `it(` (13 dans le describe `createClaudeStream (spawn-per-turn)` lignes 332-560, le reste dans `buildArgs` ligne 13 et `createStreamParser` ligne 225). Un développeur qui lit « 33 » et voit vitest afficher « 40 passed » croira avoir cassé ou dupliqué quelque chose.**

Remplacer la phrase par : « Attendu : tous les tests du fichier passent, y compris les trois nouveaux. Le fichier comptait 37 tests avant (13 dans le describe `createClaudeStream (spawn-per-turn)`), il en compte 40 maintenant (16 dans ce describe). »

**Étape 9 — l'en-tête annonce « Quatre modifications dans `C:/Users/gagno/projet/essaim-new/src/agent-loop/agent-loop.ts`. » alors que le corps liste cinq sous-étapes, (a) import, (b) TurnDetail, (c) lecture défensive, (d) champs du littéral `detail`, (e) `logger.info`. Un développeur qui s'arrête à quatre saute (e) : `compactSuffix` n'est jamais écrit, la ligne de log ne montre jamais les compactions, et l'instrumentation est à moitié posée. (Pour comparaison, les étapes 4 « Trois insertions » et 5 « Quatre modifications » sont, elles, exactes.)**

Remplacer la première ligne de l'étape 9 par : « Cinq modifications dans `C:/Users/gagno/projet/essaim-new/src/agent-loop/agent-loop.ts` — (a) l'import ligne 1, (b) `TurnDetail`, (c) la lecture défensive dans `send()`, (d) les trois champs du littéral `detail`, (e) le `logger.info` des lignes 594-600. La (e) n'est pas facultative : sans elle, `compactSuffix` n'existe pas et rien n'apparaît dans le log de tour. »

**Risques :**
- LA FORME DU PAYLOAD EST SUPPOSÉE, PAS VÉRIFIÉE. `{"compact_metadata":{"trigger":"auto","pre_tokens":N,"post_tokens":M}}` est une hypothèse : `node_modules/@anthropic-ai/` ne contient que `sdk@0.30.1` (le client HTTP de l'API), et `grep -rn "compact" node_modules/@anthropic-ai/` rend zéro. Si la forme réelle diffère, `count` reste juste mais `preTokens`/`postTokens` resteront à 0 — la moitié utile du diagnostic survit, mais l'amplitude est perdue silencieusement. POUR CONFIRMER SUR UN VRAI RUN : lancer `LOG_LEVEL=debug pnpm dev -- run raid -p <chemin> 2>&1 | tee /tmp/run.log`, puis `grep -n 'context compacted' /tmp/run.log`. Si des lignes apparaissent avec `{"preTokens":0,"postTokens":0}` alors qu'une compaction a bien eu lieu, la forme est différente : capturer le JSON brut en ajoutant temporairement `log.debug('compact raw', event as Record<string, unknown>)` dans la branche, relancer, et ajuster `readCompactTokens`. `post_tokens` en particulier pourrait ne jamais exister côté CLI — auquel cas `postTokens` restera structurellement à 0 et il faudra soit le supprimer, soit le documenter comme non fourni.
- OUBLIER LE `?? { count: 0, ... }` À L'ÉTAPE 9(c) CASSE ~20 TESTS EXISTANTS. `tests/unit/agent-loop.test.ts` monte ses réponses par `mockSend.mockResolvedValue({ content, toolCalls, costUsd, durationMs, sessionId })` — sans `tokens` ni `compaction` (voir lignes 168-174). Lire `resp.compaction.count` directement lève un `TypeError: Cannot read properties of undefined (reading 'count')` dans `send()`, que `runAgentLoop` attrape et transforme en `exitReason: "error"` — les tests échouent alors sur des assertions sans rapport (`expected 'error' to be 'done'`), ce qui masque la vraie cause. Le second test de l'étape 8 est là exactement pour ça. Symptôme à reconnaître : plusieurs tests de `agent-loop.test.ts` basculent en `exitReason: "error"` d'un coup.
- `pnpm build` ÉCHOUE PENDANT LA PHASE ROUGE, ET C'EST NORMAL. `tsconfig.json` a `"include": ["src/**/*.ts", "cli/**/*.ts", "tests/**/*.ts"]` : `tsc` type-check les tests. Aux étapes 3 et 8, `tsc` sortirait `Property 'compaction' does not exist on type 'AssistantResponse'`. Vitest, lui, passe par esbuild qui ne type-check pas — d'où un échec d'assertion propre. Ne lancer `pnpm build` qu'à l'étape 10.
- ORDRE DE LA BRANCHE DANS LE HANDLER. La branche compact_boundary doit être placée AVANT la ligne `if (event.type === "system" && NOISE_SUBTYPES.has(event.subtype)) return;`. Placée après, elle fonctionne aujourd'hui (`NOISE_SUBTYPES` ne contient que `hook_started` et `hook_response`) mais deviendrait silencieusement morte si quelqu'un ajoutait `compact_boundary` à cet ensemble en croyant faire du ménage. Symptôme : `count` reste à 0 alors que les événements arrivent bien — vérifiable en ajoutant un `console.log` temporaire en tête de handler.
- ALIASING DE L'OBJET `compaction`. Le compteur est un objet mutable vivant pendant tout l'envoi ; `resolve` en passe une COPIE (`{ ...compaction }`). Sans la copie, un `compact_boundary` arrivant dans le flush de fin de buffer (`readable.on("end")`, ligne 222) après le `result` ferait muter en douce un objet que l'appelant a déjà lu et poussé dans `turnDetails` — un chiffre qui change après lecture, indébogable. Ne pas « simplifier » le spread.
- AUCUNE DÉCISION NE DOIT ENCORE BRANCHER SUR CE COMPTEUR. Ce patch est purement de l'instrumentation : il ne touche ni `EFFORT_PROFILES` (effort.ts lignes 22-36) ni les deux sites d'abandon de la boucle de work-stealing (agent-loop.ts lignes 1126 et 1179), qui continuent de journaliser `subtype` sans brancher dessus. Ajuster `maxTurns` de `mid` sur la foi de ce compteur avant d'avoir mesuré un vrai raid reproduirait exactement l'erreur que le patch cherche à rendre visible.

