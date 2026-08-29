<!-- Cadrage produit — document vivant.
     Issu d'une exploration multi-agents du 2026-08-29 : six lentilles produit avec
     obligation de preuve (chemin:ligne ou commande executee), trois juges a critere
     unique, une synthese. Les chiffres et les chemins cites SONT la specification.
     Les sections 2 (definition de fini) et 3 (les portes) sont normatives : un
     changement qui les viole se refuse. -->

# CADRAGE PRODUIT — essaim

Document de travail pour le mainteneur unique. Toutes les affirmations chiffrées viennent des six lentilles et des trois jugements ; les six que j'ai revérifiées moi-même dans l'arbre sont marquées `[vérifié]`.

---

## 1. CE QU'EST ESSAIM, EN UNE PHRASE

**Promesse actuelle (implicite dans le README et `docs/index.html`)** : *« N agents Claude Code travaillent en parallèle sur des worktrees isolés, se consultent quand ils touchent le même module, et convergent par consensus. »*

Cette promesse n'est pas tenable aujourd'hui et ne le sera pas au prix d'un correctif : le seul mécanisme qui promeut un pair en votant (l'introspection) n'a **aucun client** (`introspections_triggered: 22 / introspections_concerned: 0`), `expected_respondents` n'est peuplé que par le chevauchement de fichier littéral, et `approve_resolution` a été **délibérément retiré** de l'outillage LLM (`agent-launcher.ts:106-108`) au profit d'un chemin code qui n'a jamais été écrit `[vérifié : approveResolutionViaRest n'a qu'un site, sa définition, agent-loop.ts:531]`.

**Promesse proposée, vérifiable** :

> **essaim lance N agents Claude Code en parallèle sur des worktrees git isolés du même dépôt, leur distribue une file de tâches sans double réclamation ni collision de fichiers, et rend un rapport qui nomme chaque tâche, son verdict et comment récupérer le code.**

Chaque terme est mesurable : *N worktrees isolés* (le worktree existe, la branche existe, l'arbre de travail de l'utilisateur est intact), *sans double réclamation* (0 tâche réclamée deux fois dans la DB du coordinator), *sans collision de fichiers* (0 conflit sur un fichier annoncé par deux agents), *rapport qui nomme* (une ligne par tâche réclamée).

**Ce qu'on abandonne explicitement, et qu'il faut retirer de la doc en même temps :**

| Abandonné | Devient |
|---|---|
| « les agents se **consultent** quand ils touchent le même module » | « les agents **s'annoncent** avant d'écrire ; un fichier déjà annoncé ouvre un thread » — le scoring par module cesse d'être vendu, et les introspections cessent d'être émises |
| « **consensus** / quorum » | « résolution auto-approuvée par l'agent qui a fait le travail », dit tel quel dans le rapport |
| mode **équipe / distribué** (issue #33) | hors périmètre déclaré. Le mode est local, un coordinator par run |
| `essaim security` au même rang que `run` | commande **expérimentale**, prérequis listés, jamais citée dans le quickstart |
| les **4 archives binaires** | voir J4 : la recommandation est de cesser de les publier |

Coût de cet abandon : essaim perd son argument le plus vendeur et devient « un orchestrateur de work-stealing pour agents Claude Code ». Bénéfice : c'est la seule phrase qu'un run peut prouver, et sa preuve tient dans le rapport.

---

## 2. LA DÉFINITION DE FINI

Huit critères. Chacun est une commande et un seuil. Aucun n'est « la doc est bonne ».

| # | Critère | Comment on le lit | Seuil |
|---|---|---|---|
| **DF1** | **Premier contact sans intervention.** Sur une VM Windows neuve et une VM Ubuntu **minimale** (sans `jq`, sans `curl`), un opérateur qui n'est pas le mainteneur suit le README de bout en bout. | Script de fumée en CI sur les deux OS : `npm i -g essaim && essaim doctor && essaim run <preset> -p <dépôt tiers>`. | Exit 0. **Zéro** intervention non nommée par `doctor`. Toute dépendance manquante produit un message + une commande d'installation, jamais un stack trace ni « 0 findings ». |
| **DF2** | **Généralité.** Le produit marche sur un dépôt qui n'est pas essaim, dans un langage qui n'est pas TypeScript, lancé depuis un cwd qui n'est pas le dépôt. | Campagne : 3 dépôts tiers (1 Python, 1 Go, 1 monorepo pnpm), 2 presets (`raid`, `swarm`), `cd /ailleurs && essaim run … -p <dépôt>`. | ≥1 tâche complétée par run ; **0** empoisonnement imputable au garde-fou de falsifiabilité ; **0** littéral `tests/sandbox`, `bce/`, `dashboard/` dans le prompt assemblé ; **0** répertoire `runs/`/`reports/`/`data/` créé hors du dépôt cible. |
| **DF3** | **Aucun garde-fou silencieux.** Les cinq dégradations connues sont visibles dans le rapport, pas seulement dans du JSON pino. | Test paramétré à 5 cas : quota indisponible, broker MQTT occupé, `tsc` injoignable, lanceur de tests qui ne démarre pas, coordinator injoignable. | Chacun produit une ligne `DÉGRADÉ: <quoi> — <conséquence>` en tête du rapport **et** sur stdout hors JSON. 5/5. |
| **DF4** | **Sûreté par construction.** Aucun agent ne peut écrire dans l'arbre de travail de l'utilisateur. | Test paramétré sur les 15 templates : pour tout `workspace: shared`, `buildAllowedTools()` ne contient ni `Write`, ni `Edit`, ni `Bash`. | 15/15, zéro exception. Aujourd'hui : 4 templates échouent `[vérifié : agent-launcher.ts:51,128 lisent read_only, aucun site de src/ ne l'écrit ; READ_ONLY_TOOLS = ["Read","Bash","Glob","Grep"] contient Bash]`. |
| **DF5** | **Le rapport se suffit.** Un lecteur qui n'a pas vu le terminal sait ce qui a été fait. | Sur un run où le garde-fou a refusé au moins un `DONE:` : `grep` du motif de refus dans `reports/<run_id>.md`. | Une ligne par tâche réclamée (id, agent, verdict, motif) ; en-tête portant `run_id`, `baseSha`, version, URL coordinator ; une section « Récupérer » avec `git log`/`git diff`/`git cherry-pick`. |
| **DF6** | **Le coût est annonçable avant, et borné pendant.** | `essaim run … --dry-run` puis `essaim run … --max-budget-usd 0.05`. | Le dry-run imprime modèle + effort + plafond de tours **par phase**. Le run plafonné sort avec `ExitReason=budget_exceeded`. |
| **DF7** | **Le run se referme.** | `threads_resolved_consensus` dans `reports/<run_id>.json`, sur chaque run de la campagne DF2. | `> 0`, et **0** thread laissé en `resolving` à la fin du run. Aujourd'hui : 0 sur 6 runs consécutifs. |
| **DF8** | **L'empreinte est bornée et récupérable.** | `du -sh runs/` et `git branch --list 'mini-project-*' \| wc -l`, avant et après la commande de nettoyage imprimée par essaim. | La commande imprimée fait effectivement baisser `du`, et **ne supprime pas les branches livrables**. Aujourd'hui : 666 Mo, 63 branches, 43 worktrees, et la recette imprimée libère 0 octet. |

**Ce que « fini » ne comprend pas** : le mode distribué, `essaim security` validé en vrai, le lecteur de quota win32/linux, le quorum à plus d'un répondant, l'installation de dépendances par worktree.

---

## 3. LES PORTES

Sept règles applicables à tout changement, à partir de maintenant. Elles ne sont pas des maximes : chacune est une raison de refuser un diff.

**P1 — Pas de correctif sans compteur.**
Un PR de correctif nomme, dans sa description, **la commande qui lit un chiffre** et les deux valeurs (avant / après). Si le chiffre n'existe pas, le PR crée d'abord le compteur, dans un commit séparé. *Refus type* : « rend le message d'erreur plus clair ». *Origine* : F1 est la seule trouvaille du dossier dont le compteur existait déjà — et c'est la seule dont on sait qu'elle est encore ouverte, parce que `threads_resolved_consensus` lit 0. Les trois correctifs inertes de cette session (`maxBudgetUsd`, `healthCheck`, `approveResolutionViaRest`) sont tous du code écrit, testé, et jamais appelé : aucun n'avait de compteur.

**P2 — Une dégradation muette vaut la panne qu'elle masque.**
Tout `catch` qui rend un fallback, tout `|| ""`, tout `503 → proceed`, tout `return null` qui signifie deux choses, doit écrire **une ligne dans le rapport final**. Un `log.warn` ne compte pas : il part dans du JSON pino que personne ne lit. Un PR qui ajoute un chemin de dégradation sans cette ligne est refusé. *Origine* : `safeExec` avale l'exception et rend `""`, donc `!"".includes("error")` vaut `true` et la colonne dit `OK` ; « coordinator injoignable » et « piscine vide » sont le même `null`, donc un coordinator mort produit « All phases completed ».

**P3 — Le proxy commode n'est pas l'artefact.**
On ne valide jamais : un binaire reconstruit à la place de l'asset publié ; un `--help` avec stdin sur EOF à la place de stdin ouvert ; un adaptateur avec `spawnFn` injecté à la place du vrai moteur ; le dépôt essaim à la place d'un dépôt tiers. Quand seul le proxy est disponible, la conclusion est étiquetée **PRÉSOMPTION** et ne peut pas fermer un critère de la DoD.

**P4 — Le dépôt de mesure n'est jamais essaim, et le cwd n'est jamais le dépôt.**
Aucun chiffre cité dans une note de release ne vient d'un run d'essaim sur essaim. *Origine* : `sentinelle` est le seul preset du catalogue sans chemin de dépôt figé, et essaim est le seul dépôt au monde où `isTestFile` retourne `true` `[vérifié : falsifiability.ts:47-48, regex /(^|\/)tests\/.*\.test\.(ts|js)$/]`. Le banc n'a pas mesuré « un point » : il a mesuré la seule cellule saine de la matrice.

**P5 — Un commentaire qui affirme un comportement cite un test, ou il part.**
Tout commentaire de la forme « le code gère X directement / ailleurs » nomme `fichier:ligne` et un test qui exerce ce chemin. Sinon, on supprime le commentaire dans le même PR. *Origine* : trois affirmations fausses avec l'autorité du code — `agent-launcher.ts:107` (« the code handles approve_resolution directly » : il ne le fait pas), `README.md:350` (« reads usage from the Anthropic API » : c'est `/api/quota`), `README.md:390` (« init provisions a token » : `coordinator-auth.ts:8-11` ne fait que lire l'env).

**P6 — Le CI exécute le chemin de l'utilisateur, pas celui du mainteneur.**
Un job qui ne peut structurellement pas échouer pour la raison qu'il prétend couvrir n'est pas un job : on le corrige ou on le supprime. *Origine* : `release-binaries.yml:161-181` lance `--version`/`--help`/`list` avec stdin fermé, donc reste vert pendant que l'artefact se fige chez l'humain. C'est le même angle mort que celui corrigé pour `templates/` en 0.13.0 — la leçon avait été apprise sur l'instance, pas sur la classe.

**P7 — Rien ne touche l'arbre de travail de l'utilisateur sans worktree.**
La restriction d'outils est dérivée d'un champ de configuration, jamais d'un paragraphe de prompt. Le test de DF4 tourne en CI et est bloquant.

**P8 — Un mécanisme non câblé ne se documente pas.**
Si le README ou `--help` le décrit, un test l'exerce ; sinon la phrase part dans le même PR. *Applicable immédiatement à* : `--max-quota-pct`, la provision de jeton, `ANTHROPIC_API_KEY` en prérequis, le dashboard sur la route binaire, `bug-hunting.modules` dans l'exemple `--set`.

---

## 4. LES JALONS

Échelle d'effort : **petit** = moins d'une demi-journée · **moyen** = 1 à 3 jours · **gros** = plus d'une semaine.

### J1 — « Il ne peut pas abîmer ton dépôt, et il ne te dit pas vert quand rien n'a eu lieu »

**Ce qu'on peut faire à la fin qu'on ne pouvait pas avant** : lancer essaim sur son propre dépôt sans risquer de perdre du travail non commité, et croire un rapport vert.

**Contenu** : `read_only` dérivé de la présence du behavior `read-only-mode` **et** `Bash` retiré de `READ_ONLY_TOOLS` (les deux, sinon rien n'est corrigé) · « coordinator injoignable » séparé de « piscine vide » · colonne Compilation tri-état (a tourné et passé / a tourné et échoué / n'a pas pu tourner) · code de sortie 1 si 0 thread résolu **et** 0 ligne de diff · `essaim doctor` : `claude`, `jq`, `curl`, ports 3100 et 1883, catalogue trouvé, lanceur de tests qui démarre — appelé en tête de `run-core.ts` avant que le coordinator ne démarre · `resolveClaudeBin` qui connaît `.cmd`/`.exe` sur win32 `[vérifié : claude-stream.ts:296-300, trois candidats POSIX puis la chaîne "claude"]` · `child.on("error")` et `CLAUDE_BIN` honoré dans `cli/solo.ts` · **l'appel `approve-resolution`** — ici et pas plus tard, parce que toute mesure prise avant est à refaire · ligne « Sans consensus » du tableau retirée ou relibellée (ne **pas** estampiller `run_id` sur `/api/announce` : `agent-loop.ts:468-486` documente le choix inverse sur 20 lignes, l'estampiller régresserait la note honnête).

**Trouvailles fermées** : robustesse 1, 3 · premier-contact 4, 12 · généralité 9 · collaboration F1, F2, F3 · observabilité 1, 2, 3 · l'ajout « spawn Windows/npm » du juge inconnu.

**Porte de sortie** : DF3 (5/5), DF4 (15/15), DF7 (`consensus > 0`), plus **un coordinator tué à la main en plein run** dont le rapport dit l'échec. Ce dernier point est une condition de sortie, pas un bonus : c'est lui qui autorise J2 à produire des chiffres crédibles.

**Ce qu'on ne fait PAS en J1** : la généralité, la purge disque, le budget, les binaires, le dashboard, la sécurité, le mode distribué, `onApproval`/introspection, le lecteur de quota win32.

---

### J2 — « Ça marche sur un dépôt qui n'est pas essaim » (et la campagne qui le prouve)

**Ce qu'on peut faire à la fin** : un utilisateur Python, Go, Rust ou monorepo obtient un run dont le périmètre, le garde-fou de test, le contrôle de compilation et l'empreinte disque sont ceux de **son** dépôt.

**Contenu** : les blocs SCOPE STRICT de `raid`/`swarm`/`melee` deviennent paramétriques sur `context.source_dirs` / `test_dirs`, que le scanner calcule déjà · `isTestFile` dérivé de la détection de langage, comme `test_command` l'est depuis `agent-loop.ts:147` — et le préflight dit **une fois au lancement** si le lanceur ne démarre pas sur un dépôt propre, ce qui ferme le fail-open de `falsifiability.ts:326-335` · `npx tsc` seulement sur dépôt TS, sinon `compilation_ok: undefined` (la colonne sait déjà afficher `N/A`) · scanner : exclusion par **segment** de chemin, avec normalisation des `\` · un niveau de descente pour les monorepos · `runs/`, `reports/`, `data/` ancrés sur `-p` · `--cleanup` change de sens : supprime worktrees + runDir, **garde les branches**.

**Le livrable central n'est pas un correctif, c'est un job CI** : créer un dépôt Python de trois fichiers dans un temp dir, lancer `scan` + `run --dry-run` **depuis un autre cwd**, asserter zéro littéral de chemin d'essaim dans le prompt assemblé et zéro `runs/` dans le cwd. Ce seul job aurait attrapé généralité 1, 2, 5, 8, coût 6 et observabilité 6.

**Puis la campagne** : 3 dépôts tiers, 2 langages non-TS, 2 presets, cwd externe.

**Trouvailles fermées** : généralité 1 à 8 · coût 6 · observabilité 6.

**Porte de sortie** : DF2 dans ses quatre seuils.

**Ce qu'on ne fait PAS en J2** : installer les dépendances par worktree (limite assumée, écrite dans le README — un `node_modules` de 578 Mo par agent est un remède pire que le mal), `essaim clean` (le `--cleanup` redéfini suffit tant que personne ne le réclame), l'introspection, le quota win32.

---

### J3 — « Le run se raconte »

**Ce qu'on peut faire à la fin** : à la fin d'un run, savoir quelle tâche a été prise, par qui, avec quel verdict, pourquoi un `DONE:` a été refusé, et comment récupérer le code — sans avoir vu le terminal.

**Contenu** : un registre par tâche remonté de `AgentLoopResult` jusqu'à `RunResult`, portant les refus du garde-fou (aujourd'hui un `logger.warn` volatil et un post dans un thread, ni l'un ni l'autre n'atteint le rapport) · section « Récupérer » (`git log <baseSha>..<branche>`, `git diff`, `git cherry-pick`) — aujourd'hui la seule commande copiable qu'essaim offre **efface** le livrable, et son `xargs -r` n'existe pas sous PowerShell · rapport nommé par `run_id`, écrit **aussi** dans le répertoire de run, avec en-tête d'identité · diff qui compte les fichiers non suivis (`parseUntrackedFiles` existe déjà) · noms des hot files au lieu de leur nombre · suppression des sections mortes (`custom_metrics` câblé à `{}`, `avg_resolution_time_ms` câblé à 0).

**Trouvailles fermées** : observabilité 4, 5, 6, 8, 9 · l'unique extension du modèle de données couvre cinq des sept.

**Porte de sortie** : DF5.

**Ce qu'on ne fait PAS en J3** : le client d'introspection, le sweeper, le vote gray-zone, la persistance du dashboard après run.

---

### J4 — « On assume publiquement ce qu'on livre »

**Ce qu'on peut faire à la fin** : lire la doc et n'y trouver que ce qui existe ; borner une facture ; savoir que `security` est expérimentale avant de la lancer.

**Contenu** : **décision binaires** — cesser de les publier et supprimer `cli/self-update.ts` (185 lignes). Ça ferme premier-contact 1, 2, 3, 5, 6, 14 et robustesse 2, 14 : **huit trouvailles pour un diff négatif**. L'alternative (réparer le garde `isMainModule` en amont, `ws.pause` sous Bun, documenter les archives, ajouter `dashboard/` au paquet) coûte du moyen sur trois fronts pour un chemin d'installation que la doc ne mentionne nulle part `[premier rung de l'échelle : ça n'a pas besoin d'exister]`. · `--max-budget-usd` câblé — **après avoir vérifié que le CLI `claude` installé accepte le drapeau**, sinon on livre une option morte de plus · `--dry-run` imprime modèle, effort, plafond de tours · les overrides `model`/`thinking` de `phase-execute` honorés dans la boucle execute, ou retirés du YAML — la phase la plus chère est la seule où le levier documenté ne marche pas · corrections doc : mécanisme de quota, `ANTHROPIC_API_KEY` (le README demande d'exporter une clé inutile qui fait sortir l'utilisateur de son abonnement — une ligne de doc qui coûte de l'argent réel), provision de jeton, table d'effort (`mid` = 16 tours, pas 8), chemin du rapport, port 1883, prérequis `jq`/`bash`/`git`, « Runs locally with Docker », pied de page v0.9.x, `--set bug-hunting.modules` · `essaim security` marquée expérimentale + `healthCheck()` appelé avant `runSecurityScan` (le bon message existe et est mort, `strix.ts:66`) · une phrase dans le README disant que le catalogue et les prompts sont en français.

**Trouvailles fermées** : premier-contact 1-3, 5-6, 9-11, 13-16 · robustesse 2, 4, 5, 11, 12, 14 · coût 1, 2, 8, 13, 14, 15.

**Porte de sortie** : DF6, DF8, et DF1 rejoué sur les deux VM neuves après les corrections de doc.

**Ce qu'on ne fait PAS en J4** : valider Strix pour de vrai, le mode distribué, le lecteur de quota win32 (remplacé par une ligne au démarrage : « quota indisponible sur cette plateforme, `--max-quota-pct` sans effet »).

---

## 5. LE BACKLOG DÉCOUPÉ

Ordonné. Chaque ligne est une unité qu'une personne finit d'un bloc.

| # | Chantier | Jalon | Gravité | Effort | Mesure qui prouve qu'il est réglé |
|---|---|---|---|---|---|
| 1 | `read_only` dérivé du behavior **+** `Bash` hors de `READ_ONLY_TOOLS` | J1 | BLOQUANT | petit | Test paramétré : 15/15 templates, `workspace: shared` ⇒ ni `Write` ni `Edit` ni `Bash` |
| 2 | `approve-resolution` appelé dans `completeTask` ; rapport dit « résolu (auto-approbation) » | J1 | MAJEUR | petit | `threads_resolved_consensus > 0` et `resolution_type='consensus'` sur ≥1 thread |
| 3 | `essaim doctor` (claude, jq, curl, 3100, 1883, catalogue, lanceur de tests) + appel en tête de `run-core.ts` | J1 | BLOQUANT | moyen | Dépendance retirée ⇒ message + commande d'install, exit ≠ 0, coordinator jamais démarré |
| 4 | `resolveClaudeBin` win32 (`.cmd`/`.exe`, PATHEXT, `shell` quand la cible finit par `.cmd`) | J1 | BLOQUANT | petit | Test avec un faux `claude.cmd` sur le PATH ⇒ le processus démarre |
| 5 | `cli/solo.ts` : `child.on("error")`, `CLAUDE_BIN` honoré, plus de dump du prompt | J1 | BLOQUANT | petit | `claude` absent ⇒ une ligne d'erreur, 0 octet de prompt sur stdout |
| 6 | Coordinator injoignable ≠ piscine vide | J1 | MAJEUR | petit | Coordinator tué en plein run ⇒ `exitReason` ≠ `done`, rapport rouge |
| 7 | Colonne Compilation tri-état (code de sortie, pas `includes("error")`) | J1 | BLOQUANT hors TS | petit | Reporter lancé sans `tsc` joignable ⇒ `compilation_ok !== true` |
| 8 | Code de sortie 1 si 0 thread résolu **et** 0 diff | J1 | MAJEUR | petit | Rejeu du run `report-1788028802150` ⇒ exit 1 |
| 9 | Ligne « Sans consensus » retirée/relibellée (sans toucher au `run_id`) | J1 | MAJEUR | petit | Aucune paire de nombres incompatibles dans le même rapport |
| 10 | **Job CI « dépôt tiers »** : Python jetable, `scan` + `run --dry-run`, cwd externe | J2 | BLOQUANT | moyen | Le job échoue sur `main` aujourd'hui, passe après 11-14 |
| 11 | Scopes de `raid`/`swarm`/`melee` paramétriques sur `source_dirs`/`test_dirs` | J2 | BLOQUANT | petit | Prompt assemblé contre un fixture non-TS : 0 littéral `tests/sandbox`, `src/`, `bce/`, `dashboard/` |
| 12 | `isTestFile` dérivé de la détection de langage + préflight du lanceur | J2 | BLOQUANT | moyen | Table de 12 chemins réels ; **et** sur un dépôt sans lanceur : refus explicite, pas `falsifiable: true` |
| 13 | `runs/`, `reports/`, `data/` ancrés sur `-p` ; `--cleanup` garde les branches | J2 | MAJEUR | petit | `cd /ailleurs && essaim run -p <dépôt>` ⇒ 0 répertoire créé dans le cwd |
| 14 | Scanner : exclusion par segment (+ `\`), un niveau de descente monorepo | J2 | MINEUR/MAJEUR | petit | `latest.ts`/`inspector.ts` visibles ; monorepo pnpm ⇒ `source_dirs` non vide |
| 15 | `npx tsc` seulement sur dépôt TS | J2 | MAJEUR | petit | Dépôt Go ⇒ `N/A`, et le temps de run baisse de ~10 s/agent |
| 16 | **Campagne** : 3 dépôts tiers, 2 langages, 2 presets, cwd externe | J2 | — | moyen | DF2 dans ses quatre seuils |
| 17 | Registre par tâche de `AgentLoopResult` à `RunResult` (id, agent, verdict, motif) | J3 | BLOQUANT pour « quoi ensuite » | moyen | Run avec ≥1 refus ⇒ le motif est dans `reports/<run_id>.md` |
| 18 | Section « Récupérer » + suppression de la recette destructrice | J3 | MAJEUR | petit | 0 `git branch -D` imprimé ; `git cherry-pick` présent |
| 19 | Rapport nommé par `run_id`, écrit aussi dans le runDir, en-tête d'identité | J3 | MAJEUR | petit | `ls runs/<run_id>/` contient le rapport ; le nom contient le `run_id` |
| 20 | Diff compte les non-suivis ; hot files nommés ; sections mortes supprimées | J3 | MAJEUR | petit | Agent qui écrit sans commiter ⇒ diff ≠ 0 ; 6 noms de fichiers au lieu de « 6 » |
| 21 | **Cesser de publier les binaires + supprimer `self-update.ts`** | J4 | MAJEUR | petit (diff négatif) | `release-binaries.yml` supprimé, `essaim --help` n'annonce plus `self-update` |
| 22 | `--max-budget-usd` câblé (après vérification du drapeau côté CLI `claude`) | J4 | MAJEUR | petit | `--max-budget-usd 0.05` ⇒ `ExitReason=budget_exceeded` |
| 23 | `--dry-run` imprime modèle/effort/tours par phase | J4 | MAJEUR | petit | La sortie contient `opus` et `20` pour execute |
| 24 | Overrides `model`/`thinking` honorés en execute, ou retirés du YAML | J4 | MAJEUR | petit | `--set phase-execute.model=X` ⇒ `turn_details[].model === X` |
| 25 | `healthCheck()` appelé avant le scan + `security` marquée expérimentale | J4 | MAJEUR | petit | Strix absent ⇒ « pip install strix-agent », jamais « 0 findings » |
| 26 | Purge doc : quota, `ANTHROPIC_API_KEY`, jeton, effort `mid=16`, chemin du rapport, 1883, `jq`, Docker, v0.9.x, `--set bug-hunting`, langue du catalogue | J4 | MAJEUR (dont un qui coûte de l'argent) | petit | `grep` des 10 phrases ⇒ 0 occurrence |
| 27 | `essaim init` : fusion des hooks par événement + `.bak`, ou retrait du quickstart | J4 | MAJEUR | petit | `settings.json` avec un hook utilisateur préexistant ⇒ le hook survit |
| 28 | Ligne « quota indisponible sur cette plateforme » au démarrage | J4 | MAJEUR | petit | Sur Windows : une ligne texte, pas un `log.warn` JSON |
| 29 | Hooks : `.gitignore` écrit, chemins relatifs, `jq` vérifié par `doctor` | J4 | MAJEUR | moyen | `git status` propre après un run sur un dépôt neuf |

**Hors backlog, décision de ne pas construire** : le client d'introspection (F5) — on retire l'émission et la phrase, on ne construit pas l'autre bout · le lecteur de quota win32/linux (hors dépôt, gros, dominé par le #28) · l'installation de dépendances par worktree (limite documentée) · `essaim clean` (dominé par le #13) · le sweeper de timeouts (dominé par le #2).

---

## 6. LE PREMIER PAS

**Chantier 1 — `read_only` dérivé du behavior, et `Bash` retiré de `READ_ONLY_TOOLS`.**

Pourquoi lui plutôt que le #2 (`approve-resolution`, une ligne, compteur déjà en place) ou le #3 (`doctor`, meilleur ratio effort/rétention) :

1. **C'est le seul dégât irréversible du dossier.** `essaim run gardien -p .` donne `Write` + `Bash` sans restriction, `cwd` = l'arbre de travail réel, pas de worktree, pas de branche, pas d'instantané `[vérifié]`. Tous les autres chemins destructeurs sont encadrés : `ESSAIM_RESET_BASE` exige de nommer sa cible, les worktrees isolent, les branches portent le `runId`. Celui-ci contourne tout, et la protection annoncée — le behavior `read-only-mode`, `READ_ONLY_TOOLS` — est du texte de prompt à côté d'un champ que personne n'écrit.
2. **Il est en amont de tout le reste.** J2 consiste à faire tourner essaim sur des dépôts qui ne nous appartiennent pas. Ce chantier doit être fermé avant, sinon la campagne elle-même est le risque.
3. **Il est de deux lignes plus un test de quatre.** Une ligne dans `bridge.ts` pour dériver `read_only` de la présence du behavior, une ligne dans `agent-launcher.ts:40` pour sortir `Bash`. Le test paramétré sur les 15 templates **est** la porte DF4 : le chantier et sa mesure sont le même diff.
4. **Il ne dépend de rien.** Aucun préalable, aucune décision de contrat, aucune vérification amont.

Le #2 part dans la même semaine, pour une raison de séquençage et non de gravité : posé après la campagne de J2, il oblige à refaire toutes les mesures ; posé avant, il coûte une ligne. Le #3 est le plus gros gain de rétention du dossier, mais il ne protège rien — il explique.

---

## 7. CE QUI RESTE INCERTAIN

| Incertitude | Qui l'a butée | Est-ce que ça change quelque chose |
|---|---|---|
| **L'asset publié n'a jamais été exécuté.** Les cinq trouvailles « binaire » portent sur une reconstruction locale (bun 1.4.0), honnêtement étiquetée. | Lentille premier-contact, confirmée par les trois juges | **Non, si on tranche le #21.** La décision de cesser de publier rend l'incertitude sans objet et ferme huit trouvailles. Si on décide de garder les binaires, alors il faut télécharger l'asset et l'exécuter avant toute autre chose — c'est un préalable, pas une vérification. |
| **Le coordinator n'a jamais été tué en vrai.** Le chemin de code est prouvé de bout en bout, la conséquence (« All phases completed ») est déduite. | Lentille robustesse | **Oui, et c'est la plus lourde.** C'est la panne qui rend vertes des mesures qui ne mesurent rien. Elle est portée en **condition de sortie de J1**, pas en tâche : tant qu'elle n'est pas provoquée une fois, aucun chiffre de J2 n'est recevable. |
| **Le spawn Windows/npm** est mesuré sur un shim reproduit, pas sur un vrai `npm i -g @anthropic-ai/claude-code`. | Ajout du juge inconnu | **Marginalement.** Le correctif (PATHEXT + `shell` sur `.cmd`) est sans risque quel que soit le résultat de la reproduction. Mais la reproduction doit être faite, sinon on corrige à l'aveugle un blocage qu'aucune des six lentilles n'avait vu. |
| **Le CLI `claude` installé accepte-t-il `--max-budget-usd` ?** Personne ne l'a vérifié. | — | **Oui, sur le #22.** Le câbler sans vérifier reproduirait exactement la classe de défaut qu'on ferme : une option qui existe et ne fait rien. Repli si le drapeau n'existe pas : plafond en tours et en jetons, qui sont déjà comptés. |
| **Le quorum réel à plus d'un répondant n'a jamais été observé et ne le sera pas** dans l'architecture actuelle : `expected_respondents` n'est peuplé que par le chevauchement de fichier littéral, et `approveResolution` n'a aucun contrôle d'identité — l'agent approuve sa propre proposition. | Lentille collaboration + correction du juge séquençage | **Oui, et la décision est prise en section 1.** Le rapport doit écrire « résolu (auto-approbation) ». Publier « consensus » après le #2 serait un mensonge de plus, moins cher à produire que les précédents et tout aussi coûteux à défaire. |
| **La recette de nettoyage** : « 24 branches sur 63 » et « 0 octet libéré » ne sont pas reproduits, et le commentaire du code défend l'inverse. | Contradiction relevée par le juge falsifiabilité | **Non.** La commande change de toute façon au #13 ; le chiffre n'a pas besoin d'être tranché. À ne pas citer dans une note de release en attendant. |
| **Une affirmation du dossier est fausse** : « 32 worktrees avec un `node_modules` vide » — aucun n'est vide, le `ls` était sans `-A`. La conclusion (aucune install par worktree, `npx` remonte au parent) survit, prouvée structurellement par `orchestrator.ts:174`. | Juge falsifiabilité | **Non pour le plan, oui pour la méthode.** C'est exactement le mode de panne que ce cadrage combat : une mesure qui semble fondée et ne l'est pas. C'est l'argument le plus concret pour la porte P1. |
| **Aucun utilisateur externe n'existe.** DF1 suppose « un opérateur qui n'est pas le mainteneur ». | — | **Oui.** À défaut d'un humain, DF1 se lit sur deux VM neuves scriptées en CI. Un mainteneur qui teste son premier contact sur sa propre machine reproduit la configuration dont le produit dépend sans le savoir : `claude.exe` natif, `jq` installé par winget, `node_modules` du dépôt parent, `data/` déjà là. C'est la cause commune de la moitié des trouvailles de ce dossier. |