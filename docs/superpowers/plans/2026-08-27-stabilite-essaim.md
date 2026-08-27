# Stabilité et premier contact — plan d'implémentation

> **Pour les agents d'exécution :** SOUS-COMPÉTENCE REQUISE — utilisez `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans` pour dérouler ce plan tâche par tâche. Les étapes utilisent la syntaxe à cases (`- [ ]`) pour le suivi.

**Goal :** Rendre essaim installable, diagnosticable et honnête — en fermant chaque boucle de vérification sur l'artefact réel plutôt que sur le proxy le plus commode.

**Architecture :** Six correctifs indépendants. Deux touchent la chaîne de publication (workflow de release, matrice CI), deux le rapport de run (code de sortie, libellés mensongers), un le cycle de vie des worktrees, un la documentation publique. Aucun ne modifie le catalogue YAML. Le premier est bloquant : sans lui, les binaires publiés ne peuvent lancer aucun swarm.

**Tech Stack :** TypeScript ESM strict, Node ≥ 22, pnpm 10, vitest 4 (`fileParallelism: false`), tsc pour le build, GitHub Actions, bun pour la compilation des binaires natifs.

**Spec :** Ce plan est issu d'une exploration multi-agents adversariale menée le 2026-08-27 sur ce dépôt, ses 6 rapports de runs réels, la base SQLite laissée par le coordinator, et **l'archive v0.13.0 réellement téléchargée depuis GitHub Releases**. Il n'y a pas de document de spec séparé : les mesures et le code cité SONT la spec.

## Le thème de fond

Ces six manques ont la même forme. **essaim sait produire, il ne sait pas s'observer.** À chaque fois, on mesure le proxy le plus facile à obtenir depuis le processus qui l'écrit, jamais l'artefact réel :

- la CI vérifie le binaire **dans le checkout**, pas le tarball publié ;
- le rapport compte des **événements SSE**, pas l'état final des threads ;
- la CLI sort 0 **par principe**, sans regarder l'issue du run ;
- le nom de branche ignore le **runId**, donc le livrable préservé est écrasé ;
- Windows est développé et livré **sans jamais être exécuté en CI** ;
- la documentation est **écrite**, jamais exécutée.

Tous les cadrans sont verts parce qu'aucun ne regarde la chose. Ce qui manque n'est pas une fonctionnalité : c'est de fermer la boucle sur l'artefact réel — et à chaque fois ça coûte peu.

## Deux avertissements à lire AVANT d'exécuter quoi que ce soit

**1. Tâche 2, étape 5 — commande destructrice.** La rédaction initiale contient un `Remove-Item` suivi d'un `git checkout --` qui écrase des fichiers sans prévenir. La section « Corrections de relecture » de cette tâche la remplace. **N'exécutez pas l'étape 5 telle qu'écrite au-dessus de cette section.**

**2. Tâche 6, étape 8 — neutralise le garde-fou CI existant.** L'instruction, prise au premier degré, désarme silencieusement le job `no-domain-artifacts` qui protège la séparation public/privé du dépôt. La section « Corrections de relecture » de cette tâche la corrige. **Lisez-la avant de toucher à `.github/workflows/test.yml`.**

Dans les deux cas, et partout ailleurs dans ce plan : **la section « Corrections de relecture » d'une tâche fait foi sur les étapes qui la précèdent.** Chaque tâche a été relue ligne par ligne par un agent chargé de la casser ; aucune n'est passée exacte du premier coup (32 corrections au total).

## Contraintes globales

Ces exigences s'appliquent implicitement à **toutes** les tâches. Une tâche qui en viole une doit être arrêtée, pas contournée.

- **Aucun fichier de `behaviors/`, `presets/`, `compositions/`, `templates/` n'est modifié par ce plan.** Le catalogue est hors périmètre.
- **Garde-fou CI :** le job `no-domain-artifacts` de `.github/workflows/test.yml` fait échouer toute PR réintroduisant du contenu de catalogue spécifique à un client. Le terme interdit n'est épelé que dans ce fichier de workflow — ne le recopiez nulle part ailleurs, message de commit compris. **Ne l'affaiblissez pas** : ajouter une vérification à ce job est permis, modifier sa règle existante ne l'est pas.
- **Localisez chaque site d'édition par son CONTENU** (grep de la ligne exacte), jamais par son numéro de ligne absolu. Les numéros de ce plan ont été relevés avant toute modification.
- **Commandes :** `pnpm test` (suite complète), `npx vitest run tests/unit/X.test.ts` (un fichier), `npx vitest run -t "nom"` (un cas), `pnpm build` (tsc). Pas de lint, pas de formateur — n'en inventez pas. La CI exécute exactement `pnpm install && pnpm test && pnpm build`.
- **Un test connu instable :** `tests/unit/metrics-sse-budget.test.ts` (timing SSE). S'il échoue, relancez-le isolément avant de conclure — il n'a de rapport avec aucune de ces tâches.
- **Un commit par tâche**, message en conventional commits, terminé par la ligne exacte :
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Ne faites confiance à aucun chiffre de ce plan sans le revérifier.** Les relecteurs ont trouvé plusieurs comptes de tests et de fichiers erronés dans les rédactions initiales, corrigés dans les sections de relecture. Comptez vous-même avant d'affirmer.

## Ordre d'exécution et pourquoi

| # | Tâche | Coût | Ce que ça débloque |
|---|-------|------|--------------------|
| 1 | `templates/` dans l'archive publiée | petit | **Bloquant** — sans ça, les binaires v0.12 et v0.13 ne lancent aucun swarm |
| 2 | Windows : `self-update` honnête + matrice CI | moyen | Arrête d'écrire un binaire Linux par-dessus un `.exe` |
| 3 | Le rapport cesse d'appeler « Consensus » des propositions | moyen | Le seul retour du mainteneur cesse de mentir |
| 4 | Code de sortie réel + colonne `Raison` | petit | essaim devient câblable dans un pipeline |
| 5 | Le runId dans le nom de branche | petit | Le livrable d'un run survit au run suivant |
| 6 | README, page publique, garde-fou CI | petit | Le quickstart cesse de casser à l'étape 3 |

**La tâche 1 part en premier et seule.** C'est un défaut de livraison actif : les utilisateurs qui installent le binaire aujourd'hui ont un outil inerte. Les autres peuvent suivre dans n'importe quel ordre — elles ne partagent aucun fichier, sauf les tâches 3 et 4 qui touchent toutes deux `src/orchestrator/reporter.ts` dans des blocs distincts (les compteurs d'en-tête pour la 3, le tableau des agents pour la 4). Si vous les faites toutes deux, faites la 3 avant la 4.

**Attendez-vous à ce que la tâche 2 fasse rougir des tests.** C'est le but : la matrice Windows va révéler ce que personne n'a jamais exécuté. Ne masquez pas ces échecs par un `continue-on-error` global — cela rendrait la matrice inutile et rétablirait exactement l'angle mort qu'on cherche à fermer.

## Comment vérifier que la tâche 1 a vraiment marché

Le piège de cette tâche est que la vérification actuelle ne peut pas voir le défaut : elle s'exécute **avant** l'empaquetage, depuis le dépôt où `templates/` existe. Corriger l'empaquetage sans déplacer la vérification laisse le trou ouvert pour la prochaine fois.

Après la prochaine release, sur l'archive **réellement publiée** :

```bash
gh release download <tag> --pattern 'essaim-*-linux-x64.tar.gz'
tar tzf essaim-*-linux-x64.tar.gz | awk -F/ '$2 != "" {print $2}' | sort -u
```

Sept entrées attendues, dont `templates`. Puis, depuis l'arbre extrait, la liste des templates doit être **non vide** — un point qui compte, parce que la commande de listage sort avec le code 0 même sur une liste vide.

État constaté sur v0.13.0, à titre de référence à battre : six entrées, `templates` absent, liste vide, code de retour 0.

---

### Tâche 1 : templates/ absent de l'archive binaire publiée : empaqueter le catalogue et vérifier l'archive extraite, pas le checkout

**Objectif :** Faire entrer `templates/` dans le tarball de release, et déplacer la vérification après l'empaquetage pour qu'elle s'exerce sur l'arbre réellement livré au lieu du dépôt.

**Fichiers :**
- Modifier : `.github/workflows/release-binaries.yml` (123-150 (étape « Verify binary » 123-128 + étape « Package tarball » 130-150, remplacées d'un bloc)) — Workflow qui compile le binaire bun, l'empaquette avec le catalogue et le publie en asset de GH Release, pour 4 plateformes (darwin-arm64, darwin-x64, linux-x64, win32-x64).
- Test : `tests/unit/release-package.test.ts` (nouveau fichier, ~60 lignes) — Garde-fou : réconcilie la liste de répertoires de package.json "files" (ce que npm publie) avec celle de l'étape « Package tarball » (ce que le tarball contient). Les deux déclarent le même catalogue dans deux langues qui ne se parlent pas.

**Interfaces :**
- Consomme : `.github/workflows/release-binaries.yml` lignes 123-150 (étapes « Verify binary » et « Package tarball », matrice de 4 plateformes définie lignes 41-62 avec `platform`, `arch`, `ext`) ; `package.json` lignes 44-54 ("files", où `"templates/",` est en ligne 51) comme source de vérité de la liste des répertoires de catalogue ; le format de sortie de `cli/list.ts` ligne 21 (`  <id padEnd(14)> <name>`) pour l'assertion du workflow ; le comportement tolérant de `cli/bce-resolver.ts` lignes 33-35 et 103-109 et de `src/template-loader.ts` ligne 54, qui explique l'absence de toute erreur.
- Produit : Un tarball de release contenant `templates/` sur les quatre plateformes, vérifié après empaquetage depuis l'arbre désarchivé et hors du checkout, avec un `essaim list` qui doit nommer le template `raid` sous peine d'échec du job ; plus `tests/unit/release-package.test.ts`, qui exporte trois cas vitest verrouillant l'égalité entre les répertoires de `package.json` "files" et ceux du `mkdir`/`cp` de l'étape d'empaquetage — ramassé automatiquement par `vitest.config.ts` (`include: ["tests/**/*.test.ts"]`) et type-vérifié par `pnpm build`.

**Contexte nécessaire :**

essaim est un orchestrateur CLI : il lance N agents Claude Code sur des worktrees git, et ce que chaque agent dit lui vient d'un catalogue YAML sur disque, pas de chaînes codées en dur. Ce catalogue a cinq répertoires racine : `behaviors/`, `presets/`, `compositions/`, `scripts/` et `templates/` — ce dernier décrivant les « swarms » (quels presets, combien d'agents, quel câblage de phases), c'est-à-dire la seule chose que `essaim run` sait lancer. essaim est distribué de deux façons : un paquet npm, et des binaires natifs compilés par `bun build --compile` publiés en assets de GH Release par `.github/workflows/release-binaries.yml`. Le paquet npm liste ses fichiers dans `package.json` "files" (lignes 44-54), où `"templates/",` figure bien en ligne 51 — le paquet npm est donc sain. Le workflow des binaires, lui, réénumère la même liste à la main : l'étape « Package tarball » crée `behaviors`, `presets`, `compositions`, `scripts` (ligne 140) et copie les mêmes quatre (lignes 144-147). `templates` n'apparaît nulle part. Vérifié sur l'artefact réellement publié en v0.13.0 : ses entrées de premier niveau sont `behaviors`, `compositions`, `presets`, `scripts`, le binaire et `package.json` — pas de `templates`. Le défaut ne lève rien parce que la résolution du catalogue est tolérante par conception : `getBundledRoot()` (cli/bce-resolver.ts lignes 33-35) ne teste l'existence que de `behaviors`, `presets` et `compositions` pour décider qu'un répertoire est une racine de catalogue — `templates` n'entre pas dans le critère ; puis `getTemplatesDirs` (ligne 109, construit par le helper `subdir` lignes 103-104 qui se termine par `.filter(existsSync)`) laisse simplement tomber les répertoires absents, et `loadDir` (src/template-loader.ts ligne 54, `if (!existsSync(dir)) return;`) sort en silence. Résultat : `loadTemplates()` rend un objet vide, `essaim list` (cli/list.ts lignes 19-23) imprime son en-tête « Templates disponibles: » puis itère sur un tableau vide et **sort avec le code 0**, et tout `essaim run` meurt dans `executeRun` (cli/run-core.ts lignes 50-59) sur `Unknown template 'raid'. Available: ` — la liste après « Available: » étant vide (même message côté BCE dans src/bridge.ts lignes 56-57). Le second défaut, structurel, est l'ordre des étapes : « Verify binary » est en ligne 123, **avant** « Package tarball » en ligne 130, et elle exécute `./bin/essaim --version|--help|list` depuis le checkout, où `templates/` existe toujours. Elle ne pouvait donc pas voir le manque, et ne le pourra jamais tant qu'elle regardera le dépôt plutôt que l'archive. Corollaire à ne pas manquer : déplacer l'étape ne suffit pas non plus, puisque `essaim list` sort 0 sur une liste vide — la vérification doit assurer que la sortie contient quelque chose.

**Pourquoi le test discrimine :** Sans le correctif, `dirsFromPackageJson()` rend `['behaviors','compositions','presets','scripts','templates']` (package.json ligne 51 contient `"templates/",`) alors que les deux regex appliquées au script de « Package tarball » ne trouvent que `['behaviors','compositions','presets','scripts']` — vérifié en parsant le fichier tel qu'il est aujourd'hui : les deux `toEqual` échouent avec `+ "templates"` dans le diff, et repassent au vert dès que `templates` est ajouté au `mkdir` et au `cp`. En revanche le test est honnête sur ses limites : il ne peut pas vérifier le déplacement de l'étape « Verify » (moitié (b) du correctif), qui ne se prouve que sur un vrai run du workflow — d'où l'étape 6 (l'ordre des étapes lu depuis le YAML parsé) et l'étape 9 (l'archive publiée), qui sont la vérification manuelle exacte et reproductible.

- [ ] **Étape 1 : Reproduire le défaut sur l'archive v0.13.0 réellement publiée**

Depuis n'importe quel shell bash (Git Bash convient sous Windows) :

```bash
cd "$(mktemp -d)"
curl -fsSL -O https://github.com/swoofer/essaim/releases/download/v0.13.0/essaim-0.13.0-linux-x64.tar.gz
tar tzf essaim-0.13.0-linux-x64.tar.gz | awk -F/ '$2 != "" {print $2}' | sort -u
```

(variante avec la CLI GitHub, si `gh` est installé et authentifié :
`gh release download v0.13.0 --repo swoofer/essaim --pattern 'essaim-*-linux-x64.tar.gz'`)

Sortie attendue AUJOURD'HUI — sept lignes attendues, six obtenues, `templates` manque :

```
behaviors
compositions
essaim
package.json
presets
scripts
```

Et la conséquence, depuis l'arbre extrait :

```bash
mkdir -p extrait && tar xzf essaim-0.13.0-linux-x64.tar.gz -C extrait
cd extrait/essaim-0.13.0-linux-x64
./essaim list
```

Sortie attendue : l'en-tête, puis rien, et un code de retour 0.

```

Templates disponibles:

```

C'est le symptôme exact : liste vide, exit 0. Retenir ce dernier point, il conditionne l'étape 4.

- [ ] **Étape 2 : Créer le test qui verrouille l'égalité des deux listes**

Créer `tests/unit/release-package.test.ts` avec ce contenu intégral :

```ts
// tests/unit/release-package.test.ts
//
// package.json "files" et l'étape « Package tarball » de release-binaries.yml
// décrivent le MÊME catalogue, dans deux langues qui ne se parlent pas : npm
// lit la première, GitHub Actions la seconde. La v0.13.0 est partie avec
// templates/ présent dans "files" et absent du tarball — paquet npm sain,
// binaire incapable de lancer un seul swarm, et aucune étape rouge.
//
// Ce test ne regarde pas le contenu d'une archive (impossible sans exécuter le
// workflow) : il vérifie que les deux déclarations nomment les mêmes
// répertoires.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Répertoires de catalogue publiés par npm — hors dist/, qui est un produit du build. */
function dirsFromPackageJson(): string[] {
  const pkg = JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf-8"),
  ) as { files: string[] };
  return pkg.files
    .filter((f) => f.endsWith("/") && !f.startsWith("dist/"))
    .map((f) => f.slice(0, -1))
    .sort();
}

/** Le script shell de l'étape « Package tarball » du workflow des binaires. */
function packageStepScript(): string {
  const wf = parse(
    readFileSync(resolve(ROOT, ".github/workflows/release-binaries.yml"), "utf-8"),
  ) as { jobs: { build: { steps: Array<{ name?: string; run?: string }> } } };
  const step = wf.jobs.build.steps.find((s) => s.name === "Package tarball");
  if (!step?.run) {
    throw new Error("étape « Package tarball » introuvable dans release-binaries.yml");
  }
  return step.run;
}

// La guillemet fermante exclut les destinations de `cp`
// (`dist/${DIST_NAME}/behaviors/"`) et le binaire (`dist/${DIST_NAME}/"`).
const MKDIR_RE = /dist\/\$\{DIST_NAME\}\/([A-Za-z0-9_-]+)"/g;
const CP_RE = /^\s*cp -r ([A-Za-z0-9_-]+)\/\*/gm;

describe("release-binaries.yml empaquette exactement ce que package.json publie", () => {
  const attendus = dirsFromPackageJson();
  const script = packageStepScript();

  it("sait quels répertoires sont attendus", () => {
    // Un garde-fou qui compare deux listes vides est vert pour rien.
    expect(attendus).toContain("templates");
    expect(attendus.length).toBeGreaterThanOrEqual(5);
  });

  it("crée chaque répertoire dans le tarball", () => {
    const crees = [...script.matchAll(MKDIR_RE)].map((m) => m[1]!).sort();
    expect(crees).toEqual(attendus);
  });

  it("copie chaque répertoire dans le tarball", () => {
    const copies = [...script.matchAll(CP_RE)].map((m) => m[1]!).sort();
    expect(copies).toEqual(attendus);
  });
});
```

Notes de compilation, toutes vérifiées : `yaml` est une dépendance de production (package.json ligne 72, déjà utilisée par src/template-loader.ts ligne 5) ; `tsconfig.json` a `"include": ["src/**/*.ts", "cli/**/*.ts", "tests/**/*.ts"]` et `strict: true`, d'où les `m[1]!` ; `vitest.config.ts` ramasse `tests/**/*.test.ts`, aucune inscription n'est nécessaire. Le motif `ROOT` reprend celui de tests/unit/coordinator-url-ipv4.test.ts ligne 17.

- [ ] **Étape 3 : Voir le test échouer, AVANT le correctif**

```bash
npx vitest run tests/unit/release-package.test.ts
```

Attendu : 1 test vert (« sait quels répertoires sont attendus ») et 2 rouges, avec un diff qui nomme précisément le coupable :

```
 × crée chaque répertoire dans le tarball
   AssertionError: expected [ 'behaviors', 'compositions', 'presets', 'scripts' ]
   to deeply equal [ 'behaviors', 'compositions', 'presets', 'scripts', 'templates' ]

   + "templates"

 × copie chaque répertoire dans le tarball
   ( même diff )

 Tests  2 failed | 1 passed (3)
```

Si les trois passent d'emblée, le correctif est déjà là (ou la regex ne matche plus le script — voir les risques) : ne pas continuer sans avoir compris lequel des deux.

- [ ] **Étape 4 : Remplacer d'un bloc les lignes 123 à 150 du workflow**

Dans `.github/workflows/release-binaries.yml`, supprimer intégralement les lignes 123 à 150 — c'est-à-dire l'étape « Verify binary » (ligne 123 : `      - name: Verify binary`, dont la ligne 126 est `          ./bin/essaim${{ matrix.ext }} --version`) ET l'étape « Package tarball » (ligne 130 : `      - name: Package tarball`, dont la ligne 140 est le `mkdir -p` à quatre répertoires et la ligne 150 le `tar czf`) — et coller à la place le bloc suivant. L'indentation est significative : 6 espaces devant `- name:`, 8 devant `shell:`/`run:`, 10 pour les lignes de script.

```yaml
      - name: Package tarball
        shell: bash
        run: |
          # When called via workflow_dispatch / workflow_call, GITHUB_REF_NAME
          # is the caller's branch (typically `main`), not the tag — so we use
          # `inputs.tag` when present and fall back to GITHUB_REF_NAME for the
          # direct `push: tags` path.
          TAG="${{ inputs.tag || github.ref_name }}"
          VERSION="${TAG#v}"
          DIST_NAME="essaim-${VERSION}-${{ matrix.platform }}-${{ matrix.arch }}"
          # Repris tel quel par « Verify packaged binary ». Une seule source pour
          # le nom, sinon les deux étapes divergent à la première retouche.
          echo "DIST_NAME=${DIST_NAME}" >> "$GITHUB_ENV"

          # templates/ est le catalogue des swarms : sans lui `essaim list` rend
          # une liste vide et tout `essaim run` meurt en « Unknown template ».
          # Il est bien dans package.json "files", donc le paquet npm est sain —
          # c'est exactement ce qui a caché son absence du tarball jusqu'en 0.13.0.
          mkdir -p "dist/${DIST_NAME}/behaviors" "dist/${DIST_NAME}/presets" "dist/${DIST_NAME}/compositions" "dist/${DIST_NAME}/scripts" "dist/${DIST_NAME}/templates"

          cp "bin/essaim${{ matrix.ext }}" "dist/${DIST_NAME}/"
          cp package.json "dist/${DIST_NAME}/"
          cp -r behaviors/* "dist/${DIST_NAME}/behaviors/"
          cp -r presets/* "dist/${DIST_NAME}/presets/"
          cp -r compositions/* "dist/${DIST_NAME}/compositions/"
          cp -r scripts/* "dist/${DIST_NAME}/scripts/"
          cp -r templates/* "dist/${DIST_NAME}/templates/"

          cd dist
          tar czf "${DIST_NAME}.tar.gz" "${DIST_NAME}"

      # APRÈS l'empaquetage, et sur l'arbre DÉSARCHIVÉ. Tant que cette étape
      # tournait avant, depuis le checkout, elle validait un arbre où templates/
      # existe toujours : elle ne pouvait structurellement pas voir ce qui manque
      # à l'archive. L'extraction se fait hors du checkout (../) pour que le
      # walk-up de getBundledRoot() ne puisse pas retomber sur le catalogue du
      # dépôt et verdir sur un catalogue qui n'est pas celui qu'on livre.
      - name: Verify packaged binary
        shell: bash
        run: |
          rm -rf ../essaim-verify
          mkdir -p ../essaim-verify
          tar xzf "dist/${DIST_NAME}.tar.gz" -C ../essaim-verify
          cd "../essaim-verify/${DIST_NAME}"

          "./essaim${{ matrix.ext }}" --version
          "./essaim${{ matrix.ext }}" --help

          # `essaim list` sort 0 sur une liste VIDE : cli/list.ts imprime
          # l'en-tête puis itère sur un tableau vide. Sans ce grep, l'étape
          # resterait verte sur une archive amputée de son catalogue — le
          # déplacement seul ne suffit donc pas.
          LIST="$("./essaim${{ matrix.ext }}" list)"
          echo "$LIST"
          echo "$LIST" | grep -q "^  raid " || {
            echo "::error::le template 'raid' n'apparait pas dans la sortie de essaim list depuis l'archive extraite — catalogue incomplet"
            exit 1
          }
```

Ce qui reste inchangé et doit le rester : l'étape « Sign binary (macOS) » (lignes 104-121) demeure entre « Build binary » et « Package tarball », car elle signe `bin/essaim` avant la copie ; la signature ad-hoc est embarquée dans le Mach-O et survit au `cp` puis au `tar`. L'étape « Publish tarball to GH Release » (ligne 152) suit désormais la vérification, ce qui est le bon sens de lecture : on ne publie qu'après avoir prouvé.

Pourquoi ce grep porte : la sortie de `cli/list.ts` ligne 21 est `console.log("  " + t.id.padEnd(14) + " " + t.name)`, soit `  raid           Le Raid` ; `^  raid ` matche les deux espaces d'indentation, l'identifiant, puis le premier espace de remplissage.

- [ ] **Étape 5 : Voir le test passer**

```bash
npx vitest run tests/unit/release-package.test.ts
```

Attendu :

```
 ✓ tests/unit/release-package.test.ts (3 tests)

 Tests  3 passed (3)
```

- [ ] **Étape 6 : Vérifier que le YAML parse encore et que l'ordre des étapes est le bon**

Le test de l'étape 2 ne lit que l'étape « Package tarball » ; il ne dit rien de l'ordre, qui est la moitié la plus importante du correctif. Contrôle direct, en une commande (elle ne fait que lire) :

```bash
node -e "const {parse}=require('yaml');const fs=require('fs');const d=parse(fs.readFileSync('.github/workflows/release-binaries.yml','utf8'));console.log(d.jobs.build.steps.map(s=>s.name||s.uses).join('\n'))"
```

Sortie attendue, exactement dans cet ordre (la ligne `undefined` est normale : l'étape `- run: pnpm install --frozen-lockfile --ignore-scripts` de la ligne 89 n'a pas de `name:`) :

```
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
undefined
Build binary
Sign binary (macOS)
Package tarball
Verify packaged binary
Publish tarball to GH Release
```

Les deux points à contrôler à l'œil : `Verify packaged binary` est APRÈS `Package tarball`, et `Verify binary` a bien disparu (aucun doublon oublié).

- [ ] **Étape 7 : Suite complète, comme la CI**

```bash
pnpm test && pnpm build
```

Attendu : les 65 fichiers de test au vert (64 existants + le nouveau), puis un `tsc` silencieux. `tsconfig.json` inclut `tests/**/*.ts`, donc une faute de frappe de type dans le nouveau test casserait `pnpm build` et pas seulement `pnpm test` — c'est bien cette commande-là qu'il faut passer, pas seulement vitest.

À noter : la CI (`.github/workflows/test.yml`) fait exactement `pnpm install && pnpm test && pnpm build`, plus un job `no-domain-artifacts` qui grep le nom d'un client dans tous les fichiers suivis. Rien de ce qui est ajouté ici ne le concerne.

- [ ] **Étape 8 : Commit**

```bash
git checkout -b fix/release-tarball-templates
git add .github/workflows/release-binaries.yml tests/unit/release-package.test.ts
git commit -F - <<'EOF'
fix(release): l'archive binaire partait sans templates/, aucun swarm ne démarrait

L'étape « Package tarball » réénumérait le catalogue à la main et avait
oublié templates/. Vérifié sur l'artefact v0.13.0 publié : ses répertoires
de premier niveau sont behaviors, compositions, presets, scripts — pas
templates. Qui installait le binaire obtenait une liste de templates vide,
puis « Unknown template. Available: » sur tout run. Le paquet npm, lui,
restait sain (package.json "files" inclut templates/), d'où l'invisibilité.

Rien ne levait : getBundledRoot() ne teste que behaviors/presets/
compositions pour reconnaître une racine, getTemplatesDirs filtre par
existsSync et loadDir sort en silence sur un répertoire absent.

Deux corrections. templates rejoint le mkdir et le cp. Et surtout, « Verify
binary » passe APRÈS l'empaquetage et tourne sur l'arbre désarchivé, hors du
checkout : là où elle était, elle validait un arbre où templates/ existe
toujours, et ne pouvait pas voir le défaut. Comme `essaim list` sort 0 sur
une liste vide, la vérification grep désormais le template raid — déplacer
l'étape sans cela l'aurait laissée verte.

Un test réconcilie package.json "files" et l'étape d'empaquetage, pour que
le prochain répertoire de catalogue ne puisse plus manquer l'un des deux.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

- [ ] **Étape 9 : Vérification manuelle sur la PREMIÈRE release publiée après le correctif**

Le test du dépôt vérifie une intention, pas un artefact. Seule cette manipulation prouve le livrable. À faire une fois la version suivante taguée (remplacer `0.14.0` par la version réelle) :

```bash
cd "$(mktemp -d)"
curl -fsSL -O https://github.com/swoofer/essaim/releases/download/v0.14.0/essaim-0.14.0-linux-x64.tar.gz
tar tzf essaim-0.14.0-linux-x64.tar.gz | awk -F/ '$2 != "" {print $2}' | sort -u
```

Sortie attendue — sept lignes, `templates` présent :

```
behaviors
compositions
essaim
package.json
presets
scripts
templates
```

Puis lister les templates depuis l'arbre extrait, ce que faisait le vrai utilisateur :

```bash
mkdir -p extrait && tar xzf essaim-0.14.0-linux-x64.tar.gz -C extrait
cd extrait/essaim-0.14.0-linux-x64
./essaim list
```

Attendu : l'en-tête `Templates disponibles:` suivi de 15 entrées (arene, babel, carrefour, chaine, debat, gardien, maitre, melee, migrate-phase2, phare, raid, relais, revue, sentinelle, swarm), chacune sur deux lignes (identifiant + nom, puis description). Contrôle en une commande :

```bash
./essaim list | grep '^  raid '
```

Attendu : `  raid           Le Raid`. Rien du tout = le correctif n'a pas pris.

Refaire les trois commandes sur les quatre assets, les noms de plateforme venant de `matrix.platform` (donc `win32`, pas `windows`) :
`essaim-0.14.0-darwin-arm64.tar.gz`, `essaim-0.14.0-darwin-x64.tar.gz`, `essaim-0.14.0-linux-x64.tar.gz`, `essaim-0.14.0-win32-x64.tar.gz` — l'archive Windows contient `essaim.exe`, donc `./essaim.exe list`.

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**Étape 6 — la sortie attendue du `node -e` est fausse. La tâche annonce « la ligne `undefined` est normale ». J'ai exécuté la commande telle qu'écrite : `Array.prototype.join` convertit `undefined` en chaîne VIDE, la 5e ligne est donc une ligne blanche, jamais le texte `undefined`. Un lecteur qui ne voit pas `undefined` conclura que sa commande est cassée ou que le YAML a changé. (Tout le reste de l'étape est exact : `require('yaml')` fonctionne bien malgré `"type": "module"`, vérifié.)**

Remplacer intégralement le contenu de l'étape 6 par :

Le test de l'étape 2 ne lit que l'étape « Package tarball » ; il ne dit rien de l'ordre, qui est la moitié la plus importante du correctif. Contrôle direct, en une commande (elle ne fait que lire) — le `??` donne un nom lisible à l'étape sans `name:`, au lieu d'une ligne blanche :

```bash
node -e "const {parse}=require('yaml');const fs=require('fs');const d=parse(fs.readFileSync('.github/workflows/release-binaries.yml','utf8'));console.log(d.jobs.build.steps.map(s=>s.name??s.uses??'(étape sans name)').join('\n'))"
```

Sortie attendue, exactement dans cet ordre (`(étape sans name)` correspond à `- run: pnpm install --frozen-lockfile --ignore-scripts`, ligne 89, qui n'a ni `name:` ni `uses:`) :

```
actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6
pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86
actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
(étape sans name)
Build binary
Sign binary (macOS)
Package tarball
Verify packaged binary
Publish tarball to GH Release
```

Les deux points à contrôler à l'œil : `Verify packaged binary` est APRÈS `Package tarball`, et `Verify binary` a bien disparu (aucun doublon oublié).

**Étape 7 — le compte de fichiers de test est faux. La tâche annonce « les 65 fichiers de test au vert (64 existants + le nouveau) ». `find tests -name '*.test.ts' | wc -l` rend **67** (tous dans `tests/unit/`). Le « 64 » vient de CLAUDE.md, qui est périmé. Le lecteur qui voit 68 croira avoir cassé quelque chose ou avoir lancé la mauvaise commande.**

Remplacer la première phrase du bloc « Attendu » de l'étape 7 par :

Attendu : les 68 fichiers de test au vert (67 existants, tous dans `tests/unit/`, + le nouveau), puis un `tsc` silencieux. Note : `pnpm test` compte des FICHIERS, pas des cas ; les deux tests shell `tests/*.test.sh` sont exécutés depuis `tests/unit/shell-scripts.test.ts` et comptent donc dans ce fichier-là, pas en plus. Le « 64 » qu'annonce CLAUDE.md est périmé — ne pas s'en servir comme référence.

**Étape 8 — le bloc de commit n'est exécutable que depuis bash, mais l'étape ne le dit pas. `git commit -F - <<'EOF'` est un here-document ; l'environnement de ce dépôt a PowerShell comme shell principal, où cette syntaxe est une erreur d'analyse. L'étape 1 précise « Depuis n'importe quel shell bash », l'étape 8 non — et c'est celle qui a le plus de chances d'être copiée telle quelle dans le terminal par défaut.**

Insérer cette phrase en tête du contenu de l'étape 8, avant le bloc de code :

À exécuter depuis **Git Bash** (le here-document `<<'EOF'` n'existe pas en PowerShell, qui est le shell par défaut sur ce poste). Équivalent PowerShell si besoin, avec un here-string littéral dont le `'@` fermant DOIT être en colonne 0 :

```powershell
git checkout -b fix/release-tarball-templates
git add .github/workflows/release-binaries.yml tests/unit/release-package.test.ts
git commit -m @'
fix(release): l'archive binaire partait sans templates/, aucun swarm ne démarrait

L'étape « Package tarball » réénumérait le catalogue à la main et avait
oublié templates/. Vérifié sur l'artefact v0.13.0 publié : ses répertoires
de premier niveau sont behaviors, compositions, presets, scripts — pas
templates. Qui installait le binaire obtenait une liste de templates vide,
puis « Unknown template. Available: » sur tout run. Le paquet npm, lui,
restait sain (package.json "files" inclut templates/), d'où l'invisibilité.

Rien ne levait : getBundledRoot() ne teste que behaviors/presets/
compositions pour reconnaître une racine, getTemplatesDirs filtre par
existsSync et loadDir sort en silence sur un répertoire absent.

Deux corrections. templates rejoint le mkdir et le cp. Et surtout, « Verify
binary » passe APRÈS l'empaquetage et tourne sur l'arbre désarchivé, hors du
checkout : là où elle était, elle validait un arbre où templates/ existe
toujours, et ne pouvait pas voir le défaut. Comme `essaim list` sort 0 sur
une liste vide, la vérification grep désormais le template raid — déplacer
l'étape sans cela l'aurait laissée verte.

Un test réconcilie package.json "files" et l'étape d'empaquetage, pour que
le prochain répertoire de catalogue ne puisse plus manquer l'un des deux.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
'@
```

(puis le bloc bash existant, inchangé)

**Risques — il manque le couplage le plus probable à casser en pratique. Le test traite `package.json` "files" comme « la liste des répertoires de catalogue », alors que ce champ est en réalité « tout ce que npm publie ». Aujourd'hui les deux coïncident (`behaviors/ presets/ compositions/ scripts/ templates/`, plus `dist/*` exclu et deux fichiers sans slash), mais le jour où quelqu'un ajoute `"docs/"` ou `"assets/"` à "files", le test exige ce répertoire dans le tarball du binaire et devient rouge sans qu'aucun défaut n'existe. Ce piège n'est nulle part dans la liste des risques.**

Ajouter ce huitième élément à la liste `risques` :

"Le test lit `package.json` \"files\" comme si c'était la liste des répertoires de catalogue. Ce n'en est pas une : c'est « tout ce que npm publie ». Les deux coïncident aujourd'hui (seuls `behaviors/`, `presets/`, `compositions/`, `scripts/`, `templates/` s'y terminent par `/` hors `dist/`), mais ajouter un jour `\"docs/\"` ou `\"assets/\"` à \"files\" rendrait le test rouge en exigeant ce répertoire dans le tarball du binaire, alors qu'aucun défaut n'existerait. La réponse correcte serait alors d'étendre le filtre de `dirsFromPackageJson()` (à côté de l'exclusion `dist/` déjà présente), jamais de retirer un répertoire de \"files\" pour verdir le test."

**Étape 4 — la liste « Ce qui reste inchangé et doit le rester » oublie un commentaire qui devient faux. Les lignes 83-88 du workflow justifient `--ignore-scripts` par : « Le code d'essaim ne le référence jamais et le binaire bun n'en a pas besoin : l'étape Verify ci-dessous le prouve sur les quatre plateformes. » Après le correctif, l'étape s'appelle « Verify packaged binary » et ne tourne plus juste en dessous mais après l'empaquetage. Le commentaire reste vrai sur le fond mais pointe un nom d'étape qui n'existe plus.**

Ajouter ce paragraphe à la fin du contenu de l'étape 4, après le paragraphe « Ce qui reste inchangé… » :

Un dernier détail à ne pas laisser derrière : le commentaire des lignes 83-88 (celui qui justifie `--ignore-scripts`) se termine par « l'étape Verify ci-dessous le prouve sur les quatre plateformes » et nomme une étape qui vient d'être renommée et déplacée. Remplacer la ligne 87 :

```yaml
      # bun n'en a pas besoin : l'étape Verify ci-dessous le prouve sur les
```

par :

```yaml
      # bun n'en a pas besoin : l'étape « Verify packaged binary » (après
      # l'empaquetage) le prouve sur les
```

soit, en entier, le bloc de commentaire des lignes 83-88 devient :

```yaml
      # `--ignore-scripts` : `better-sqlite3` (transitif via mcp-coordinator)
      # n'a de prebuild que pour darwin, donc les autres plateformes le
      # compilent depuis les sources — ce qui échoue sur Windows faute de
      # Visual Studio. Le code d'essaim ne le référence jamais et le binaire
      # bun n'en a pas besoin : l'étape « Verify packaged binary », plus bas,
      # le prouve sur les quatre plateformes — et désormais sur l'archive
      # réellement publiée, pas sur le checkout.
```

**Risques :**
- Le test lit le script shell avec des regex : si quelqu'un réécrit l'empaquetage en boucle (`for d in behaviors presets ...; do cp -r ...; done`), les regex ne matchent plus et le test devient rouge sans qu'il y ait de bug. L'échec est bruyant, pas silencieux, et la correction est d'adapter les regex — mais mieux vaut garder les lignes explicites, qui sont aussi ce qui rend la revue de PR lisible.
- L'assertion `grep -q "^  raid "` du workflow est couplée à l'existence de `templates/raid.yaml` et au format de `cli/list.ts` ligne 21 (`t.id.padEnd(14)`). Renommer ou supprimer le template raid, ou changer ce format d'affichage, casse la release sur les quatre plateformes. C'est un couplage assumé : il fallait un identifiant stable, et raid est celui que la documentation du dépôt utilise en exemple. Le message `::error::` nomme le template, donc le diagnostic est immédiat.
- L'extraction se fait dans `../essaim-verify`, hors du checkout, précisément pour que le walk-up de `getBundledRoot()` (cli/bce-resolver.ts lignes 29-41) ne puisse pas remonter jusqu'au catalogue du dépôt et valider un catalogue qui n'est pas celui livré. Si quelqu'un ramène l'extraction à l'intérieur du workspace, la vérification redevient partiellement complaisante : une archive privée de `behaviors/` verdirait en lisant celui du checkout.
- Sous Windows, tout repose sur `shell: bash` (Git Bash, préinstallé sur windows-latest) et sur des chemins relatifs — `../essaim-verify`, `dist/...` — pour éviter la conversion de chemins MSYS qui frappe les chemins POSIX absolus passés à un binaire natif. Ne pas remplacer par `mktemp -d` ou `$RUNNER_TEMP` sans l'avoir testé sur le runner Windows.
- `DIST_NAME` transite désormais par `$GITHUB_ENV` entre les deux étapes. Insérer une étape entre elles reste sans effet, mais les réordonner (vérification avant empaquetage) rendrait la variable vide et le `tar xzf` échouerait — bruyamment, ce qui est le comportement voulu.
- Sur macOS, la signature ad-hoc posée par « Sign binary (macOS) » sur `bin/essaim` doit survivre au `cp` puis au cycle `tar czf`/`tar xzf` : elle est embarquée dans le Mach-O, donc oui. C'est justement ce que la nouvelle position de la vérification prouve désormais, alors que l'ancienne testait le binaire avant tout déplacement.
- Le paquet npm n'est pas concerné et ne doit pas être touché : `package.json` "files" est déjà correct et sert ici de source de vérité. Toute « harmonisation » qui modifierait cette liste ferait passer le test pour la mauvaise raison.


---

### Tâche 2 : Windows : rendre `self-update` honnête et ajouter windows-latest à la CI

**Objectif :** Arrêter `essaim self-update` avec un message actionnable sur Windows au lieu d'y déverser l'artefact Linux par-dessus l'exécutable en cours, et faire enfin tourner la suite de tests sur windows-latest.

**Fichiers :**
- Modifier : `C:\Users\gagno\projet\essaim-new\cli\self-update.ts` (insertion après la ligne 6 (`const REPO = "swoofer/essaim";`) ; garde inséré en tête de `.action(() => {` ligne 84 ; commentaire ajouté au-dessus de la ligne 110) — Contient le résolveur de plateforme fautif (ligne 110) et toutes les commandes POSIX (lignes 12, 71, 115, 122, 133). On y ajoute une fonction pure exportée qui décide si la plateforme a un chemin de mise à jour, et un garde-fou qui sort avant tout appel réseau.
- Test : `C:\Users\gagno\projet\essaim-new\tests\unit\self-update-platform.test.ts` (fichier neuf, 30 lignes) — Verrouille le refus Windows et le laissez-passer darwin/linux. Ramassé automatiquement par `include: ["tests/**/*.test.ts"]` de vitest.config.ts, aucune inscription nécessaire.
- Créer : `C:\Users\gagno\projet\essaim-new\.gitattributes` (fichier neuf, 5 lignes) — Force LF au checkout pour les `*.sh`. Sans lui, la jambe Windows de la CI échouera à coup sûr sur les deux tests shell (voir étape 5), ce qui masquerait les vrais échecs sous du bruit.
- Modifier : `C:\Users\gagno\projet\essaim-new\.github\workflows\test.yml` (30 à 46 (job `test` entier ; le job `no-domain-artifacts` lignes 13 à 28 reste inchangé)) — Ajoute la matrice ubuntu-latest + windows-latest avec `fail-fast: false`.
- Modifier : `C:\Users\gagno\projet\essaim-new\CLAUDE.md` (16 et 70) — Ligne 16 : la description de la CI ne mentionne qu'un runner. Ligne 70 : l'affirmation sur le test chmod est inversée par rapport au code réel.

**Interfaces :**
- Consomme : Rien d'une autre tâche du plan ; tout ce qui est nécessaire existe déjà dans le dépôt. Entrées lues : `cli/self-update.ts` (commande commander enregistrée par `cli/index.ts:26` via `program.addCommand(createSelfUpdateCommand())`) ; `.github/workflows/test.yml` (jobs `no-domain-artifacts` ligne 13 et `test` ligne 30) ; `.github/workflows/release-binaries.yml` lignes 42 à 62, dont la matrice `include:` prouve que `essaim-<version>-win32-x64.tar.gz` est publié ; `package.json` (`"name": "essaim"` ligne 2 — le paquet npm existe donc réellement, ce qui rend `npm install -g essaim@latest` valide dans le message ; `pnpm.onlyBuiltDependencies` lignes 91 à 93) ; `vitest.config.ts` (`include: ["tests/**/*.test.ts"]`, `fileParallelism: false`) ; `tests/unit/orchestrator-write.test.ts:98` pour le patron de `skipIf` et la contradiction de doc.
- Produit : Un export public dans `cli/self-update.ts` : `export function unsupportedPlatformNotice(platform: NodeJS.Platform): string | null` — retourne `null` sur toute plateforme disposant d'un chemin de mise à jour (darwin, linux), et le message d'aide multi-lignes sur `"win32"`. Consommée par l'action de la commande elle-même (`process.exit(1)` après `console.error`) et par `tests/unit/self-update-platform.test.ts`. Côté infrastructure : un job CI démultiplié en `test (ubuntu-latest)` / `test (windows-latest)` (nouveaux noms de checks, cf. risques), un `.gitattributes` imposant LF à tous les `*.sh` au checkout, et deux lignes de `CLAUDE.md` (16 et 70) alignées sur le code réel.

**Contexte nécessaire :**

essaim est un orchestrateur CLI TypeScript publié de deux façons : un paquet npm (`essaim`) et des binaires natifs compilés par bun. La matrice de `.github/workflows/release-binaries.yml` (lignes 42 à 62, `include:`) publie quatre tarballs, dont une entrée `os: windows-latest / platform: win32 / arch: x64 / ext: ".exe"` — donc `essaim-<version>-win32-x64.tar.gz` existe bel et bien sur chaque release, et `README.md:235` documente `essaim self-update` comme « Update to the latest release ». Or `cli/self-update.ts:110` résout la plateforme ainsi : `const platform = process.platform === "darwin" ? "darwin" : "linux";`. Le ternaire n'a que deux branches : sur Windows, `process.platform` vaut `"win32"`, la condition est fausse, et l'artefact demandé devient `essaim-<version>-linux-x64.tar.gz`. Ce nom résout réellement (l'entrée `ubuntu-latest` de la matrice le publie), donc le téléchargement réussirait, et la ligne 128 à 131 le détare avec `tar xzf "${tarPath}" -C "${installDir}" --strip-components=1` où `installDir` vient de la ligne 126, `dirname(process.execPath)` — c'est-à-dire le dossier du binaire en train de s'exécuter. Autrement dit : des exécutables ELF Linux écrits par-dessus une installation Windows.

Le même fichier ne peut de toute façon pas fonctionner sur Windows, parce qu'il pilote des commandes POSIX via `execSync`, qui sur Windows lance `cmd.exe` (`process.env.ComSpec`) : ligne 12 `execSync("command -v gh", ...)` (builtin POSIX inexistant sous cmd), ligne 71 `execSync(\`mv "..." "..."\`)`, ligne 115 `const tmpDir = execSync("mktemp -d", { encoding: "utf-8" }).trim();`, et lignes 122 et 133 `execSync(\`rm -rf "${tmpDir}"\`)`. Aucune de ces quatre commandes n'existe dans cmd.exe. Et même en les réécrivant toutes, le remplacement en place resterait impossible : le chargeur d'image Windows garde `essaim.exe` verrouillé tant que le processus vit, donc `tar` échouerait sur « Access is denied », éventuellement à mi-extraction. C'est pour cela que le correctif demandé n'est pas « télécharger le bon artefact » mais « s'arrêter en disant quoi faire » — une réussite mensongère serait pire.

Rien n'a jamais attrapé ça parce que `.github/workflows/test.yml` ne teste que Linux : le job `no-domain-artifacts` (ligne 14) et le job `test` (ligne 31) portent tous deux `runs-on: ubuntu-latest`, sans `strategy:` ni `matrix:`. Le dépôt est développé sous Windows, livre du win32-x64, et ne l'exerce nulle part.

Dernier point de contexte, une contradiction de documentation à corriger au passage. `CLAUDE.md:70` affirme : « One chmod test is Windows-only and skips on macOS/Linux. » Le test réel, `tests/unit/orchestrator-write.test.ts:98`, dit exactement l'inverse : `it.skipIf(process.platform === "win32")("writes hook scripts with 0o755 permissions", () => {` — il SAUTE sur Windows et ne tourne que sur POSIX. Le commentaire français juste au-dessus (lignes 92 à 97) le confirme : « POSIX seulement : Windows n'implémente pas les bits de permission POSIX. » La doc est donc inversée, et c'est un piège actif pour quiconque va faire rougir la CI Windows.

**Pourquoi le test discrimine :** Sans le patch, `unsupportedPlatformNotice` n'existe pas et le fichier de test ne résout même pas son import — rouge immédiat. Mais l'argument fort est ailleurs : le correctif tentant et faux est d'ajouter simplement `win32` au ternaire de la ligne 110 pour télécharger le bon artefact et continuer à extraire ; sous ce correctif-là, la fonction renverrait `null` pour `"win32"` et `expect(notice).not.toBeNull()` tomberait — le test refuse donc explicitement la version « ça marche presque », pas seulement l'absence de code. L'assertion `not.toContain("linux")` verrouille en plus le symptôme d'origine, et le cas darwin/linux empêche le sur-correctif qui bloquerait tout le monde. Ce que le test unitaire ne couvre pas — que le garde-fou soit branché AVANT `fetchLatestTag()` dans l'action commander — est vérifié à la main à l'étape 4 : l'absence de la ligne « Checking for updates... » et `$LASTEXITCODE = 1`. Pour l'ajout de `windows-latest`, aucun test unitaire n'a de sens : un fichier de workflow ne s'exerce qu'en s'exécutant. La vérification est le premier run de CI sur la PR, dont le pré-vol exact et gratuit est `pnpm test` en local sur Windows à l'étape 5.

- [ ] **Étape 1 : Écrire le test d'abord — il doit échouer à l'import**

Créer `C:\Users\gagno\projet\essaim-new\tests\unit\self-update-platform.test.ts` avec exactement ce contenu :

```ts
// tests/unit/self-update-platform.test.ts
//
// `essaim self-update` résolvait la plateforme avec
// `process.platform === "darwin" ? "darwin" : "linux"` (cli/self-update.ts:110) :
// sur Windows il téléchargeait donc l'artefact LINUX et le détarait par-dessus
// le essaim.exe en cours d'exécution (cli/self-update.ts:126-131). Le binaire
// win32-x64 est pourtant publié, mais Windows verrouille l'image en cours :
// aucune extraction en place n'est possible. La commande doit s'arrêter en
// disant quoi faire, pas réussir à moitié.
//
// Le dépôt n'a aucun patron pour falsifier `process.platform` — il ne fait que
// le LIRE (`it.skipIf(process.platform === "win32")` dans
// tests/unit/orchestrator-write.test.ts:98). On suit donc le patron réellement
// en place ici pour tester une décision : une fonction pure exportée qui prend
// son entrée en paramètre, comme `buildSoloArgs` (tests/unit/solo.test.ts) ou
// `assembleSecurity` (tests/unit/security-cli.test.ts).
import { describe, it, expect } from "vitest";
import { unsupportedPlatformNotice } from "../../cli/self-update.js";

describe("self-update — garde Windows", () => {
  it("refuse win32 et dit quoi faire à la place", () => {
    const notice = unsupportedPlatformNotice("win32");
    expect(notice).not.toBeNull();
    // Actionnable, pas un simple « non ».
    expect(notice).toContain("npm install -g essaim@latest");
    expect(notice).toContain("releases/latest");
    // Régression directe : c'est l'artefact que la commande téléchargeait avant.
    expect(notice).not.toContain("linux");
  });

  it("laisse passer darwin et linux", () => {
    expect(unsupportedPlatformNotice("darwin")).toBeNull();
    expect(unsupportedPlatformNotice("linux")).toBeNull();
  });
});
```

Lancer :

```powershell
npx vitest run tests/unit/self-update-platform.test.ts
```

Résultat attendu : ROUGE, avec une erreur de résolution du symbole du type `No "unsupportedPlatformNotice" export is defined on the "../../cli/self-update.js" mock` / `SyntaxError: The requested module ... does not provide an export named 'unsupportedPlatformNotice'`. Si le test passe à ce stade, c'est que le fichier n'a pas été ramassé — vérifier son chemin.

- [ ] **Étape 2 : Ajouter la fonction de décision dans cli/self-update.ts**

Dans `C:\Users\gagno\projet\essaim-new\cli\self-update.ts`, la ligne 6 est actuellement :

```ts
const REPO = "swoofer/essaim";
```

Insérer juste APRÈS cette ligne (avant `type Source = "curl" | "gh";` ligne 8) :

```ts

/**
 * Windows n'a pas de chemin de mise à jour en place, pour deux raisons cumulées :
 *
 *  - le résolveur de plateforme plus bas ne connaît que darwin et linux, si bien
 *    que win32 retombait sur l'artefact `linux-x64` et le détarait par-dessus le
 *    essaim.exe en cours d'exécution ;
 *  - même avec le bon artefact (win32-x64 EST publié par release-binaries.yml),
 *    le chargeur d'image Windows garde essaim.exe verrouillé tant que le
 *    processus vit : tar échouerait en « Access is denied », potentiellement à
 *    mi-extraction. S'ajoutent les commandes POSIX de ce fichier — `command -v`,
 *    `mktemp -d`, `mv`, `rm -rf` — qui n'existent pas sous cmd.exe.
 *
 * Plutôt qu'une réussite mensongère, on s'arrête en disant quoi faire.
 *
 * Retourne `null` quand la plateforme sait se mettre à jour, sinon le message à
 * afficher. La plateforme est un PARAMÈTRE (et non `process.platform` lu à
 * l'intérieur) pour rester testable sans falsifier le global.
 */
export function unsupportedPlatformNotice(platform: NodeJS.Platform): string | null {
  if (platform !== "win32") return null;
  return [
    "Error: `essaim self-update` ne fonctionne pas sur Windows.",
    "Windows verrouille l'exécutable en cours : essaim.exe ne peut pas se remplacer",
    "lui-même, et cette commande n'a jamais eu de chemin de mise à jour en place ici.",
    "",
    "Mettre à jour à la main :",
    "  - installé via npm : npm install -g essaim@latest",
    "  - binaire natif    : télécharger essaim-<version>-win32-x64.tar.gz sur",
    `                       https://github.com/${REPO}/releases/latest,`,
    "                       fermer toute instance d'essaim, puis remplacer essaim.exe",
    "                       et les dossiers behaviors/, presets/, compositions/, scripts/.",
  ].join("\n");
}
```

`NodeJS.Platform` est fourni par `@types/node` (^22.0.0, déjà en devDependency) sans import.

- [ ] **Étape 3 : Brancher le garde-fou dans l'action, avant tout appel réseau**

Toujours dans `C:\Users\gagno\projet\essaim-new\cli\self-update.ts`, les lignes 84 et 85 sont actuellement :

```ts
    .action(() => {
      const currentVersion = getVersion();
```

Les remplacer par :

```ts
    .action(() => {
      // Avant tout : ne pas payer un aller-retour réseau pour finir par écrire
      // un binaire de la mauvaise plateforme par-dessus celui qui tourne.
      const notice = unsupportedPlatformNotice(process.platform);
      if (notice) {
        console.error(notice);
        process.exit(1);
        return;
      }

      const currentVersion = getVersion();
```

(Le doublon `process.exit(1); return;` reprend le patron déjà utilisé lignes 95-96 du même fichier : `process.exit` a le type `never` mais TypeScript ne le propage pas au flux de commander, et le `return` garde l'analyse d'assignation définie de `latest`/`source` satisfaite.)

Ensuite, la ligne 110 est actuellement :

```ts
      const platform = process.platform === "darwin" ? "darwin" : "linux";
```

Ajouter le commentaire juste au-dessus, pour que personne ne réintroduise le défaut :

```ts
      // win32 est déjà sorti en tête d'action : il ne reste que darwin et linux.
      const platform = process.platform === "darwin" ? "darwin" : "linux";
```

Puis relancer :

```powershell
npx vitest run tests/unit/self-update-platform.test.ts
```

Résultat attendu : VERT, `2 passed`.

- [ ] **Étape 4 : Vérification manuelle sur Windows + compilation**

Le test ci-dessus valide la décision, pas le câblage dans commander. Vérifier le câblage à la main, sur cette machine Windows :

```powershell
pnpm dev -- self-update
echo "exit code = $LASTEXITCODE"
```

Sortie attendue, sur stderr, immédiate (aucun « Checking for updates... », aucun accès réseau) :

```
Error: `essaim self-update` ne fonctionne pas sur Windows.
Windows verrouille l'exécutable en cours : essaim.exe ne peut pas se remplacer
lui-même, et cette commande n'a jamais eu de chemin de mise à jour en place ici.

Mettre à jour à la main :
  - installé via npm : npm install -g essaim@latest
  - binaire natif    : télécharger essaim-<version>-win32-x64.tar.gz sur
                       https://github.com/swoofer/essaim/releases/latest,
                       fermer toute instance d'essaim, puis remplacer essaim.exe
                       et les dossiers behaviors/, presets/, compositions/, scripts/.
```

et `exit code = 1`. Si la ligne « Checking for updates... » apparaît, le garde-fou a été placé trop bas dans l'action.

Puis vérifier que tsc est content :

```powershell
pnpm build
```

Résultat attendu : aucune sortie, code 0.

- [ ] **Étape 5 : Créer .gitattributes — sans lui, la jambe Windows de la CI est du bruit**

Constat mesuré sur ce dépôt : le blob committé de `tests/track_activity_path_normalization.test.sh` est en LF (`git cat-file -p HEAD:tests/track_activity_path_normalization.test.sh | od -c | head -1` donne `# ! / b i n / b a s h \n`), mais la copie de travail locale est en CRLF, parce que `git config --get core.autocrlf` répond `true`. C'est le réglage par défaut de Git for Windows, y compris sur le runner `windows-latest`.

Or `tests/unit/shell-scripts.test.ts:45` exécute `run("bash", [join(TESTS_DIR, script)], ...)` et `bash` EST sur le PATH du runner Windows (Git Bash), donc `HAS_BASH` vaut `true` et les deux `.test.sh` seront réellement lancés — avec des `\r` en fin de ligne, que bash n'ignore pas.

Créer `C:\Users\gagno\projet\essaim-new\.gitattributes` avec exactement :

```
# Les tests shell (tests/*.test.sh) et les hooks de scripts/ sont exécutés par
# bash — y compris sur Windows (Git Bash) et sur le runner windows-latest, où
# core.autocrlf=true est le défaut. Sans cette règle ils sortent du checkout en
# CRLF et bash meurt sur « $'\r': command not found », ce qui noierait les vrais
# échecs Windows sous du bruit d'encodage.
*.sh text eol=lf
```

Les blobs étant déjà en LF, aucune renormalisation n'est nécessaire : `git add --renormalize .` ne produira aucun diff. Il reste à rafraîchir la copie de travail locale (le checkout CI, lui, sera correct d'emblée) :

```powershell
Remove-Item tests\*.test.sh, scripts\*.sh
git checkout -- tests/ scripts/
```

Vérifier :

```powershell
(Get-Content tests\track_activity_path_normalization.test.sh -Raw).Contains("`r`n")
```

Résultat attendu : `False` (avant l'opération, c'était `True`).

Enfin, lancer la suite complète en local — c'est le pré-vol gratuit qui donne la liste exacte des échecs Windows AVANT de payer un aller-retour CI :

```powershell
pnpm test
```

Noter précisément quels fichiers rougissent : la stratégie de traitement est décrite dans les risques.

- [ ] **Étape 6 : Ajouter windows-latest à la matrice du job test**

Dans `C:\Users\gagno\projet\essaim-new\.github\workflows\test.yml`, remplacer INTÉGRALEMENT les lignes 30 à 46 (le job `test`, depuis `  test:` jusqu'à `      - run: pnpm build`) par :

```yaml
  # Windows est à la fois la plateforme de développement de ce dépôt et une
  # cible livrée (release-binaries.yml publie essaim-<version>-win32-x64.tar.gz),
  # et pourtant rien ne l'exerçait ici : les deux jobs étaient sur ubuntu-latest.
  # C'est ce trou qui a laissé passer le résolveur de plateforme de
  # cli/self-update.ts, qui servait l'artefact Linux aux utilisateurs Windows.
  test:
    strategy:
      # Même raison que dans release-binaries.yml : sans ceci, l'échec d'UNE
      # jambe annule l'autre, et on perd l'information qui compte — la
      # régression est-elle globale ou spécifique à Windows ?
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - uses: pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6.0.10

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: "24"
          cache: "pnpm"

      - run: pnpm install --frozen-lockfile

      - run: pnpm test

      - run: pnpm build
```

Ne PAS toucher au job `no-domain-artifacts` (lignes 13 à 28) : c'est un `git grep` sur des fichiers suivis, son résultat est identique sur les deux OS et le dupliquer ne ferait que doubler la facture.

Aucun `continue-on-error` n'est ajouté, ni au job ni aux étapes : un job qui ne peut pas échouer ne teste rien.

- [ ] **Étape 7 : Corriger les deux lignes fausses de CLAUDE.md**

Dans `C:\Users\gagno\projet\essaim-new\CLAUDE.md`.

Ligne 16, actuellement :

```
CI (`.github/workflows/test.yml`) runs exactly `pnpm install && pnpm test && pnpm build` on Node 24. There is no lint or format script — don't invent one.
```

La remplacer par :

```
CI (`.github/workflows/test.yml`) runs exactly `pnpm install && pnpm test && pnpm build` on Node 24, on a `ubuntu-latest` + `windows-latest` matrix with `fail-fast: false`. There is no lint or format script — don't invent one.
```

Ligne 70, actuellement :

```
One chmod test is Windows-only and skips on macOS/Linux.
```

Cette phrase est l'inverse du code. Le test réel est `tests/unit/orchestrator-write.test.ts:98` — `it.skipIf(process.platform === "win32")("writes hook scripts with 0o755 permissions", () => {` — et son commentaire lignes 92 à 97 dit « POSIX seulement : Windows n'implémente pas les bits de permission POSIX. » La remplacer par :

```
One chmod test is POSIX-only and skips on Windows — `it.skipIf(process.platform === "win32")` in `tests/unit/orchestrator-write.test.ts`, because Windows has no POSIX permission bits (`fs.chmod` there only drives the read-only attribute). That's the pattern to follow if the Windows CI leg turns up a test asserting a POSIX-only reality: a documented `skipIf`, never a `continue-on-error`.
```

- [ ] **Étape 8 : Commit**

```powershell
git add cli/self-update.ts tests/unit/self-update-platform.test.ts .gitattributes .github/workflows/test.yml CLAUDE.md
git commit -F -
```

Message exact à coller :

```
fix(windows): self-update servait l'artefact Linux, et la CI ne voyait jamais Windows

Deux défauts de la même cause : Windows était la plateforme de dev et une
plateforme livrée, mais rien ne l'exerçait.

cli/self-update.ts:110 résolvait la plateforme par un ternaire à deux branches,
`process.platform === "darwin" ? "darwin" : "linux"`. Sur win32 la condition est
fausse : la commande téléchargeait essaim-<version>-linux-x64.tar.gz — qui existe
vraiment — et le détarait dans dirname(process.execPath), c'est-à-dire des ELF
Linux écrits par-dessus une installation Windows. Le reste du fichier pilote de
toute façon `command -v`, `mktemp -d`, `mv` et `rm -rf` via execSync, absents de
cmd.exe, et Windows verrouille l'exécutable en cours : le remplacement en place
est impossible, pas seulement mal ciblé. La commande sort maintenant en code 1
avec la marche à suivre (npm ou tarball win32-x64), avant tout appel réseau.

.github/workflows/test.yml : le job `test` passe en matrice ubuntu-latest +
windows-latest, fail-fast: false. Pas de continue-on-error — un job qui ne peut
pas échouer ne teste rien.

.gitattributes force LF sur les *.sh : core.autocrlf=true est le défaut du runner
Windows, et tests/unit/shell-scripts.test.ts y trouve bash (Git Bash), donc les
deux tests shell auraient échoué sur des \r plutôt que sur du fond.

CLAUDE.md disait « One chmod test is Windows-only and skips on macOS/Linux » —
exactement l'inverse de it.skipIf(process.platform === "win32") dans
tests/unit/orchestrator-write.test.ts:98. Corrigé, ainsi que la description de la
CI qui ne mentionnait qu'un runner.
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**FAIT FAUX (risque n°3) — « `pnpm install --frozen-lockfile` déclenche la compilation de `better-sqlite3` [...] cette compilation échoue sur Windows faute de Visual Studio ». C'est faux pour la version réellement résolue. `node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/package.json` n'a AUCUN script `install`/`postinstall` (`scripts` = build-release, build-debug, test, benchmark, download, clean) et le champ `files` embarque `prebuilds/**` : le dossier contient darwin-arm64.node, darwin-x64.node, linux-arm64.node, linux-x64.node, linuxmusl-*.node, win32-arm64.node ET win32-x64.node. Preuve empirique décisive : ce dépôt est développé sous Windows, node_modules y est installé, et `.../better-sqlite3/build/` est VIDE — rien n'a jamais été compilé sur cette machine. Le risque tel qu'écrit envoie l'implémenteur ajouter une étape MSVC pour un problème inexistant, et il propage une affirmation périmée de release-binaries.yml:83-88.**

Remplacer intégralement le 3e élément du tableau `risques` par :

"`pnpm install --frozen-lockfile` ne compile RIEN sur la jambe Windows : `better-sqlite3@13.0.3` (résolu via `mcp-coordinator@^2.2.1`, qui déclare `better-sqlite3: ^13.0.3`) n'a aucun script `install`/`postinstall` — son `package.json` ne déclare que build-release, build-debug, test, benchmark, download, clean — et son champ `files` embarque `prebuilds/**`, où se trouvent déjà `win32-x64.node` et `win32-arm64.node` à côté des variantes linux/darwin/musl. `pnpm.onlyBuiltDependencies: [\"better-sqlite3\"]` (package.json:91-93) est donc sans effet sur cette version. Vérifié sur cette machine, qui est une machine Windows : `node_modules/.pnpm/better-sqlite3@13.0.3/node_modules/better-sqlite3/build/` est vide — aucune compilation n'a jamais eu lieu ici. Corollaire : le commentaire de release-binaries.yml lignes 83-88 (« n'a de prebuild que pour darwin [...] échoue sur Windows faute de Visual Studio ») décrit une version antérieure et n'est plus vrai ; son `--ignore-scripts` est aujourd'hui du folklore. NE PAS ajouter d'étape MSVC, et toujours pas de `--ignore-scripts` sur le job de test. Le seul risque d'install réel sur windows-latest serait l'absence des binaires optionnels par plateforme dans le lockfile ; il est écarté : `pnpm-lock.yaml` contient bien `@esbuild/win32-x64@0.28.2`, `@rolldown/binding-win32-x64-msvc@1.2.5` et `lightningcss-win32-x64-msvc@1.33.0` avec leurs `os: [win32]`."

**FAIT FAUX / SCÉNARIO INVÉRIFIÉ (objectif, contexte_necessaire, en-tête du test, message de commit) — la tâche affirme comme certain que sur Windows le téléchargement « réussirait » et que `tar` écrit « des exécutables ELF Linux par-dessus une installation Windows ». Ce n'est pas ce qui se produit sur une installation Windows standard. Vérifié sur cette machine (Windows 11) : `Get-Command mktemp` → ABSENT, alors que `curl` (C:\Windows\system32\curl.exe) et `tar` (C:\Windows\system32\tar.exe) existent. La séquence réelle est donc : `fetchLatestTag()` réussit via curl, la ligne 108 affiche « Update available », puis la ligne 115 `execSync("mktemp -d")` jette une erreur cmd.exe NON rattrapée — aucun téléchargement, aucun `tar`, aucun ELF. Le scénario ELF-par-dessus-l'exe n'est atteignable que si des coreutils traînent sur le PATH (option « Use Git and optional Unix tools », msys, cygwin, scoop). Le correctif reste bon ; c'est la justification qui est romancée, et elle est recopiée à l'identique dans le commit — donc dans l'historique du dépôt.**

(a) `objectif` — remplacer par :
"Arrêter `essaim self-update` avec un message actionnable sur Windows, au lieu de le laisser mourir à mi-parcours sur une commande POSIX absente — ou, quand des coreutils traînent sur le PATH, d'y déverser l'artefact Linux par-dessus l'exécutable en cours — et faire enfin tourner la suite de tests sur windows-latest."

(b) `contexte_necessaire` — remplacer la fin du 1er paragraphe, depuis « Ce nom résout réellement » jusqu'à « par-dessus une installation Windows. », par :
"Ce nom résout réellement (l'entrée `ubuntu-latest` de la matrice le publie). Ce qui arrive ensuite dépend du PATH, et il faut le dire précisément plutôt que de dramatiser : mesuré sur une Windows 11 à jour, `curl` et `tar` existent (C:\\Windows\\system32), mais `mktemp` non. Sur une installation standard, la commande affiche donc « Update available », puis la ligne 115 `execSync(\"mktemp -d\")` jette une erreur cmd.exe non rattrapée : l'utilisateur reçoit une stack trace, pas une mise à jour. Là où des coreutils SONT sur le PATH (option « Use Git and optional Unix tools » de Git for Windows, msys, cygwin, scoop), le pire chemin s'ouvre : le téléchargement de l'artefact Linux réussit et les lignes 128 à 131 le détarent avec `tar xzf \"${tarPath}\" -C \"${installDir}\" --strip-components=1`, où `installDir` vient de la ligne 126, `dirname(process.execPath)` — le dossier du binaire en train de s'exécuter. Autrement dit : des exécutables ELF Linux écrits par-dessus une installation Windows."

(c) Étape 1, en-tête du fichier de test — remplacer les 9 premières lignes de commentaire (de « // `essaim self-update` résolvait » à « disant quoi faire, pas réussir à moitié. ») par :
```ts
// `essaim self-update` n'a jamais eu de chemin de mise à jour sur Windows.
// Mesuré sur Windows 11 : `mktemp` n'est pas dans le PATH, donc
// cli/self-update.ts:115 `execSync("mktemp -d")` meurt sur une erreur cmd.exe
// non rattrapée, juste après avoir annoncé « Update available ». Et si des
// coreutils traînent sur le PATH, c'est pire : le résolveur de plateforme
// `process.platform === "darwin" ? "darwin" : "linux"` (cli/self-update.ts:110)
// demande l'artefact LINUX — qui existe vraiment — et cli/self-update.ts:126-131
// le détare dans dirname(process.execPath). Le binaire win32-x64 est pourtant
// publié, mais Windows verrouille l'image en cours : aucune extraction en place
// n'est possible. La commande doit s'arrêter en disant quoi faire.
```

(d) Étape 2, 1er bullet du JSDoc — remplacer par :
```
 *  - ce fichier pilote `command -v`, `mktemp -d`, `mv` et `rm -rf` via execSync,
 *    qui sous Windows lance cmd.exe : `mktemp` y est absent d'une installation
 *    standard, donc la commande meurt en cours de route ; et si des coreutils
 *    sont sur le PATH, le résolveur de plateforme plus bas ne connaît que darwin
 *    et linux, si bien que win32 retombe sur l'artefact `linux-x64` et le détare
 *    par-dessus le essaim.exe en cours d'exécution ;
```

(e) Étape 8, 2e paragraphe du message de commit — remplacer par :
```
cli/self-update.ts n'a jamais eu de chemin de mise à jour sur Windows. Le fichier
pilote `command -v`, `mktemp -d`, `mv` et `rm -rf` via execSync, qui sous Windows
lance cmd.exe : sur une installation standard la commande meurt sur `mktemp -d`
(ligne 115), non rattrapé, juste après avoir annoncé « Update available ». Là où
des coreutils traînent sur le PATH, c'est pire — le ternaire à deux branches de
la ligne 110, `process.platform === "darwin" ? "darwin" : "linux"`, fait
télécharger essaim-<version>-linux-x64.tar.gz, qui existe vraiment, et le détare
dans dirname(process.execPath) : des ELF Linux par-dessus une installation
Windows. Et même avec le bon artefact, Windows verrouille l'exécutable en cours :
le remplacement en place est impossible, pas seulement mal ciblé. La commande
sort maintenant en code 1 avec la marche à suivre (npm ou tarball win32-x64),
avant tout appel réseau.
```

**OMISSION — README.md:235 (`| `essaim self-update` | Update to the latest release |`, vérifié) est cité dans le contexte comme la preuve que la commande est documentée, mais aucune étape ne le corrige. Après le patch, le seul document destiné aux utilisateurs continue de promettre une mise à jour à quiconque est sous Windows, alors que la commande sort en code 1. La tâche corrige CLAUDE.md (interne) et laisse le README (public) mentir — exactement le défaut qu'elle prétend réparer.**

Ajouter une étape 7bis :

« Dans `C:\\Users\\gagno\\projet\\essaim-new\\README.md`, la ligne 235 est actuellement :

```
| `essaim self-update` | Update to the latest release |
```

La remplacer par :

```
| `essaim self-update` | Update the native binary to the latest release (macOS/Linux). On Windows it refuses and prints the manual route — `npm install -g essaim@latest`, or the `win32-x64` tarball — because Windows locks the running executable. |
```

(Une seule cellule de tableau, aucun `|` ajouté : la table reste valide.) »

Et à l'étape 8, remplacer la ligne `git add` par :

```powershell
git add cli/self-update.ts tests/unit/self-update-platform.test.ts .gitattributes .github/workflows/test.yml CLAUDE.md README.md
```

Enfin, ajouter au message de commit, avant le paragraphe CLAUDE.md :

```
README.md:235 promettait « Update to the latest release » sans réserve : la ligne
dit maintenant que Windows est refusé et par où passer.
```

**COMMANDE DESTRUCTRICE NON GARDÉE (étape 5) — `Remove-Item tests\*.test.sh, scripts\*.sh` suivi de `git checkout -- tests/ scripts/` écrase sans prévenir toute modification locale non commitée sur ces 9 fichiers suivis (2 tests + 7 hooks, vérifié par `git ls-files --eol`). Le reste du plan est prudent (il refuse `continue-on-error`, il documente `ESSAIM_RESET_BASE`), mais ici il fait perdre du travail en silence. La prémisse elle-même est vraie et vérifiée : `core.autocrlf=true` (origine `C:/Program Files/Git/etc/gitconfig`), `git ls-files --eol` donne `i/lf w/crlf` sur les 9 `.sh`, et le blob HEAD commence bien par `#!/bin/bash\n`.**

Remplacer le bloc PowerShell de rafraîchissement de l'étape 5 par :

```powershell
# Garde-fou : la séquence ci-dessous restaure depuis l'index et écraserait
# toute modification locale non commitée sur ces .sh.
git diff --quiet HEAD -- tests/*.test.sh scripts/*.sh
if ($LASTEXITCODE -ne 0) { throw "Modifications locales sur des .sh — commit ou stash avant de renormaliser." }

Remove-Item tests\*.test.sh, scripts\*.sh
git checkout -- tests/ scripts/
```

(Aujourd'hui `git diff --quiet HEAD` sort en 0 sur ces fichiers : la différence LF/CRLF est absorbée par `core.autocrlf`, c'est pourquoi `git status` est propre. Le garde ne se déclenche donc que sur de vraies éditions.)

**JUSTIFICATION FAUSSE (étape 3) — la parenthèse affirme que le `return;` après `process.exit(1)` « garde l'analyse d'assignation définie de `latest`/`source` satisfaite ». C'est vrai aux lignes 95-96 d'origine, où le `return` est dans le `catch` qui précède l'usage de `latest`. Au nouvel emplacement, le garde est inséré AVANT même la déclaration `let latest: string;` (ligne 88) : le `return` n'a plus aucun rapport avec l'assignation définie, il est simplement inatteignable. Le code compile quand même — `allowUnreachableCode` n'est pas positionné dans tsconfig.json, donc TS n'en fait qu'une suggestion d'éditeur, pas une erreur — mais un lecteur qui croit la parenthèse conclura à tort que le `return` est obligatoire.**

Étape 3 — remplacer la parenthèse explicative par :

« (Le `return` après `process.exit(1)` est inatteignable ici : contrairement aux lignes 95-96 d'origine, où il sert l'analyse d'assignation définie de `latest`/`source`, ce garde s'exécute avant que ces variables existent. Il est conservé uniquement par symétrie avec le patron déjà en place dans le fichier ; `tsconfig.json` ne positionne pas `allowUnreachableCode`, donc tsc n'en fait qu'une suggestion d'éditeur et `pnpm build` reste vert. Le supprimer est également correct.) »

**ATTENDU IMPOSSIBLE (étape 1) — le résultat rouge annoncé cite `No "unsupportedPlatformNotice" export is defined on the "../../cli/self-update.js" mock`. Ce message est celui de `vi.mock`, et le test n'appelle aucun mock — le dépôt n'en utilise nulle part pour ce cas (patron confirmé : `tests/unit/solo.test.ts:3` et `tests/unit/security-cli.test.ts:5` importent directement depuis `../../cli/*.js`). Un implémenteur qui n'obtient pas ce texte peut croire son test mal ramassé et aller chercher un problème de configuration inexistant.**

Étape 1 — remplacer le paragraphe « Résultat attendu » par :

« Résultat attendu : ROUGE dès l'import, avec un message du type `SyntaxError: [vite] The requested module '/cli/self-update.ts' does not provide an export named 'unsupportedPlatformNotice'` (le texte exact varie avec la version de vite-node ; ce qui compte est qu'il désigne l'export manquant, pas une assertion). Aucun mock n'est en jeu : comme `tests/unit/solo.test.ts:3` et `tests/unit/security-cli.test.ts:5`, ce test importe le module réel. Si le fichier passe au vert à ce stade, c'est qu'il n'a pas été ramassé — vérifier son chemin contre `include: ["tests/**/*.test.ts"]` de vitest.config.ts. »

**Risques :**
- Renommage des checks CI — le job `test` devient `test (ubuntu-latest)` et `test (windows-latest)`. Si `test` est un required status check sur la branche `main`, toutes les PR resteront bloquées à attendre un check dont le nom n'existe plus. À traiter dans le même passage : Settings → Branches → règle de `main` → remplacer `test` par les deux nouveaux noms. C'est le seul risque qui casse le dépôt plutôt que de révéler un défaut.
- AVERTISSEMENT ASSUMÉ : ajouter Windows VA probablement faire rougir des tests, et c'est le but. La stratégie n'est PAS un `continue-on-error`, ni au job ni aux étapes : il rendrait la matrice décorative (le check reste vert quoi qu'il arrive) tout en donnant l'illusion d'une couverture. Pour chaque échec, un choix explicite entre deux seulement : (a) le test décrit un vrai comportement produit cassé sur Windows → corriger le produit ; (b) le test assère une réalité que Windows n'a pas → `it.skipIf(process.platform === "win32")` AVEC un commentaire disant pourquoi, exactement comme celui déjà en place aux lignes 92 à 98 de tests/unit/orchestrator-write.test.ts. Un skip commenté est honnête et audité ; un continue-on-error est un mensonge silencieux. Si la première PR produit trop d'échecs pour être traitée d'un coup, la sortie de secours acceptable est de fusionner d'abord le correctif self-update seul, puis d'ouvrir la matrice dans une PR dédiée — jamais de neutraliser le job.
- `pnpm install --frozen-lockfile` déclenche la compilation de `better-sqlite3` : package.json déclare `pnpm.onlyBuiltDependencies: ["better-sqlite3"]`, et c'est une dépendance de `mcp-coordinator@^2.2.1`. Le commentaire de release-binaries.yml lignes 83 à 88 affirme, sur la foi d'un échec observé, que cette compilation échoue sur Windows faute de Visual Studio, et y répond par `--ignore-scripts`. Ce remède n'est PAS transposable ici : `src/orchestrator/orchestrator.ts:9` importe réellement `startServer` de `mcp-coordinator`, module chargé pour de vrai par tests/unit/orchestrator-write.test.ts entre autres, donc la liaison native doit exister. Si l'install casse sur la jambe Windows, les issues sont : ajouter une étape d'environnement MSVC avant l'install, ou vérifier qu'un prebuild win32-x64 existe pour better-sqlite3 13.x sur l'ABI de Node 24. Jamais `--ignore-scripts` sur le job de test.
- Les deux tests shell (`tests/track_activity_path_normalization.test.sh` et `tests/track_activity_secret_filtering.test.sh`) tourneront sur Windows, car `bashAvailable()` de tests/unit/shell-scripts.test.ts:19 trouve Git Bash sur le runner. Le `.gitattributes` de l'étape 5 supprime la cause d'échec la plus probable (CRLF), mais pas les hypothèses POSIX du contenu des scripts : `track_activity_path_normalization.test.sh` utilise `mktemp`/`chmod`/`realpath`, qui existent sous Git Bash mais peuvent se comporter différemment sur les chemins Windows. Si ces cas rougissent pour cette raison, ils relèvent de la branche (b) ci-dessus.
- Hors périmètre mais noté au passage, même famille de défaut : `cli/self-update.ts:111` mappe toute architecture non-arm64 sur `x64` et arm64 sur `arm64`, or la matrice de release-binaries.yml (lignes 42 à 62) ne publie PAS de `linux-arm64` — un utilisateur Linux arm64 obtient donc un 404 au téléchargement. Non corrigé ici pour garder le diff sur le seul cas Windows ; à traiter séparément.


---

### Tâche 3 : Le rapport de run cesse d'appeler « Consensus » un compteur de propositions

**Objectif :** Le tableau de `reports/*.md` arrête d'annoncer un accord qui n'a jamais eu lieu : les libellés deviennent honnêtes tout de suite, puis les compteurs sont recalculés à partir de l'événement `thread_resolved` (qui porte le vrai `resolution_type`) au lieu de `resolution_proposed`.

**Fichiers :**
- Créer : `tests/unit/report-thread-outcomes.test.ts` (fichier entier) — Test du libellé : le markdown produit par writeReport ne doit plus contenir « | Consensus | » ni « | Auto-resolved | ».
- Modifier : `src/orchestrator/reporter.ts` (96-97 (étape 2), puis 96-97 → 3 lignes (étape 6)) — Les deux lignes du tableau Markdown qui mentent. Aucun calcul ici, uniquement des chaînes de libellé.
- Test : `tests/unit/metrics.test.ts` (35-64) — Les deux cas qui verrouillent le comportement menteur (dédoublonnage de resolution_proposed + clamp). Réécrits pour asserter la sémantique thread_resolved.
- Modifier : `src/orchestrator/metrics.ts` (50-69) — computeMetrics : remplace la lecture de resolution_proposed par celle de thread_resolved / resolution_type.
- Modifier : `src/orchestrator/types.ts` (82) — Interface CoordinatorMetrics : ajout du champ threads_without_consensus.
- Modifier : `src/orchestrator/orchestrator.ts` (591) — Littéral CoordinatorMetrics de repli pour un run non coordonné — doit compiler avec le nouveau champ.
- Test : `tests/unit/orchestrator-run.test.ts` (36) — Mock vi.mock de fetchCoordinatorMetrics — garder le mock fidèle à la forme réelle.
- Test : `tests/unit/security-report.test.ts` (13) — Fixture baseResult typée RunResult — casserait la compilation sans le nouveau champ.

**Interfaces :**
- Consomme : Le flux SSE `GET /api/events` du coordinator, déjà lu par `fetchCoordinatorMetrics` (`src/orchestrator/metrics.ts`) et parsé par `parseSseEvents` en `SseEvent[]` (`{ id: number; type: string; data: Record<string, unknown> }`). Deux types d'événements sont utilisés : `thread_opened` (`data.thread_id`) et — c'est la nouveauté — `thread_resolved`, dont `data` porte `{ thread_id: string, resolution_type: string, resolution, approved_by, approved_by_name, created_at, resolved_at, had_messages }`. Aucune nouvelle route, aucune requête HTTP supplémentaire.
- Produit : L'interface `CoordinatorMetrics` (`src/orchestrator/types.ts`) gagne `threads_without_consensus: number`, et ses champs `threads_resolved_consensus` / `threads_auto_resolved` mesurent enfin ce que leur nom annonce. Côté sortie visible : le tableau de `reports/<base>.md` écrit par `writeReport` remplace les deux lignes `| Consensus |` et `| Auto-resolved |` par trois lignes — `| Consensus (approuvé par tous) |`, `| Auto-résolus (aucun agent concerné) |`, `| Sans consensus (timeout, empoisonnés, abandonnés) |` — dont la somme des deux premières plus la troisième égale `Threads ouverts`.

**Contexte nécessaire :**

essaim lance N agents Claude Code qui se coordonnent via un serveur externe, `mcp-coordinator` (même auteur, dépôt séparé, présent ici dans `node_modules/mcp-coordinator/`). Quand deux agents risquent de se marcher dessus, un « thread de consultation » s'ouvre côté coordinator ; il vit dans une table SQLite `threads` dont la colonne `status` vaut `open`, `resolving`, `resolved`, `cancelled` ou `poisoned`.

Le cycle de vie réel, vérifié dans `node_modules/mcp-coordinator/dist/src/consultation.js` : `proposeResolution` (ligne 193) fait `UPDATE threads SET status = 'resolving'` — une proposition ne résout RIEN. Seul `approveResolution` (lignes 209-222) bascule en `resolved`, et uniquement si `allRespondentsApproved` est vrai ; c'est là, et là seulement, qu'un vrai consensus existe.

essaim ne lit pas cette table. Il lit le flux SSE `/api/events` du coordinator et compte des ÉVÉNEMENTS (`src/orchestrator/metrics.ts`, fonction `computeMetrics`). Deux défauts s'y superposent.

(a) Le consensus est dérivé de l'événement `resolution_proposed` (metrics.ts ligne 50 : `const resolutionProposed = events.filter((e) => e.type === "resolution_proposed");`), c'est-à-dire d'une PROPOSITION. Côté coordinator cet événement est émis par `handleProposeResolution` (`dist/src/http/rest-handlers.js` ligne 396), juste avant le passage en `resolving`. À l'inverse, `handleApproveResolution` (ligne 405) n'émet AUCUN événement SSE : l'accord réel est structurellement absent du flux… sauf qu'un autre événement le porte, voir plus bas.

(b) L'auto-résolution est une soustraction de deux compteurs sans rapport : metrics.ts ligne 69, `threads_auto_resolved: Math.max(0, threadOpened.length - resolvedThreadIds.size)`. Le `Math.max(0, …)` est une rustine documentée juste au-dessus (lignes 66-68 : « Guarded: even after dedup this can go negative »). Elle ment dans les deux sens, et les rapports réels du dépôt le prouvent : `reports/report-1787758307294.md` affiche « Threads ouverts 3 » et « Consensus 4 », `reports/report-1787795697657.md` affiche « Threads ouverts 4 » et « Consensus 9 » — plus de threads « résolus par consensus » que de threads ouverts, avec « Auto-resolved 0 » par clamp.

Le poisoning, lui, est un ÉTAT DE TABLE et pas un événement : `dist/src/http/rest-handlers.js` ligne 274 fait `UPDATE threads SET status = 'poisoned' …` après trop d'unclaims, sans aucun `sseEmitter.emit`. Un thread empoisonné est donc invisible depuis le flux. Et les routes HTTP qu'essaim interroge ne le rattrapent pas : la seule route de LISTE est `/api/threads-active`, dont le handler (`dist/src/http/rest-handlers.js` lignes 436-449) code en dur `listThreads({status:"open"})` + `listThreads({status:"resolving"})`. Le filtre `status: "poisoned"` n'existe que dans l'outil MCP `list_threads` (`dist/src/tools/consultation-tools.js` ligne 367), pas en HTTP. Seule `GET /api/consultation/<thread_id>/status` (handler `handleConsultationStatus`, lignes 417-434) renvoie le vrai `status` — un thread à la fois.

La bonne nouvelle, trouvée en lisant `node_modules/mcp-coordinator/dist/src/server-setup.js` lignes 103-117 : le coordinator émet DÉJÀ, une fois par thread réellement clos, un événement `thread_resolved` portant `{ thread_id, resolution_type, resolution, approved_by, … }`, où `resolution_type` vaut `consensus`, `auto_resolved`, `timeout`, `max_rounds`, `closed` ou `agent_departure` (tous les appels à `emitResolution` : `consultation.js` lignes 221, 239, 270, 299, 304, 346 et `announce-workflow.js` ligne 49). Un `grep -rn "thread_resolved" src/` dans essaim ne renvoie RIEN : cet événement, déjà présent dans le flux qu'on parse, est jeté à la poubelle. Le vrai chiffre était là depuis le début, sans une seule requête HTTP supplémentaire.

Le défaut est resté invisible parce qu'aucun test n'assertait la sémantique : `tests/unit/metrics.test.ts` lignes 39-64 vérifie le dédoublonnage par `thread_id` (issue #117) et le clamp anti-négatif, c'est-à-dire qu'il verrouille précisément le comportement menteur. Ces deux cas seront réécrits ici.

**Pourquoi le test discrimine :** Le test de libellé (étape 1) échoue sans le patch parce que `writeReport` écrit littéralement la chaîne `` `| Consensus | ` `` et `` `| Auto-resolved | ` `` : le `not.toContain` la trouve. Il n'y a pas d'autre façon de le faire passer que de changer ces libellés — et il survit à l'étape 6 parce que la nouvelle ligne est `| Consensus (approuvé par tous) |`, qui ne contient pas la sous-chaîne testée. Les tests de `computeMetrics` (étape 4) discriminent sur deux axes indépendants : avec l'ancien calcul, un thread dont trois `resolution_proposed` ont été émis sans jamais aboutir est compté comme un consensus (`threads_resolved_consensus` vaut 1, ou 2 et 4 dans les autres cas, là où l'attendu est 0), et `threads_without_consensus` n'existe pas du tout — l'assertion lit `undefined`. Aucun de ces cas ne peut passer tant que la source de vérité reste `resolution_proposed`. Le cas « 4 ouverts, 9 propositions » reproduit exactement la forme de `reports/report-1787795697657.md`, le rapport réel qui annonçait « Consensus 9 » pour 4 threads.

- [ ] **Étape 1 : Écrire le test du libellé — il doit ÉCHOUER**

Créer `tests/unit/report-thread-outcomes.test.ts` (vitest ramasse automatiquement `tests/**/*.test.ts`, aucune inscription nécessaire) :

```ts
// tests/unit/report-thread-outcomes.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "../../src/orchestrator/reporter.js";
import type { RunResult } from "../../src/orchestrator/types.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Chiffres repris tels quels de reports/report-1787795697657.md, produit par un
// vrai run : « Threads ouverts 4 » et « Consensus 9 ». Le compteur « Consensus »
// était alimenté par les événements resolution_proposed — une PROPOSITION par
// round de contestation — et non par un accord, d'où plus de « consensus » que
// de threads ouverts.
function runReel(): RunResult {
  return {
    project_id: "p",
    project_name: "proj",
    mode: "with_coordinator",
    duration_ms: 1000,
    coordinator_metrics: {
      agents_count: 2,
      duration_total_ms: 1000,
      threads_opened: 4,
      threads_resolved_consensus: 9,
      threads_auto_resolved: 0,
      messages_exchanged: 2,
      conflicts_by_layer: {},
      introspections_triggered: 0,
      introspections_concerned: 0,
      avg_resolution_time_ms: 0,
      hot_files: [],
    },
    agent_results: [],
    custom_metrics: {},
  };
}

describe("writeReport — le tableau ne promet plus un accord qu'il n'a pas mesuré", () => {
  it("n'écrit plus « | Consensus | » ni « | Auto-resolved | »", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-"));
    const md = readFileSync(writeReport([runReel()], dir), "utf8");

    expect(md).not.toContain("| Consensus |");
    expect(md).not.toContain("| Auto-resolved |");
  });
});
```

Lancer :

```bash
npx vitest run tests/unit/report-thread-outcomes.test.ts
```

Résultat attendu : ÉCHEC, avec un message de la forme `expected '# Mini-projet Report…' not to contain '| Consensus |'`. Si le test passe à ce stade, c'est que le patch a déjà été appliqué — vérifier `git diff`.

- [ ] **Étape 2 : Rendre les deux libellés honnêtes — aucun calcul touché**

Dans `src/orchestrator/reporter.ts`, les lignes 96 et 97 sont aujourd'hui exactement :

```ts
    md += `| Consensus | ${r.coordinator_metrics.threads_resolved_consensus} |\n`;
    md += `| Auto-resolved | ${r.coordinator_metrics.threads_auto_resolved} |\n`;
```

Les remplacer par :

```ts
    // `threads_resolved_consensus` compte des événements `resolution_proposed`,
    // pas des accords : côté coordinator une proposition fait passer le thread en
    // `resolving`, jamais en `resolved`. `threads_auto_resolved` est la
    // soustraction `threads_opened - propositions`, clampée à 0. Tant que le
    // calcul n'a pas changé (seconde moitié de cette tâche), les libellés disent
    // ce qui est réellement mesuré.
    md += `| Résolutions proposées | ${r.coordinator_metrics.threads_resolved_consensus} |\n`;
    md += `| Threads sans résolution proposée | ${r.coordinator_metrics.threads_auto_resolved} |\n`;
```

Ne rien changer d'autre : ni `metrics.ts`, ni les noms de champs (`threads_resolved_consensus` reste tel quel dans le JSON du rapport à ce stade).

Relancer :

```bash
npx vitest run tests/unit/report-thread-outcomes.test.ts
```

Résultat attendu : 1 passed.

- [ ] **Étape 3 : Commiter la première moitié — elle est livrable seule**

```bash
git add tests/unit/report-thread-outcomes.test.ts src/orchestrator/reporter.ts
git commit -m "fix(reporter): le tableau n'appelle plus « Consensus » un compteur de propositions

reports/report-1787795697657.md annonce « Threads ouverts 4 » et « Consensus 9 ».
Le compteur est alimenté par les événements resolution_proposed, qui font passer
le thread du coordinator en 'resolving' et jamais en 'resolved' — une proposition
n'est pas un accord, et un thread contesté en émet un par round. « Auto-resolved »
est la soustraction threads_opened - propositions, clampée à 0 pour ne pas partir
en négatif.

Aucun calcul modifié ici : seuls les deux libellés du tableau, pour qu'ils disent
ce qui est réellement mesuré.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Étape 4 : Seconde moitié — réécrire les deux tests qui verrouillent le mensonge**

Dans `tests/unit/metrics.test.ts`, remplacer intégralement le bloc des lignes 35 à 64 (du commentaire `// #117 — a thread that gets contested…` jusqu'à l'accolade fermante du dernier `it`, celle de la ligne 64) par :

```ts
  // #117 — un thread contesté puis re-proposé émet PLUSIEURS resolution_proposed
  // pour le même thread_id, d'où le dédoublonnage d'origine. Mais le
  // dédoublonnage ne suffisait pas : `resolution_proposed` ne dit que « quelqu'un
  // a PROPOSÉ », et côté coordinator la proposition fait passer le thread en
  // `resolving`, pas en `resolved` (consultation.proposeResolution). Le consensus
  // se lit désormais sur `thread_resolved` / resolution_type === "consensus".
  it("une proposition n'est pas un consensus, même répétée", () => {
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 3, type: "resolution_proposed", data: { thread_id: "t1" } }, // contest → re-propose
      { id: 4, type: "resolution_proposed", data: { thread_id: "t1" } }, // contest → re-propose again
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_resolved_consensus).toBe(0);
    expect(metrics.threads_auto_resolved).toBe(0);
    expect(metrics.threads_without_consensus).toBe(1);
  });

  it("compte le consensus, l'auto-résolution et le reste à partir de thread_resolved", () => {
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "thread_opened", data: { thread_id: "t2" } },
      { id: 3, type: "thread_opened", data: { thread_id: "t3" } },
      // t1 : proposé trois fois, jamais approuvé — empoisonné ou abandonné.
      { id: 4, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 5, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 6, type: "resolution_proposed", data: { thread_id: "t1" } },
      // t2 : proposé PUIS approuvé par tous les respondents attendus.
      { id: 7, type: "resolution_proposed", data: { thread_id: "t2" } },
      { id: 8, type: "thread_resolved", data: { thread_id: "t2", resolution_type: "consensus" } },
      // t3 : aucun agent concerné — le coordinator clôt tout seul.
      { id: 9, type: "thread_resolved", data: { thread_id: "t3", resolution_type: "auto_resolved" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(3);
    expect(metrics.threads_resolved_consensus).toBe(1); // t2 seulement
    expect(metrics.threads_auto_resolved).toBe(1); // t3 seulement
    expect(metrics.threads_without_consensus).toBe(1); // t1
  });

  it("ne part pas en négatif quand la fenêtre d'événements rate le thread_opened", () => {
    // Le curseur SSE peut démarrer après le thread_opened d'un thread tout en
    // incluant sa résolution.
    const events = [
      { id: 1, type: "thread_resolved", data: { thread_id: "t1", resolution_type: "consensus" } },
      { id: 2, type: "thread_resolved", data: { thread_id: "t2", resolution_type: "consensus" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(0);
    expect(metrics.threads_resolved_consensus).toBe(2);
    expect(metrics.threads_without_consensus).toBe(0);
  });

  it("ne peut plus annoncer plus de consensus que de threads ouverts (report-1787795697657.md)", () => {
    // 4 threads ouverts, 9 propositions réparties sur eux : l'ancien calcul
    // imprimait « Consensus 9 ».
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "thread_opened", data: { thread_id: "t2" } },
      { id: 3, type: "thread_opened", data: { thread_id: "t3" } },
      { id: 4, type: "thread_opened", data: { thread_id: "t4" } },
      { id: 5, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 6, type: "resolution_proposed", data: { thread_id: "t2" } },
      { id: 7, type: "resolution_proposed", data: { thread_id: "t3" } },
      { id: 8, type: "resolution_proposed", data: { thread_id: "t4" } },
      { id: 9, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 10, type: "resolution_proposed", data: { thread_id: "t2" } },
      { id: 11, type: "resolution_proposed", data: { thread_id: "t3" } },
      { id: 12, type: "resolution_proposed", data: { thread_id: "t4" } },
      { id: 13, type: "resolution_proposed", data: { thread_id: "t1" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(4);
    expect(metrics.threads_resolved_consensus).toBe(0);
    expect(metrics.threads_without_consensus).toBe(4);
  });
```

Lancer :

```bash
npx vitest run tests/unit/metrics.test.ts
```

Résultat attendu : ÉCHEC sur les 4 nouveaux cas (le premier `it` de la suite, « counts threads by resolution type », reste vert). Messages typiques : `expected 1 to be 0` sur `threads_resolved_consensus`, et `expected undefined to be 1` sur `threads_without_consensus`, qui n'existe pas encore.

- [ ] **Étape 5 : Lire thread_resolved au lieu de resolution_proposed**

**5a — `src/orchestrator/types.ts`.** La ligne 82 est exactement `  threads_auto_resolved: number;`. Insérer juste après :

```ts
  // Threads ouverts pour lesquels le coordinator n'a jamais émis de thread_resolved
  // de type consensus ou auto_resolved : empoisonnés (unclaims répétés — un
  // UPDATE de table SANS aucun événement SSE), résolus par timeout, max_rounds,
  // ou simplement abandonnés. C'est le seul endroit du rapport où ces threads
  // existent encore.
  threads_without_consensus: number;
```

**5b — `src/orchestrator/metrics.ts`.** Remplacer intégralement les lignes 50 à 69 — c'est-à-dire de `  const resolutionProposed = events.filter((e) => e.type === "resolution_proposed");` jusqu'à `    threads_auto_resolved: Math.max(0, threadOpened.length - resolvedThreadIds.size),` incluse — par :

```ts
  // L'état FINAL d'un thread n'arrive que dans `thread_resolved` : le coordinator
  // l'émet une seule fois, au moment où la table bascule, avec un
  // `resolution_type` ∈ consensus | auto_resolved | timeout | max_rounds |
  // closed | agent_departure (mcp-coordinator, src/server-setup.ts, callback
  // consultation.onResolve).
  //
  // `resolution_proposed`, que ce calcul lisait, ne dit que « quelqu'un a
  // PROPOSÉ » : côté coordinator il fait passer le thread en `resolving`, jamais
  // en `resolved` (consultation.proposeResolution), et un thread contesté en
  // émet un par round. C'est ainsi qu'un run à 4 threads ouverts a imprimé
  // « Consensus 9 » (reports/report-1787795697657.md).
  //
  // Un thread `poisoned` — trop d'unclaims — n'émet AUCUN événement : c'est un
  // UPDATE de table. Il ne peut donc pas apparaître ici, et tombe dans
  // threads_without_consensus.
  const outcomeByThread = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "thread_resolved") continue;
    const id = e.data.thread_id;
    const type = e.data.resolution_type;
    if (typeof id === "string" && typeof type === "string") outcomeByThread.set(id, type);
  }
  const countOutcome = (want: string): number => {
    let n = 0;
    for (const type of outcomeByThread.values()) if (type === want) n++;
    return n;
  };
  const consensus = countOutcome("consensus");
  const autoResolved = countOutcome("auto_resolved");

  return {
    agents_count: 0,
    duration_total_ms: 0,
    threads_opened: threadOpened.length,
    threads_resolved_consensus: consensus,
    threads_auto_resolved: autoResolved,
    // Clamp conservé : la fenêtre d'événements peut contenir la résolution d'un
    // thread dont le thread_opened précède le curseur SSE.
    threads_without_consensus: Math.max(0, threadOpened.length - consensus - autoResolved),
```

La variable locale `resolutionProposed` et le `Set` `resolvedThreadIds` disparaissent : plus aucun appelant.

**5c — les trois littéraux qui doivent continuer à compiler.**

`src/orchestrator/orchestrator.ts` ligne 591, aujourd'hui `        threads_auto_resolved: 0, messages_exchanged: 0,` → remplacer par :

```ts
        threads_auto_resolved: 0, threads_without_consensus: 0, messages_exchanged: 0,
```

`tests/unit/security-report.test.ts` ligne 13, aujourd'hui `      threads_auto_resolved: 0, messages_exchanged: 0, conflicts_by_layer: {}, introspections_triggered: 0,` → remplacer par :

```ts
      threads_auto_resolved: 0, threads_without_consensus: 0, messages_exchanged: 0, conflicts_by_layer: {}, introspections_triggered: 0,
```

`tests/unit/orchestrator-run.test.ts` ligne 36, aujourd'hui `    threads_auto_resolved: 0,` → remplacer par :

```ts
    threads_auto_resolved: 0,
    threads_without_consensus: 0,
```

Lancer :

```bash
npx vitest run tests/unit/metrics.test.ts
```

Résultat attendu : 5 passed.

- [ ] **Étape 6 : Le tableau affiche les trois chiffres, maintenant vrais**

**6a — `src/orchestrator/reporter.ts`.** Les lignes 96-97 portent depuis l'étape 2 :

```ts
    md += `| Résolutions proposées | ${r.coordinator_metrics.threads_resolved_consensus} |\n`;
    md += `| Threads sans résolution proposée | ${r.coordinator_metrics.threads_auto_resolved} |\n`;
```

Les remplacer par :

```ts
    md += `| Consensus (approuvé par tous) | ${r.coordinator_metrics.threads_resolved_consensus} |\n`;
    md += `| Auto-résolus (aucun agent concerné) | ${r.coordinator_metrics.threads_auto_resolved} |\n`;
    md += `| Sans consensus (timeout, empoisonnés, abandonnés) | ${r.coordinator_metrics.threads_without_consensus} |\n`;
```

Le commentaire de trois lignes ajouté à l'étape 2 juste au-dessus décrit un calcul qui n'existe plus : le supprimer.

**6b — `tests/unit/report-thread-outcomes.test.ts`.** Le champ est maintenant obligatoire dans `CoordinatorMetrics`. Dans la fixture `runReel`, la ligne `      threads_auto_resolved: 0,` devient :

```ts
      threads_auto_resolved: 0,
      threads_without_consensus: 4,
```

Les assertions `not.toContain` restent valables : la nouvelle ligne s'écrit `| Consensus (approuvé par tous) | 9 |`, qui ne contient pas la sous-chaîne `| Consensus |`.

Lancer :

```bash
npx vitest run tests/unit/report-thread-outcomes.test.ts
```

Résultat attendu : 1 passed.

- [ ] **Étape 7 : Suite complète, build, commit**

```bash
pnpm test && pnpm build
```

Résultat attendu : la suite entière au vert (`vitest.config.ts` tourne avec `fileParallelism: false`, comptez quelques minutes), puis `tsc` sans erreur — le `include` du `tsconfig.json` couvre `src/`, `cli/` ET `tests/`, donc un des trois littéraux `CoordinatorMetrics` oublié à l'étape 5c ressort ici sous la forme `Property 'threads_without_consensus' is missing`.

```bash
git add src/orchestrator/metrics.ts src/orchestrator/types.ts src/orchestrator/orchestrator.ts src/orchestrator/reporter.ts tests/unit/metrics.test.ts tests/unit/report-thread-outcomes.test.ts tests/unit/orchestrator-run.test.ts tests/unit/security-report.test.ts
git commit -m "fix(metrics): compter le consensus sur thread_resolved, pas sur les propositions

Le coordinator émet déjà, une fois par thread réellement clos, un événement
'thread_resolved' portant resolution_type ∈ consensus | auto_resolved | timeout |
max_rounds | closed | agent_departure (server-setup.ts, callback
consultation.onResolve). Un grep 'thread_resolved' dans src/ ne renvoyait rien :
l'événement était dans le flux qu'on parse déjà, et on le jetait.

computeMetrics lit désormais cet événement. threads_resolved_consensus compte les
threads réellement approuvés par tous ; threads_auto_resolved ceux que le
coordinator a clos faute d'agent concerné ; le nouveau threads_without_consensus
porte le reste — timeout, max_rounds, et surtout les threads 'poisoned', qui sont
un UPDATE de table sans aucun événement SSE et n'apparaissaient donc nulle part.

Aucune requête HTTP supplémentaire : /api/threads-active ne liste que open +
resolving (statut codé en dur côté handler), et le filtre status:'poisoned'
n'existe que dans l'outil MCP list_threads, pas en REST.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**Numéro de ligne faux. La tâche cite `tests/unit/orchestrator-run.test.ts` ligne 36 pour `threads_auto_resolved: 0,` (tableau `fichiers` ET étape 5c). Lecture réelle du fichier : la ligne 36 est `    threads_resolved_consensus: 0,` et la ligne 37 est `    threads_auto_resolved: 0,`. Un développeur qui applique l'étape 5c à l'aveugle sur la ligne 36 insère le nouveau champ au mauvais endroit — ça compilerait quand même, mais l'instruction est fausse.**

Dans le tableau `fichiers`, remplacer l'entrée par :

{
 "chemin": "tests/unit/orchestrator-run.test.ts",
 "action": "test",
 "lignes": "37",
 "role": "Mock vi.mock de fetchCoordinatorMetrics — garder le mock fidèle à la forme réelle."
}

Et dans l'étape 5c, remplacer la phrase :

`tests/unit/orchestrator-run.test.ts` ligne 36, aujourd'hui `    threads_auto_resolved: 0,` → remplacer par :

par :

`tests/unit/orchestrator-run.test.ts` ligne 37 (la ligne 36 est `    threads_resolved_consensus: 0,`), aujourd'hui `    threads_auto_resolved: 0,` → remplacer par :

```ts
    threads_auto_resolved: 0,
    threads_without_consensus: 0,
```

**Fait faux sur le mécanisme, et le test de l'étape 4 censé reproduire le rapport ne le reproduit pas. La tâche affirme que « Consensus 9 » vient de plusieurs `resolution_proposed` sur les mêmes threads (« une proposition par round de contestation »). C'est impossible : le dédoublonnage par `thread_id` est en place depuis le commit 15e462e (2026-07-23, `metrics.ts:55-59`, `new Set(...)`), soit AVANT les deux rapports (2026-08-26 et 2026-08-27) — les worktrees du run le confirment (`runs/sentinelle-with_coordinator-1787794600187/.../metrics.ts:69` contient déjà `resolvedThreadIds.size`). Avec le code actuel, la fixture proposée (9 propositions réparties sur t1..t4) donne `threads_resolved_consensus = 4`, pas 9. Le test échoue quand même (4 ≠ 0), donc il discrimine, mais son titre, son commentaire et l'explication de `pourquoi_le_test_discrimine` (« l'ancien calcul imprimait Consensus 9 ») sont faux. La vraie cause : 9 `thread_id` DISTINCTS portaient un `resolution_proposed` alors que seulement 4 `thread_opened` tombaient dans la fenêtre SSE (le curseur `Last-Event-ID` est posé au démarrage du run — les threads hérités du run précédent sont proposés/résolus sans que leur ouverture soit rejouée).**

Étape 4 — remplacer intégralement le quatrième bloc `it` (celui intitulé « ne peut plus annoncer plus de consensus que de threads ouverts ») par :

```ts
  it("reproduit report-1787795697657 : 4 threads ouverts, « Consensus 9 », zéro accord réel", () => {
    // Un run réel a imprimé « Threads ouverts 4 | Consensus 9 | Auto-resolved 0 ».
    // Le dédoublonnage par thread_id (#117) était DÉJÀ en place à ce moment-là :
    // l'inflation ne vient donc pas de plusieurs propositions sur un même thread,
    // mais de neuf thread_id DISTINCTS proposés, dont cinq ont été ouverts hors de
    // la fenêtre SSE (curseur Last-Event-ID posé au démarrage du run ; threads
    // hérités du run précédent, proposés puis abandonnés). Aucun approuvé : aucun
    // thread_resolved dans le flux.
    const events = [
      { id: 1, type: "thread_opened", data: { thread_id: "t1" } },
      { id: 2, type: "thread_opened", data: { thread_id: "t2" } },
      { id: 3, type: "thread_opened", data: { thread_id: "t3" } },
      { id: 4, type: "thread_opened", data: { thread_id: "t4" } },
      { id: 5, type: "resolution_proposed", data: { thread_id: "t1" } },
      { id: 6, type: "resolution_proposed", data: { thread_id: "t2" } },
      { id: 7, type: "resolution_proposed", data: { thread_id: "t3" } },
      { id: 8, type: "resolution_proposed", data: { thread_id: "t4" } },
      { id: 9, type: "resolution_proposed", data: { thread_id: "t5" } },
      { id: 10, type: "resolution_proposed", data: { thread_id: "t6" } },
      { id: 11, type: "resolution_proposed", data: { thread_id: "t7" } },
      { id: 12, type: "resolution_proposed", data: { thread_id: "t8" } },
      { id: 13, type: "resolution_proposed", data: { thread_id: "t9" } },
    ];

    const metrics = computeMetrics(events);
    expect(metrics.threads_opened).toBe(4);
    expect(metrics.threads_resolved_consensus).toBe(0); // l'ancien calcul imprimait 9
    expect(metrics.threads_auto_resolved).toBe(0);
    expect(metrics.threads_without_consensus).toBe(4);
  });
```

Cette fixture reproduit les trois chiffres imprimés : avec le code actuel elle rend `threads_opened 4`, `threads_resolved_consensus 9`, `threads_auto_resolved max(0, 4-9) = 0`, et l'échec est littéralement `expected 9 to be 0`.

Dans `contexte_necessaire`, remplacer la phrase :

« Le consensus est dérivé de l'événement `resolution_proposed` […] c'est-à-dire d'une PROPOSITION. »

suivie de l'explication « un thread contesté en émet un par round », par :

« Le consensus est dérivé de l'événement `resolution_proposed` (metrics.ts ligne 50), c'est-à-dire d'une PROPOSITION, dédoublonnée par `thread_id` depuis #117 (metrics.ts lignes 55-59). Le dédoublonnage ne corrige rien : il compte les threads pour lesquels quelqu'un a proposé quelque chose, pas ceux où un accord a eu lieu. Et il n'empêche pas le compteur de dépasser `threads_opened`, parce que les deux compteurs ne portent pas sur le même ensemble de threads : le curseur `Last-Event-ID` est posé au démarrage du run, donc un thread hérité du run précédent est proposé/résolu dans la fenêtre sans que son `thread_opened` y soit rejoué. C'est ainsi qu'un run à 4 threads ouverts a affiché « Consensus 9 ». »

Et dans `pourquoi_le_test_discrimine`, remplacer la dernière phrase par :

« Le cas « 4 ouverts, 9 thread_id proposés » reproduit exactement les trois chiffres du rapport réel — `threads_opened 4`, `threads_resolved_consensus 9`, `threads_auto_resolved 0` — et échoue avec `expected 9 to be 0`. »

**Invariant annoncé faux, à deux endroits. (a) `interfaces.produit` affirme que la somme des deux premières lignes plus la troisième « égale Threads ouverts ». Faux : `threads_without_consensus = Math.max(0, threads_opened - consensus - auto_resolved)`, donc dès que `consensus + auto > opened` — exactement le cas observé dans les deux rapports cités — le clamp casse l'identité et la somme DÉPASSE `Threads ouverts`. (b) Le titre du test « ne peut plus annoncer plus de consensus que de threads ouverts » promet une borne que le correctif n'établit pas : rien ne borne `threads_resolved_consensus` par `threads_opened`. Si 9 threads atteignent réellement le consensus alors que 4 seulement ont leur `thread_opened` dans la fenêtre, le nouveau tableau réimprimera « Threads ouverts 4 | Consensus 9 ». (Le titre est déjà remplacé par la correction précédente ; il reste à corriger l'énoncé de `interfaces.produit` et le risque associé.)**

Dans `interfaces.produit`, remplacer :

« — dont la somme des deux premières plus la troisième égale `Threads ouverts`. »

par :

« — dont les deux premières sont des comptages directs d'événements `thread_resolved`, et la troisième un RÉSIDU clampé : `Math.max(0, threads_opened - consensus - auto_resolved)`. L'identité `consensus + auto + sans_consensus = threads_opened` ne tient que si `consensus + auto ≤ threads_opened` ; quand la fenêtre SSE contient la résolution d'un thread ouvert avant le curseur, le clamp rend `sans_consensus = 0` et la somme dépasse `Threads ouverts`. Le correctif change la SOURCE des deux premiers compteurs, il ne les borne pas par `threads_opened`. »

Et remplacer le deuxième élément de `risques` par :

« threads_without_consensus est un résidu, pas une mesure directe : il vaut Math.max(0, threads_opened - consensus - auto_resolved). Deux conséquences assumées. (1) Le correctif ne garantit PAS que « Consensus » reste inférieur ou égal à « Threads ouverts » : le curseur Last-Event-ID est posé au démarrage du run, donc un thread ouvert par un run précédent puis réellement approuvé pendant celui-ci compte en consensus sans compter en ouvert. Le rapport peut encore afficher 4 ouverts / 9 consensus — la différence, c'est que ces 9 seront désormais de vrais accords et non des propositions. (2) Dans ce cas le résidu est clampé à 0, donc « Sans consensus » sous-compte silencieusement. Borner correctement les deux exigerait un filtrage run_id côté coordinator, hors périmètre ici. »

**Résultats attendus faux. (a) Étape 5 annonce « Résultat attendu : 5 passed » pour `npx vitest run tests/unit/metrics.test.ts`. Le fichier contient `describe("parseSseEvents")` avec 1 test (lignes 4-17) plus `describe("computeMetrics")` avec le cas conservé « counts threads by resolution type » et les 4 nouveaux : vitest rapportera 6 passed, pas 5. (b) Étape 4 annonce comme message d'échec typique « `expected undefined to be 1` sur `threads_without_consensus` ». Inatteignable : dans les cas 1, 2 et 4, l'assertion sur `threads_resolved_consensus` précède celle sur `threads_without_consensus` et vitest s'arrête à la première assertion fausse ; dans le cas 3, c'est `threads_resolved_consensus` qui casse en premier aussi. Aucun des quatre cas n'atteint jamais l'assertion sur le nouveau champ avant le patch.**

Étape 4 — remplacer le paragraphe de résultat attendu par :

« Résultat attendu : ÉCHEC sur les 4 nouveaux cas ; le premier `it` de la suite, « counts threads by resolution type », et le `describe("parseSseEvents")` restent verts — soit 2 passed, 4 failed. Chaque échec tombe sur l'assertion `threads_resolved_consensus`, qui précède celle du nouveau champ : `expected 1 to be 0`, `expected 2 to be 1`, `expected 0 to be 2`, `expected 9 to be 0`. Les assertions sur `threads_without_consensus` ne sont jamais atteintes avant le patch — vitest s'arrête à la première assertion fausse. »

Étape 5 — remplacer :

« Résultat attendu : 5 passed. »

par :

« Résultat attendu : 6 passed (1 dans `describe("parseSseEvents")`, 5 dans `describe("computeMetrics")`). »

**Preuve citée introuvable pour le lecteur. La tâche s'appuie sur `reports/report-1787758307294.md` et `reports/report-1787795697657.md` comme sur des fichiers du dépôt (« les rapports réels du dépôt le prouvent »), et le test de l'étape 1 dit « Chiffres repris tels quels de reports/report-1787795697657.md ». Or `.gitignore` contient `reports/` et `git ls-files reports` ne retourne rien : ces fichiers sont des artefacts locaux, absents de tout clone. Un lecteur qui « ne connaît NI ce dépôt » ne peut vérifier aucun des chiffres qui motivent la tâche.**

Dans `contexte_necessaire`, remplacer :

« Elle ment dans les deux sens, et les rapports réels du dépôt le prouvent : `reports/report-1787758307294.md` affiche « Threads ouverts 3 » et « Consensus 4 », `reports/report-1787795697657.md` affiche « Threads ouverts 4 » et « Consensus 9 » — plus de threads « résolus par consensus » que de threads ouverts, avec « Auto-resolved 0 » par clamp. »

par :

« Elle ment dans les deux sens. Deux rapports produits par de vrais runs le montrent — `reports/` est gitignoré, ces fichiers n'existent donc que sur la machine qui a lancé le run, mais les chiffres sont reproduits ici en entier :

```
| Threads ouverts | 3 |   | Threads ouverts | 4 |
| Consensus       | 4 |   | Consensus       | 9 |
| Auto-resolved   | 0 |   | Auto-resolved   | 0 |
```

Plus de threads « résolus par consensus » que de threads ouverts, et « Auto-resolved 0 » par clamp. Le test de l'étape 4 rejoue exactement la seconde forme, ce qui la rend vérifiable sans le fichier. »

Et dans le test de l'étape 1, remplacer le commentaire de la fixture par :

```ts
// Chiffres d'un run réel (rapport local, reports/ est gitignoré) : « Threads
// ouverts 4 » et « Consensus 9 ». Le compteur « Consensus » était alimenté par
// les événements resolution_proposed dédoublonnés par thread_id — donc par des
// PROPOSITIONS, sur un ensemble de threads qui n'est même pas celui des
// thread_opened observés. D'où plus de « consensus » que de threads ouverts.
```

**Risques :**
- Le compte de threads EMPOISONNÉS reste inaccessible depuis essaim. Vérifié en lisant node_modules/mcp-coordinator : la seule route de liste, /api/threads-active, code en dur listThreads({status:'open'}) + listThreads({status:'resolving'}) dans son handler ; le filtre status:'poisoned' n'existe que dans l'outil MCP list_threads, pas en HTTP. Seule GET /api/consultation/<thread_id>/status renvoie le vrai statut, un thread à la fois. threads_without_consensus les inclut sans les distinguer d'un timeout ou d'un max_rounds. Séparer les deux demanderait soit N requêtes par run (les thread_id sont déjà dans les événements thread_opened qu'on parse), soit une route de liste filtrable côté coordinator — un changement dans l'AUTRE dépôt, qui nous appartient aussi (mcp-coordinator). Ne pas l'inventer ici : le rapport n'en a pas besoin pour cesser de mentir.
- threads_without_consensus est un résidu, pas une mesure directe : il vaut threads_opened - consensus - auto_resolved. Si la fenêtre SSE rate le thread_opened d'un thread mais capte son thread_resolved, le résidu part en négatif — d'où le Math.max(0, …) conservé, testé explicitement à l'étape 4. Ce clamp reste une approximation assumée de la fenêtre d'événements, pas de la table.
- Le champ threads_without_consensus est OBLIGATOIRE dans CoordinatorMetrics. tsconfig.json inclut tests/**/*.ts, donc les trois littéraux de l'étape 5c doivent tous être corrigés ou pnpm build échoue — ce qui est voulu : un compteur manquant qui se lirait silencieusement 0 est exactement la classe de bug corrigée ici.
- computeMetrics ne dédoublonne plus resolution_proposed puisqu'il ne le lit plus. Si un futur besoin réclame « combien de propositions ont été faites », c'est un compteur à ajouter, pas un comportement à restaurer : le dédoublonnage d'origine (#117) rendait un chiffre faux moins faux, il ne le rendait pas vrai.
- Le nom des champs du JSON de rapport (reports/*.json) change de sémantique sans changer de nom pour threads_resolved_consensus et threads_auto_resolved. Un outil externe qui comparerait des rapports d'avant et d'après verra une rupture de série silencieuse. Le nouveau champ threads_without_consensus sert de marqueur : sa présence identifie un rapport produit après ce correctif.


---

### Tâche 4 : Code de sortie réel pour `essaim run` (échec TOTAL uniquement) + colonne `Raison` dans le tableau des agents

**Objectif :** Faire sortir `essaim run` en 1 quand et seulement quand TOUS les agents ont échoué, et afficher `exit_reason` — déjà persisté dans le JSON — comme colonne du tableau `### Agents` du rapport Markdown.

**Fichiers :**
- Modifier : `src/orchestrator/reporter.ts` (117-121 (en-tête + boucle du tableau `### Agents`)) — Ajoute la colonne `Raison` alimentée par `AgentResult.exit_reason`, avec `N/A` quand le champ est absent.
- Test : `tests/unit/report-exit-reason.test.ts` (nouveau fichier (~45 lignes)) — Vérifie l'en-tête et deux lignes : agent mort en route (raison présente) vs agent jamais démarré (raison absente → N/A).
- Modifier : `cli/run.ts` (1-5 (imports), 73-101 (corps de l'action), + fonction exportée `runExitCode` insérée après la ligne 103) — Capture le `RunResult` de `executeRun`, calcule le code de sortie et le passe à `process.exit` à la place du 0 littéral.
- Test : `tests/unit/run-exit-code.test.ts` (nouveau fichier (~55 lignes)) — Épingle le prédicat : succès total → 0, échec partiel → 0, échec total → 1, zéro agent → 0, dry-run → 0.

**Interfaces :**
- Consomme : `RunResult` (src/orchestrator/types.ts lignes 91-101) tel que retourné par `executeRun(opts): Promise<RunResult | undefined>` (cli/run-core.ts ligne 42 ; `undefined` en dry-run, ligne 126). Dans ce RunResult : `agent_results: AgentResult[]`, dont `exit_code: number` (types.ts ligne 105, rempli par orchestrator.ts ligne 603) et `exit_reason?: ExitReason` (types.ts ligne 130, rempli par orchestrator.ts ligne 615, absent pour les agents jamais démarrés). `ExitReason` est l'union de src/agent-loop/agent-loop.ts lignes 71-80.
- Produit : 1) `export function runExitCode(result: RunResult | undefined): 0 | 1` dans cli/run.ts — fonction pure, sans effet de bord, importable en test (miroir exact de `securityExitCode(ledger: SecurityRunLedger): 0 | 1 | 2`, cli/security.ts ligne 90). 2) Le code de sortie du processus `essaim run` : 1 sur échec de pré-vol (inchangé), 1 sur échec total des agents (nouveau), 0 sinon ; le 2 reste réservé à `essaim security`. 3) Une colonne `Raison` entre `Exit` et `Compilation` dans le tableau `### Agents` du rapport Markdown produit par `writeReport(results, outputDir): string` (src/orchestrator/reporter.ts ligne 80). Le `.json` est inchangé : il portait déjà `exit_reason`.

**Contexte nécessaire :**

essaim est un orchestrateur : `essaim run <template>` lance N agents Claude Code en parallèle, chacun dans son propre worktree git, puis écrit un rapport (`.json` + `.md`) dans `reports/`. Le CLI est bâti sur commander : `cli/index.ts` enregistre une commande par fichier (`createRunCommand()` depuis `cli/run.ts`, `createSecurityCommand()` depuis `cli/security.ts`), et chaque commande possède son propre handler `.action()`. Les deux commandes partagent le même moteur, `executeRun()` (`cli/run-core.ts` ligne 42) qui fait scan → build → launch → `writeReport` et **retourne** un `RunResult` ; son docblock (`cli/run-core.ts` lignes 38-39 : « instead of calling process.exit, so callers (pipeline) can record the outcome ») dit explicitement pourquoi il n'appelle jamais `process.exit` — c'est la clé de toute cette tâche.

Premier défaut : `cli/run.ts` ligne 100 est `process.exit(0);`, un zéro littéral, quelle que soit l'issue. Le seul chemin non nul est le `catch` du pré-vol (lignes 90-93 : `process.exit(1)` sur template inconnu, projet non-git, `--agents` invalide). Un run où les quatre agents meurent sort donc 0 : impossible de câbler la commande dans un job CI ou un script.

Deuxième défaut : le tableau des agents du rapport n'a que quatre colonnes. `src/orchestrator/reporter.ts` ligne 117 écrit l'en-tête `| Agent | Exit | Compilation | Diff (lignes) |` et la ligne 120 la ligne de données. Or `AgentResult` porte depuis peu un champ `exit_reason?: ExitReason` (`src/orchestrator/types.ts` ligne 130, union définie dans `src/agent-loop/agent-loop.ts` lignes 71-80 : `"done" | "yielded" | "max_turns" | "budget_exceeded" | "process_died" | "deadline_exceeded" | "aborted" | "rate_limited" | "error"`), rempli par `src/orchestrator/orchestrator.ts` ligne 615 (`agentResults[i].exit_reason = loopResult.exitReason;`). Comme `writeReport` sérialise le JSON sans replacer (`reporter.ts` ligne 85), le champ part **déjà** dans le `.json` — mais le Markdown est composé champ par champ à la main et l'ignore. Vérifié sur un rapport réel du dépôt : `reports/report-1787795115144.json` contient `"exit_reason": "error"` alors que `reports/report-1787795115144.md` n'affiche que `| Sentinelle Bravo | 1 | OK | 0 |`.

Pourquoi cette colonne compte : un `exit_code` de 1 a deux origines très différentes. Soit l'agent a tourné puis sa boucle s'est arrêtée (`orchestrator.ts` ligne 532 : `code: r.value.exitReason === "done" ? 0 : 1`) — et là `exit_reason` est renseigné ; soit l'agent n'a **jamais démarré**, faute de pré-enregistrement auprès du coordinateur (`orchestrator.ts` lignes 574-575 posent `code: 1` avec le stderr « Skipped: failed coordinator pre-registration ») — et là il n'y a aucun `AgentLoopResult`, donc `exit_reason` reste `undefined`. Un `N/A` dans la colonne est donc une information, pas un trou.

Enfin le critère de sortie, non négociable : **TOUS**, pas « au moins un ». Une défaillance partielle est le régime normal d'un essaim. Le rapport réel `reports/report-1787758307294.md` montre `Sentinelle Alpha | 1`, `Bravo | 0 | OK | 17`, `Charlie | 1`, `Delta | 0 | OK | 19` : deux agents morts pendant que les deux autres livraient leur diff. Faire sortir ce run en erreur rendrait la commande inutilisable.

**Pourquoi le test discrimine :** Les cinq cas de `run-exit-code.test.ts` ne testent pas une valeur, ils encerclent le prédicat : le code actuel (`process.exit(0)` en dur) échoue au cas « échec total → 1 » ; une implémentation naïve « au moins un échec → 1 » échoue au cas « défaillance partielle 2/4 → 0 » et à lui seul ; une implémentation `every()` sans garde-fou de longueur passe ces deux-là mais échoue au cas « zéro agent → 0 », puisque `[].every()` vaut `true` ; et le cas dry-run interdit de faire planter la fonction sur `undefined`. Aucune des quatre implémentations plausibles ne survit aux cinq. Pour le rapport, `report-exit-reason.test.ts` assert la ligne complète `| Alpha | 1 | process_died | N/A | 0 |` : le format actuel produit `| Alpha | 1 | N/A | 0 |`, la sous-chaîne n'existe pas, et la deuxième assertion (`| Bravo | 1 | N/A | N/A | 0 |`) empêche de faire passer le test en supprimant simplement le `?? \"N/A\"` — la distinction « mort en route » / « jamais démarré » doit être réellement rendue.

- [ ] **Étape 1 : Test rouge du rapport — la colonne Raison n'existe pas encore**

Créer `tests/unit/report-exit-reason.test.ts`. Le patron est copié de `tests/unit/security-report.test.ts` (mkdtemp + `writeReport` qui retourne le chemin du `.md` + `readFileSync`).

```ts
// tests/unit/report-exit-reason.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "../../src/orchestrator/reporter.js";
import type { AgentResult, RunResult } from "../../src/orchestrator/types.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runResult(agents: AgentResult[]): RunResult {
  return {
    project_id: "p",
    project_name: "proj",
    mode: "with_coordinator",
    duration_ms: 1000,
    coordinator_metrics: {
      agents_count: agents.length, duration_total_ms: 1000, threads_opened: 0,
      threads_resolved_consensus: 0, threads_auto_resolved: 0, messages_exchanged: 0,
      conflicts_by_layer: {}, introspections_triggered: 0, introspections_concerned: 0,
      avg_resolution_time_ms: 0, hot_files: [],
    },
    agent_results: agents,
    custom_metrics: {},
  };
}

describe("writeReport — colonne Raison (exit_reason)", () => {
  it("distingue « mort en cours de route » de « jamais démarré »", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-exitreason-"));
    const md = readFileSync(
      writeReport(
        [
          runResult([
            // Agent lancé, boucle morte en route : exit_reason est recopié depuis
            // AgentLoopResult par orchestrator.ts:615.
            { agent_id: "a1", agent_name: "Alpha", exit_code: 1, diff: "", stdout_length: 0, exit_reason: "process_died" },
            // Agent JAMAIS démarré (échec de pré-enregistrement coordinateur,
            // orchestrator.ts:574-575) : exit_code 1, aucun AgentLoopResult,
            // donc exit_reason absent.
            { agent_id: "a2", agent_name: "Bravo", exit_code: 1, diff: "", stdout_length: 0 },
          ]),
        ],
        dir,
      ),
      "utf8",
    );

    expect(md).toContain("| Agent | Exit | Raison | Compilation | Diff (lignes) |");
    expect(md).toContain("| Alpha | 1 | process_died | N/A | 0 |");
    expect(md).toContain("| Bravo | 1 | N/A | N/A | 0 |");
  });
});
```

Lancer : `npx vitest run tests/unit/report-exit-reason.test.ts`
Attendu : ÉCHEC sur les trois `toContain` — le rapport actuel produit `| Alpha | 1 | N/A | 0 |` (quatre colonnes).

- [ ] **Étape 2 : Patch du reporter — deux lignes**

Dans `src/orchestrator/reporter.ts`, remplacer les lignes 117-121, actuellement :

```ts
    md += `| Agent | Exit | Compilation | Diff (lignes) |\n|-------|------|-------------|---------------|\n`;
    for (const a of r.agent_results) {
      const diffCell = a.diff_measured === false ? "N/A" : countDiffLines(a.diff);
      md += `| ${a.agent_name} | ${a.exit_code} | ${a.compilation_ok === undefined ? "N/A" : a.compilation_ok ? "OK" : "FAIL"} | ${diffCell} |\n`;
    }
```

par :

```ts
    md += `| Agent | Exit | Raison | Compilation | Diff (lignes) |\n|-------|------|--------|-------------|---------------|\n`;
    for (const a of r.agent_results) {
      const diffCell = a.diff_measured === false ? "N/A" : countDiffLines(a.diff);
      // exit_reason est absent quand l'agent n'a JAMAIS démarré : orchestrator.ts:574-575
      // pose exit_code 1 sans AgentLoopResult. "N/A" est donc une information
      // (« jamais lancé »), pas un trou de données.
      md += `| ${a.agent_name} | ${a.exit_code} | ${a.exit_reason ?? "N/A"} | ${a.compilation_ok === undefined ? "N/A" : a.compilation_ok ? "OK" : "FAIL"} | ${diffCell} |\n`;
    }
```

Aucun import à ajouter : `AgentResult` est déjà importé ligne 4 et porte `exit_reason`.

Relancer : `npx vitest run tests/unit/report-exit-reason.test.ts`
Attendu : 1 passed.

- [ ] **Étape 3 : Non-régression du reporter**

Deux autres fichiers touchent `writeReport`. Vérifier qu'aucun n'assertait sur la largeur du tableau (contrôlé : `security-report.test.ts` n'assertait que sur la section sécurité, `orchestrator-run.test.ts` ligne 525 relit le `.json`, pas le `.md`).

```
npx vitest run tests/unit/security-report.test.ts tests/unit/report-counters.test.ts tests/unit/orchestrator-run.test.ts
```
Attendu : tout vert, 0 failed.

- [ ] **Étape 4 : Test rouge du code de sortie — les quatre cas du prédicat**

Créer `tests/unit/run-exit-code.test.ts`. Le patron est celui de `tests/unit/security-cli.test.ts`, qui teste `securityExitCode` en important directement la fonction pure exportée par `cli/security.ts` — pas de sous-processus, pas de spawn du CLI.

```ts
// tests/unit/run-exit-code.test.ts
import { describe, it, expect } from "vitest";
import { runExitCode } from "../../cli/run.js";
import type { AgentResult, RunResult } from "../../src/orchestrator/types.js";

function agent(id: string, exit_code: number): AgentResult {
  return { agent_id: id, agent_name: id, exit_code, diff: "", stdout_length: 0 };
}

function runResult(agents: AgentResult[]): RunResult {
  return {
    project_id: "p",
    project_name: "proj",
    mode: "with_coordinator",
    duration_ms: 1000,
    coordinator_metrics: {
      agents_count: agents.length, duration_total_ms: 1000, threads_opened: 0,
      threads_resolved_consensus: 0, threads_auto_resolved: 0, messages_exchanged: 0,
      conflicts_by_layer: {}, introspections_triggered: 0, introspections_concerned: 0,
      avg_resolution_time_ms: 0, hot_files: [],
    },
    agent_results: agents,
    custom_metrics: {},
  };
}

describe("runExitCode — TOUS les agents, pas « au moins un »", () => {
  it("0 quand tous les agents réussissent", () => {
    expect(runExitCode(runResult([agent("a1", 0), agent("a2", 0)]))).toBe(0);
  });

  it("0 sur une défaillance PARTIELLE — 2 agents sur 4 est le régime normal d'un essaim", () => {
    // Cas réel du dépôt (reports/report-1787758307294.md) : Alpha 1, Bravo 0
    // (17 lignes de diff), Charlie 1, Delta 0 (19 lignes). Les survivants ont
    // livré ; le run est exploitable. Une implémentation « au moins un échec
    // → 1 » échoue ICI et nulle part ailleurs.
    expect(
      runExitCode(runResult([agent("a1", 1), agent("a2", 0), agent("a3", 1), agent("a4", 0)])),
    ).toBe(0);
  });

  it("1 quand TOUS les agents ont échoué", () => {
    expect(runExitCode(runResult([agent("a1", 1), agent("a2", 1)]))).toBe(1);
  });

  it("0 pour un run sans aucun agent : [].every() vaut true, ce n'est pas un échec", () => {
    // `essaim security --triage-only` vide project.agents (run-core.ts:103) et
    // un template peut légitimement n'en produire aucun.
    expect(runExitCode(runResult([]))).toBe(0);
  });

  it("0 pour un dry-run : executeRun renvoie undefined, rien n'a tourné", () => {
    expect(runExitCode(undefined)).toBe(0);
  });
});
```

Lancer : `npx vitest run tests/unit/run-exit-code.test.ts`
Attendu : ÉCHEC au chargement — `runExitCode` n'est pas exporté par `cli/run.ts` (message vitest du type « No "runExitCode" export is defined on the ... module »).

- [ ] **Étape 5 : Ajouter la fonction pure `runExitCode` dans cli/run.ts**

Dans `cli/run.ts`, ajouter l'import de type après la ligne 5 (`import { executeRun } from "./run-core.js";`) :

```ts
import type { RunResult } from "../src/orchestrator/types.js";
```

Puis insérer la fonction juste avant `export function createRunCommand(): Command {` (ligne 7) :

```ts
/**
 * Code de sortie de `essaim run` : 1 seulement si TOUS les agents ont échoué.
 *
 * Une défaillance partielle est le régime normal d'un essaim — le rapport réel
 * reports/report-1787758307294.md montre 2 agents sur 4 en exit 1 pendant que
 * les deux autres livraient leur diff. Sortir non nul là-dessus rendrait la
 * commande inutilisable en CI.
 *
 * Deux garde-fous :
 * - `undefined` = dry-run (executeRun ne retourne rien), donc 0 ;
 * - zéro agent = 0, parce que `[].every()` vaut `true` et signalerait à tort
 *   un échec pour un run qui n'a jamais eu l'intention de lancer un agent.
 *
 * Le prédicat lit `exit_code` et non `exit_reason` : un agent jamais démarré
 * (orchestrator.ts:574-575) a bien exit_code 1 mais aucun exit_reason.
 *
 * Cette fonction ne concerne QUE `essaim run`. `essaim security` garde son
 * propre contrat (securityExitCode, cli/security.ts:90) et `essaim pipeline`
 * le sien (pipeline.ts:108) — voir l'étape de vérification.
 */
export function runExitCode(result: RunResult | undefined): 0 | 1 {
  if (!result || result.agent_results.length === 0) return 0;
  return result.agent_results.every((a) => a.exit_code !== 0) ? 1 : 0;
}
```

Relancer : `npx vitest run tests/unit/run-exit-code.test.ts`
Attendu : 5 passed.

- [ ] **Étape 6 : Câbler l'action de run.ts sur runExitCode**

Toujours dans `cli/run.ts`, remplacer le bloc des lignes 73-100, actuellement :

```ts
        try {
          await executeRun({
            template,
```
… jusqu'à …
```ts
        if (opts.dryRun) {
          return;
        }
        // Force exit to release the in-process coordinator's HTTP server
        // (startServer does not expose a .close() handle).
        process.exit(0);
```

par :

```ts
        let result: RunResult | undefined;
        try {
          result = await executeRun({
            template,
            project: opts.project,
            agentCount: opts.agents ? parseInt(opts.agents, 10) : undefined,
            timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
            cleanup: opts.cleanup,
            dryRun: opts.dryRun,
            modules: opts.modules
              ? opts.modules.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            setParams,
            coordinatorUrl: opts.coordinatorUrl ?? opts.url,
            baseRef: opts.baseRef,
            maxQuotaPct: opts.maxQuotaPct ? Number(opts.maxQuotaPct) : undefined,
            catalogs: opts.catalog,
          });
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }

        if (opts.dryRun) {
          return;
        }
        const code = runExitCode(result);
        if (code !== 0) {
          console.error(
            `Échec total : les ${result?.agent_results.length ?? 0} agents ont tous terminé en erreur — voir la colonne Raison du rapport.`,
          );
        }
        // Force exit to release the in-process coordinator's HTTP server
        // (startServer does not expose a .close() handle).
        process.exit(code);
```

Deux points de compilation : `let result: RunResult | undefined;` inclut `undefined` dans son type, donc pas d'erreur d'assignation définie sous `strict: true` ; et `result?.agent_results.length ?? 0` évite un `!` non prouvable par TypeScript.

Vérifier la compilation seule : `npx tsc --noEmit`
Attendu : aucune sortie.

- [ ] **Étape 7 : Le piège — prouver que run et security ne peuvent pas se contredire**

`essaim security` partage `executeRun` mais possède son propre handler `.action()` (`cli/security.ts` ligne 114) et sort avec `process.exit(securityExitCode(result.security))` (lignes 131-132), contrat Strix : 0 propre, 1 erreur moteur/dégradé, 2 findings ingérés ou rouverts (`cli/security.ts` lignes 90-94). Les deux `process.exit` vivent dans deux commandes commander distinctes : un même processus n'en exécute jamais qu'un. **Il n'y a donc aucune contradiction possible tant que le calcul reste dans `cli/run.ts`.**

La contradiction apparaît dès qu'on déplace le calcul dans `cli/run-core.ts`, le « chemin d'exécution partagé » — trois casses simultanées :
(a) `essaim security` sortirait avant `securityExitCode` : le contrat 0/1/2 s'effondre en 0/1 et le 2 (« findings restants », un succès-avec-constat) devient indiscernable du 0 ;
(b) `--triage-only` vide `project.agents` (`run-core.ts` ligne 103) : zéro agent, `[].every()` vaut `true`, un triage propre sortirait en échec ;
(c) `essaim pipeline` appelle `executeRun` par étape (`pipeline.ts` ligne 78) et n'agrège qu'à la fin (`process.exit(ok ? 0 : 1)`, ligne 108) : un `process.exit` interne tuerait le pipeline à la première étape ratée, sautant les étapes suivantes ET le rapport écrit ligne 104.

Règle de cohabitation retenue : **`executeRun` reste sans `process.exit` ; chaque commande possède sa propre politique de sortie.** Côté valeurs, `run` utilise 1 (échec générique, comme le catch de pré-vol) et laisse le 2 réservé à `security`, pour qu'un script CI puisse brancher sur 2 sans ambiguïté d'une commande à l'autre. On ne touche PAS au code de sortie de `security` quand ses agents de correction meurent : la politique de résultat est écrite dans `docs/superpowers/specs/2026-07-22-essaim-security-subsystem-design.md` ligne 412 — le progrès partiel est rapporté et le code suit le contrat Strix, pas un échec dur.

Vérification manuelle exacte (deux commandes, ordre indifférent) :

```
grep -n "process.exit" cli/run-core.ts
```
Attendu : **une seule ligne**, la 39, et c'est un commentaire — `* instead of calling process.exit, so callers (pipeline) can record the outcome.` Toute autre occurrence signifie que le calcul a été mis au mauvais endroit.

```
npx vitest run tests/unit/security-cli.test.ts
```
Attendu : 10 passed, dont `0 when clean (no findings)`, `1 on engine error/degraded`, `2 when findings were ingested (even if some got verified)` — la preuve que le contrat Strix est intact.

- [ ] **Étape 8 : Fumée sur le chemin dry-run + suite complète + build**

Le dry-run est le seul chemin qui ne passe pas par `process.exit` (retour anticipé ligne 95-97) ; il doit toujours sortir 0.

PowerShell :
```
pnpm dev -- run raid -p . --dry-run; echo "exit=$LASTEXITCODE"
```
Bash :
```
pnpm dev -- run raid -p . --dry-run; echo "exit=$?"
```
Attendu : le bloc `=== Dry Run: ... ===` avec la liste des agents, puis `exit=0`.

Puis, exactement ce que fait la CI (`.github/workflows/test.yml`) :
```
pnpm test
pnpm build
```
Attendu : vitest tout vert avec deux fichiers de plus qu'avant (`report-exit-reason.test.ts`, `run-exit-code.test.ts`), et `tsc` silencieux.

- [ ] **Étape 9 : Commit**

```
git add cli/run.ts src/orchestrator/reporter.ts tests/unit/run-exit-code.test.ts tests/unit/report-exit-reason.test.ts
git commit -m "fix(cli): essaim run sort 1 quand TOUS les agents échouent, et le rapport dit pourquoi

cli/run.ts sortait 0 en dur quelle que soit l'issue : impossible de câbler la
commande dans un job automatisé. Le code passe désormais par runExitCode(),
fonction pure exportée et testée, qui ne renvoie 1 que si TOUS les agents ont
un exit_code non nul. Une défaillance partielle reste un succès — un rapport
réel du dépôt montre 2 agents sur 4 morts pendant que les deux autres
livraient leur diff. Zéro agent (--triage-only, template vide) et dry-run
renvoient 0 : [].every() vaut true et signalerait un faux échec.

Le calcul reste dans cli/run.ts et PAS dans cli/run-core.ts : executeRun est
partagé avec essaim security (contrat Strix 0/1/2, cli/security.ts:90) et
essaim pipeline (agrégation puis exit, pipeline.ts:108). Le sortir du moteur
partagé écraserait les deux.

Le tableau des agents du rapport gagne une colonne Raison alimentée par
exit_reason, déjà persisté dans le JSON depuis orchestrator.ts:615 mais
absent du Markdown. N/A y signifie « agent jamais démarré » (échec de
pré-enregistrement coordinateur), pas une donnée manquante.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**CONTRADICTION + PLAGE FAUSSE sur l'emplacement de `runExitCode`. Le tableau `fichiers` dit « lignes 1-5 (imports), 73-101 (corps de l'action), + fonction exportée `runExitCode` insérée après la ligne 103 », alors que l'étape 5 dit « insérer la fonction juste avant `export function createRunCommand(): Command {` (ligne 7) ». Les deux se contredisent. Pire, la plage 73-101 est fausse : j'ai lu cli/run.ts, la ligne 100 est `        process.exit(0);` et la ligne 101 est `      },` — c'est la fermeture du callback passé à `.action()`. Remplacer « 73-101 » par le bloc de l'étape 6 (qui ne contient PAS ce `},`) casse la syntaxe : il resterait `    );` puis `}` sans le `},` correspondant, et tsc sort `TS1005: ',' expected`. L'étape 6 dit bien « lignes 73-100 », donc c'est la fiche `fichiers` qui est fausse.**

Remplacer l'entrée du tableau `fichiers` pour cli/run.ts par :

{
 "chemin": "cli/run.ts",
 "action": "modifier",
 "lignes": "après la ligne 5 (import de type `RunResult`), nouvelle fonction `runExitCode` insérée juste avant `export function createRunCommand(): Command {` (ligne 7), puis remplacement des lignes 73-100 (corps de l'action, du `try {` jusqu'à `process.exit(0);` INCLUS — la ligne 101 `      },` ferme le callback de `.action()` et ne doit PAS être touchée)",
 "role": "Capture le `RunResult` de `executeRun`, calcule le code de sortie et le passe à `process.exit` à la place du 0 littéral."
}

**NUMÉRO DE LIGNE FAUX dans `interfaces.consomme` : « `exit_code: number` (types.ts ligne 105, rempli par orchestrator.ts ligne 603) ». J'ai lu src/orchestrator/types.ts : la ligne 105 est `  agent_name: string;` et la ligne 106 est `  exit_code: number;` (grep -n le confirme : `106:  exit_code: number;`). Tous les autres numéros de ce champ sont bons (RunResult 91-101, exit_reason 130, orchestrator.ts 532 / 574-575 / 603 / 615, agent-loop.ts 71-80, reporter.ts 85 / 117 / 120, run-core.ts 42 / 103 / 126, security.ts 90 / 114 / 131-132, pipeline.ts 78 / 104 / 108, spec ligne 412 — vérifiés un par un).**

Dans `interfaces.consomme`, remplacer :
« dont `exit_code: number` (types.ts ligne 105, rempli par orchestrator.ts ligne 603) »
par :
« dont `exit_code: number` (types.ts ligne 106 — `  exit_code: number;`, rempli par orchestrator.ts ligne 603) »

**FAIT CHIFFRÉ FAUX à l'étape 7 : « `npx vitest run tests/unit/security-cli.test.ts` → Attendu : 10 passed ». Le fichier contient 11 `it()` (`grep -c "it("` = 11) : 7 dans `describe("assembleSecurity")` (builds…, passes secretsFile…, sets triageOnly…, REJECTS an external…, accepts a loopback…, PRESERVES the default exclude_paths…, REFUSES when .essaim/security.yaml…) et 4 dans `describe("securityExitCode (mirrors Strix)")`. Un lecteur qui voit « 11 passed » croira avoir cassé quelque chose. Les trois noms de cas cités sont eux exacts.**

À l'étape 7, remplacer :
« Attendu : 10 passed, dont `0 when clean (no findings)`, `1 on engine error/degraded`, `2 when findings were ingested (even if some got verified)` — la preuve que le contrat Strix est intact. »
par :
« Attendu : 11 passed (7 cas `assembleSecurity` + 4 cas `securityExitCode`), dont `0 when clean (no findings)`, `1 on engine error/degraded`, `2 when findings were ingested (even if some got verified)` et `2 when a finding reopened (never forces 1)` — la preuve que le contrat Strix est intact. »

**PREUVE NON REPRODUCTIBLE présentée comme du contenu du dépôt. Le contexte affirme « Vérifié sur un rapport réel du dépôt : `reports/report-1787795115144.json` … » et l'étape 4 dit « Cas réel du dépôt (reports/report-1787758307294.md) ». Or `reports/` est ignoré par git (.gitignore ligne 18 : `reports/`) et `git ls-files reports/` ne retourne RIEN : aucun de ces fichiers n'est versionné. Le lecteur, qui ne connaît pas le dépôt et travaillera sur un clone frais, ne trouvera aucun de ces fichiers et ne pourra pas vérifier la seule justification chiffrée de tout le prédicat. (Le contenu, lui, est exact sur cette machine : le .json contient bien `"exit_reason": "error"` pour Sentinelle Bravo dont le .md n'affiche que `| Sentinelle Bravo | 1 | OK | 0 |`, et l'autre .md affiche bien Alpha 1 / Bravo 0 OK 17 / Charlie 1 / Delta 0 OK 19.)**

1) Dans `contexte_necessaire`, remplacer :
« Vérifié sur un rapport réel du dépôt : `reports/report-1787795115144.json` contient `"exit_reason": "error"` alors que `reports/report-1787795115144.md` n'affiche que `| Sentinelle Bravo | 1 | OK | 0 |`. »
par :
« Constaté sur un rapport de run local (le dossier `reports/` est gitignoré — .gitignore ligne 18 — donc ces fichiers n'existent pas dans un clone frais) : le `.json` porte `"exit_reason": "error"` pour un agent dont le `.md` n'affiche que `| Sentinelle Bravo | 1 | OK | 0 |`. Pour le reproduire soi-même : lancer n'importe quel run, puis `grep -c exit_reason reports/<dernier>.json` (> 0) et `grep -A6 '### Agents' reports/<dernier>.md` (aucune trace de la raison). »

2) Dans `tests/unit/run-exit-code.test.ts`, remplacer le commentaire du cas partiel par :

    // Régime observé sur un run réel à 4 agents : Alpha exit 1, Bravo exit 0
    // (17 lignes de diff), Charlie exit 1, Delta exit 0 (19 lignes). Les
    // survivants ont livré ; le run est exploitable. Une implémentation
    // « au moins un échec → 1 » échoue ICI et nulle part ailleurs.

**AFFIRMATION FAUSSE DANS LE CODE LIVRÉ + RISQUE MANQUANT. Le message de l'étape 6 dit « les N agents ont tous terminé en erreur », et le titre de la tâche parle d'« échec ». Or `exit_code` ne vaut pas 1 seulement en cas d'erreur : orchestrator.ts ligne 532 pose `code: r.value.exitReason === "done" ? 0 : 1`, et `exitReason` vaut aussi `"max_turns"` (agent-loop.ts ligne 1337 : `exitReason = "max_turns"; summary = `Reached max turns limit (${maxTurns})`;` — l'agent a épuisé son budget de tours et peut très bien avoir commité du vrai travail ; effort mid = maxTurns 8) et `"yielded"` (agent-loop.ts ligne 910, une mise en retrait DÉLIBÉRÉE pendant la coordination : `summary = "Yielded during coordination phase"`). Un essaim où les 4 agents plafonnent en `max_turns` après avoir livré leurs diffs sortira désormais en 1 avec un message qui ment. Le prédicat reste défendable pour la CI (« aucun agent n'a terminé proprement »), mais le libellé et la liste des risques doivent le dire.**

1) À l'étape 6, remplacer le bloc du message par :

        const code = runExitCode(result);
        if (code !== 0) {
          console.error(
            `Aucun agent n'a terminé proprement : les ${result?.agent_results.length ?? 0} agents ont un exit_code non nul — voir la colonne Raison du rapport (error, process_died, mais aussi max_turns ou yielded).`,
          );
        }

2) Dans le docblock de `runExitCode` (étape 5), remplacer la ligne « Le prédicat lit `exit_code` et non `exit_reason` … » par :

 * Le prédicat lit `exit_code` et non `exit_reason` : un agent jamais démarré
 * (orchestrator.ts:574-575) a bien exit_code 1 mais aucun exit_reason.
 * Attention au sens exact de « échec » : exit_code vaut 1 dès que
 * exitReason !== "done" (orchestrator.ts:532), ce qui inclut "max_turns"
 * (budget de tours épuisé, agent-loop.ts:1337) et "yielded" (retrait
 * délibéré pendant la coordination, agent-loop.ts:910) — des issues où du
 * travail a pu être livré. On sort quand même 1 : le contrat est « aucun
 * agent n'a terminé proprement », pas « tout a planté ». C'est exactement
 * ce que la colonne Raison sert à désambiguïser.

3) Ajouter dans `risques` :

"`exit_code` non nul ne veut pas dire « plantage » : orchestrator.ts:532 le dérive de `exitReason !== \"done\"`, donc `max_turns` (agent-loop.ts:1337) et `yielded` (agent-loop.ts:910) comptent comme des échecs. Un essaim où TOUS les agents plafonnent en max_turns après avoir commité du travail sortira en 1. C'est assumé (rien n'a été confirmé DONE), mais le message console ne doit pas dire « erreur » et la colonne Raison est ce qui permet de trancher."

**MESSAGE D'ERREUR ATTENDU INVENTÉ à l'étape 4 : « Attendu : ÉCHEC au chargement — `runExitCode` n'est pas exporté par `cli/run.ts` (message vitest du type « No "runExitCode" export is defined on the ... module »). » Cette formulation-là est celle que vitest émet pour un module MOQUÉ (`vi.mock`) dont le factory n'expose pas l'export. Ici il n'y a aucun mock : le transform SSR de Vite lève un `SyntaxError: The requested module '/cli/run.ts' does not provide an export named 'runExitCode'`. Le lecteur qui compare littéralement croira être tombé sur un autre problème. (Le reste de l'étape est correct : l'échec au chargement a bien lieu, et le patron d'import direct depuis `cli/*.js` est bien celui de tests/unit/security-cli.test.ts, ligne 5 : `import { assembleSecurity, securityExitCode, type SecurityCliOpts } from "../../cli/security.js";` — donc la chaîne d'imports cli → run-core → orchestrator est déjà éprouvée en test.)**

À l'étape 4, remplacer la dernière ligne par :
« Attendu : ÉCHEC au chargement du module, avant même l'exécution du moindre cas — `runExitCode` n'est pas encore exporté par `cli/run.ts`. Vitest remonte une erreur de résolution d'export du type `SyntaxError: The requested module '/cli/run.ts' does not provide an export named 'runExitCode'`. Le libellé exact dépend de la version de Vite ; ce qui compte est que les 5 cas soient signalés en échec collectif, pas qu'ils s'exécutent. »

**Risques :**
- Le piège principal : placer le calcul dans `cli/run-core.ts` plutôt que dans `cli/run.ts`. Cela casse d'un coup `essaim security` (sortie avant `securityExitCode`, contrat Strix 0/1/2 écrasé, `--triage-only` à zéro agent signalé en échec) et `essaim pipeline` (arrêt à la première étape ratée, rapport de pipeline jamais écrit). Le grep de l'étape 7 est là pour l'attraper.
- `[].every(pred)` vaut `true` en JavaScript. Sans le garde-fou `agent_results.length === 0`, tout run à zéro agent sortirait en 1.
- Ne pas remplacer `exit_code` par `exit_reason` dans le prédicat : un agent jamais démarré (`orchestrator.ts` lignes 574-575) a `exit_code: 1` mais aucun `exit_reason`, et serait compté comme un succès.
- La colonne ajoutée décale le tableau Markdown. Aucun test ni script du dépôt ne parse ce tableau par index de colonne (vérifié par grep sur `tests/`), mais un outil externe d'un utilisateur pourrait le faire.
- `exit_code` vaut 0 ou 1 en mode agent-loop (`orchestrator.ts` ligne 532), mais remonte le vrai code du processus en mode legacy (`use_legacy_mode`). Le prédicat `!== 0` couvre les deux ; un test d'égalité à 1 ne le ferait pas.
- Les rapports déjà présents dans `reports/` datant d'avant la persistance de `exit_reason` (par exemple `report-1787758307294.json`) afficheront `N/A` partout dans la nouvelle colonne. C'est correct et attendu, pas une régression.
- Ne pas remplacer `process.exit(code)` par `process.exitCode = code` : le commentaire des lignes 98-99 de `cli/run.ts` explique que la sortie forcée est nécessaire pour relâcher le serveur HTTP du coordinateur in-process, que `startServer` n'expose pas de `.close()`. Le processus resterait pendu.


---

### Tâche 5 : Le nom de branche d'un worktree porte le runId — le run N+1 cesse de détruire le livrable du run N

**Objectif :** Rendre le nom de branche des worktrees unique par run, et le stocker une seule fois dans WorkspaceResult au lieu de le reconstruire sur quatre sites, pour que deux runs successifs du même template coexistent et soient comparables.

**Fichiers :**
- Test : `tests/unit/workspace.test.ts` (ajout à la suite de la ligne 155 (fin du fichier, après le describe « resetBase — ESSAIM_RESET_BASE (#56) »)) — Test rouge : deux appels successifs à createWorkspaces avec deux ESSAIM_RUN_ID différents doivent laisser intacts le worktree et la branche du premier.
- Modifier : `src/orchestrator/types.ts` (70-75 (interface WorkspaceResult)) — Ajoute le champ `branches: Map<string, string>` — la source unique du nom de branche par agent.
- Modifier : `src/orchestrator/workspace.ts` (1-3 (imports), 5-60 (createWorkspaces, dont les lignes 29, 30, 45, 46, 47, 59), 62-69 (cleanupWorkspaces, dont la ligne 65)) — Introduit `agentBranchName()` qui incorpore le runId, peuple `branches`, et fait lire cette map par le nettoyage au lieu de reconstruire le nom.
- Modifier : `src/orchestrator/orchestrator.ts` (638-644 (log « Worktrees preserved ») et 652-658 (construction de RunResult.worktrees)) — Les deux derniers sites qui reconstruisaient `mini-project-${agentId}` lisent désormais `workspace.branches`.

**Interfaces :**
- Consomme : `currentRunId(): string | undefined` exporté par `C:/Users/gagno/projet/essaim-new/src/run-id.ts` (ligne 14) — lit `process.env.ESSAIM_RUN_ID`, publié par `ensureRunId(project.id)` appelé à `C:/Users/gagno/projet/essaim-new/src/orchestrator/orchestrator.ts` ligne 180. `createWorkspaces` conserve sa signature inchangée : `(workspace: { type: "worktree" | "shared" | "none"; base?: string; baseRef?: string }, agents: AgentConfig[], outputDir: string) => WorkspaceResult` ; `cleanupWorkspaces(workspace: WorkspaceResult): void` aussi.
- Produit : Nouveau champ obligatoire `WorkspaceResult.branches: Map<string, string>` (agent_id → nom de branche), déclaré dans `C:/Users/gagno/projet/essaim-new/src/orchestrator/types.ts`, peuplé par le seul site de construction (`src/orchestrator/workspace.ts` ligne 59) et lu par `cleanupWorkspaces` ainsi que par les deux sites de `src/orchestrator/orchestrator.ts` (log « Worktrees preserved » et construction de `RunResult.worktrees[].branch`, que `src/orchestrator/reporter.ts` ligne 186 rend dans le tableau Markdown). Nouvel export nommé `agentBranchName(agentId: string, runId?: string): string` depuis `src/orchestrator/workspace.ts`, rendant `mini-project-<runId>-<agentId>` ou, sans runId, `mini-project-<agentId>`.

**Contexte nécessaire :**

essaim lance N agents Claude Code en parallèle, chacun isolé dans un worktree git créé à partir d'une ref du dépôt cible. Le worktree EST le livrable : sans l'option `--cleanup`, l'orchestrateur journalise « Worktrees preserved (use --cleanup to auto-remove) » (src/orchestrator/orchestrator.ts ligne 639) et publie le nom de branche de chaque agent dans le rapport Markdown (src/orchestrator/reporter.ts ligne 186, `| ${wt.agent_id} | \`${wt.branch}\` | \`${wt.path}\` |`). Le défaut : ce nom est construit ligne 29 de src/orchestrator/workspace.ts comme `const branchName = \`mini-project-${agent.id}\`;` — il ne contient que l'id d'agent, qui est stable par template (bridge.ts ligne 98 le fabrique en `${agentDef.idPrefix}${suffix}`, donc `agent-chasseur-1` à chaque run du template `raid`). Au run suivant, la boucle de création lit `git worktree list --porcelain` (ligne 35), compare chaque ligne à `branch refs/heads/mini-project-agent-chasseur-1` (ligne 39) et, sur correspondance, exécute `git worktree remove "<chemin du run précédent>" --force` (ligne 40) — ce qui efface le répertoire du run N — puis `git branch -D "${branchName}"` sans condition ligne 45. Ce n'était pas un bug d'inattention : ce bloc a été écrit pour récupérer les restes d'un run interrompu, et il fait exactement ce qui était demandé — mais il ne sait pas distinguer « reste d'un run mort » de « livrable d'un run réussi », parce que le nom ne porte pas cette information. Le défaut est resté invisible pour deux raisons : la destruction est silencieuse (chaque `execSync` est enveloppé dans un `try {} catch {}` vide) et elle se produit au DÉBUT du run suivant, loin dans le temps du run qu'elle détruit ; on constate seulement plus tard des répertoires `runs/` vides et des branches disparues. Or l'identifiant qui manque existe déjà : `src/run-id.ts` expose `ensureRunId(templateId)` qui frappe un id de la forme `${templateId}-${randomUUID().slice(0, 8)}` (par exemple `raid-a1b2c3d4`) et le publie dans la variable d'environnement `ESSAIM_RUN_ID`, et `currentRunId()` qui le relit. L'orchestrateur appelle `ensureRunId(project.id)` ligne 180 de src/orchestrator/orchestrator.ts, soit 105 lignes AVANT l'appel à `createWorkspaces` ligne 285 — le runId est donc toujours disponible au moment où la branche est nommée. Le correctif fait donc deux choses indissociables : injecter le runId dans le nom, et arrêter de reconstruire ce nom (aujourd'hui répété à l'identique aux lignes 29 et 65 de workspace.ts et 641 et 656 de orchestrator.ts) en le portant comme donnée dans `WorkspaceResult`, pour qu'un cinquième site ne puisse plus diverger. Effet de bord bienvenu : deux runs concurrents du même template, qui s'arrachaient mutuellement leurs worktrees en cours d'exécution, deviennent indépendants.

**Pourquoi le test discrimine :** Sans le correctif, les deux appels à `createWorkspaces` produisent le même nom `mini-project-agent-chasseur-1` : le second retrouve la branche du premier dans `git worktree list --porcelain` et exécute `git worktree remove "<run-1>" --force` (ligne 40) puis `git branch -D` (ligne 45), si bien que `fs.existsSync(path.join(worktree1, "file.txt"))` vaut `false` dès la première assertion du point 1 et qu'aucune des deux branches attendues ne figure dans `git branch --list` ; avec le correctif les deux noms diffèrent, la correspondance porcelain n'a plus lieu et les deux livrables coexistent. Un test qui se contenterait d'appeler `agentBranchName("a", "r1")` et `agentBranchName("a", "r2")` passerait aussi bien si l'un des quatre sites de reconstruction avait été oublié — c'est pourquoi le test passe par du vrai git et par `ws1.branches`/`ws2.branches`, c'est-à-dire par le chemin que l'orchestrateur emprunte réellement.

- [ ] **Étape 1 : RED — écrire le test qui prouve la destruction, et le voir échouer**

Ouvrir `C:/Users/gagno/projet/essaim-new/tests/unit/workspace.test.ts` et coller ce bloc À LA FIN du fichier (après la ligne 155, qui ferme le `describe("resetBase — ESSAIM_RESET_BASE (#56)")`). Les helpers `testAgent`, `TMP_DIR`, `SANDBOX_DIR` et `lastWorkspace` sont déjà définis lignes 8 à 20 du fichier, et `beforeEach`/`afterEach` lignes 29 à 33 recréent un dépôt git jetable puis effacent `TMP_DIR` : rien d'autre à ajouter.

```ts
// ── Le run N+1 ne détruit plus le livrable du run N ─────────────────────────
//
// Sans `--cleanup`, le worktree EST le livrable : l'orchestrateur journalise
// « Worktrees preserved » et publie les branches dans le rapport. Tant que le
// nom de branche ne contenait que l'id d'agent — stable par template — le run
// suivant du même template retrouvait ces branches dans
// `git worktree list --porcelain`, exécutait `git worktree remove --force` sur
// le répertoire du run précédent, puis `git branch -D` sur sa branche.
// Comparer un run N à un run N+1 était impossible par construction.
describe("createWorkspaces — isolation entre deux runs successifs", () => {
  const ORIGINAL_RUN_ID = process.env.ESSAIM_RUN_ID;

  afterEach(() => {
    if (ORIGINAL_RUN_ID === undefined) delete process.env.ESSAIM_RUN_ID;
    else process.env.ESSAIM_RUN_ID = ORIGINAL_RUN_ID;
  });

  /** Branches locales du bac à sable, sans le marqueur `*` / `+` de git. */
  function localBranches(): string[] {
    return execSync("git branch --list", { cwd: SANDBOX_DIR, encoding: "utf-8" })
      .split("\n")
      .map((line) => line.replace(/^[*+\s]+/, "").trim())
      .filter(Boolean);
  }

  it("deux runs du même template gardent chacun leur branche et leur worktree", () => {
    const agents = [testAgent({ id: "agent-chasseur-1", name: "Chasseur 1", profile: "codeur" })];

    process.env.ESSAIM_RUN_ID = "raid-aaaaaaaa";
    const ws1 = createWorkspaces(
      { type: "worktree", base: SANDBOX_DIR },
      agents,
      path.join(TMP_DIR, "run-1"),
    );
    const worktree1 = ws1.paths.get("agent-chasseur-1")!;
    expect(fs.existsSync(path.join(worktree1, "file.txt"))).toBe(true);

    process.env.ESSAIM_RUN_ID = "raid-bbbbbbbb";
    const ws2 = createWorkspaces(
      { type: "worktree", base: SANDBOX_DIR },
      agents,
      path.join(TMP_DIR, "run-2"),
    );
    lastWorkspace = ws2;

    // 1. le livrable du run 1 a survécu au run 2
    expect(fs.existsSync(path.join(worktree1, "file.txt"))).toBe(true);

    // 2. les deux branches coexistent, chacune portant son runId
    const noms = localBranches();
    expect(noms.filter((b) => b.includes("raid-aaaaaaaa"))).toHaveLength(1);
    expect(noms.filter((b) => b.includes("raid-bbbbbbbb"))).toHaveLength(1);

    // 3. et ce sont bien deux noms différents pour le MÊME agent
    expect(ws2.branches.get("agent-chasseur-1")).not.toBe(ws1.branches.get("agent-chasseur-1"));

    cleanupWorkspaces(ws1);
  });
});
```

Lancer :

```
npx vitest run tests/unit/workspace.test.ts -t "deux runs du même template"
```

Résultat attendu : ÉCHEC sur la première assertion du point 1 — `expected false to be true`, parce que le run 2 vient d'effacer le répertoire du run 1. C'est le défaut, reproduit.

- [ ] **Étape 2 : Ajouter le champ `branches` à WorkspaceResult**

Dans `C:/Users/gagno/projet/essaim-new/src/orchestrator/types.ts`, remplacer le bloc des lignes 70 à 75, dont le contenu actuel est exactement :

```ts
export interface WorkspaceResult {
  type: "worktree" | "shared" | "none";
  basePath: string;
  paths: Map<string, string>; // agent_id → workspace path
  baseSha?: string; // commit the worktrees branch off — diff baseline (#29)
}
```

par :

```ts
export interface WorkspaceResult {
  type: "worktree" | "shared" | "none";
  basePath: string;
  paths: Map<string, string>; // agent_id → workspace path
  baseSha?: string; // commit the worktrees branch off — diff baseline (#29)
  // agent_id → nom de branche. Source UNIQUE du nom : il était reconstruit à
  // l'identique sur 4 sites (workspace.ts × 2, orchestrator.ts × 2), ce qui
  // laissait le nettoyage libre de diverger de la création. Vide sauf pour
  // type === "worktree".
  branches: Map<string, string>;
}
```

Le champ est obligatoire, pas optionnel : `WorkspaceResult` n'est construit qu'à un seul endroit (le `return` ligne 59 de `src/orchestrator/workspace.ts`) ; tous les autres usages (`src/orchestrator/reporter.ts` ligne 33, `tests/unit/workspace.test.ts` ligne 20, la ré-exportation publique `src/index.ts` ligne 10) ne font que lire. Le rendre optionnel obligerait à écrire un `??` de repli sur chaque site de lecture, c'est-à-dire à réintroduire exactement la reconstruction qu'on supprime.

- [ ] **Étape 3 : Incorporer le runId dans le nom de branche et le mémoriser**

Dans `C:/Users/gagno/projet/essaim-new/src/orchestrator/workspace.ts`.

(a) Remplacer les lignes 1 à 3, dont le contenu actuel est :

```ts
import { execSync } from "child_process";
import path from "path";
import type { AgentConfig, WorkspaceResult } from "./types.js";
```

par :

```ts
import { execSync } from "child_process";
import path from "path";
import { currentRunId } from "../run-id.js";
import type { AgentConfig, WorkspaceResult } from "./types.js";

/**
 * Nom de la branche d'un agent, unique PAR RUN.
 *
 * Le livrable d'essaim EST le worktree : sans `--cleanup` l'orchestrateur
 * journalise « Worktrees preserved » et publie les branches dans le rapport.
 * Le nom ne contenait pourtant que l'id d'agent, stable par template — le run
 * suivant du même template retrouvait donc ces branches dans
 * `git worktree list --porcelain` et faisait dessus `git worktree remove
 * --force` puis `git branch -D`, sans condition. Le runId (frappé par
 * `ensureRunId` et publié dans ESSAIM_RUN_ID bien avant createWorkspaces) rend
 * le nom unique et rend deux runs comparables.
 *
 * runId absent (appel bibliothèque hors orchestrateur) : on retombe sur
 * l'ancien nom, donc sur l'ancien comportement — explicitement, plutôt que par
 * un nom bancal.
 */
export function agentBranchName(agentId: string, runId = currentRunId()): string {
  return runId ? `mini-project-${runId}-${agentId}` : `mini-project-${agentId}`;
}
```

(b) Remplacer l'intégralité du corps de `createWorkspaces`, lignes 5 à 60, par :

```ts
export function createWorkspaces(
  workspace: { type: "worktree" | "shared" | "none"; base?: string; baseRef?: string },
  agents: AgentConfig[],
  outputDir: string
): WorkspaceResult {
  const paths = new Map<string, string>();
  const branches = new Map<string, string>();
  const basePath = workspace.base || process.cwd();
  const ref = workspace.baseRef || "HEAD";

  // Pin the commit the worktrees branch off. The report needs it to measure what
  // an agent actually produced: agents are told to COMMIT their work, so a plain
  // `git diff HEAD` in the worktree shows nothing and every agent looked like it
  // changed nothing (#29). Diffing against this base captures commits too.
  let baseSha: string | undefined;
  try {
    baseSha = execSync(`git rev-parse ${ref}`, { cwd: basePath, encoding: "utf-8" }).trim();
  } catch { /* not a git repo — diff stats degrade to unavailable */ }

  if (workspace.type === "worktree") {
    // Prune stale worktree references from previous runs
    try { execSync(`git worktree prune`, { cwd: basePath, stdio: "pipe" }); } catch {}

    for (const agent of agents) {
      const worktreePath = path.join(outputDir, `worktree-${agent.id}`);
      const branchName = agentBranchName(agent.id);
      const branchRef = `refs/heads/${branchName}`;

      // Force-remove any previous worktree that still holds this branch.
      // Le nom portant le runId, cela ne peut plus viser que des restes de CE
      // run (reprise après un crash), jamais le livrable d'un run précédent.
      try {
        const porcelain = execSync(`git worktree list --porcelain`, { cwd: basePath, encoding: "utf-8" });
        let currentPath = "";
        for (const line of porcelain.split("\n")) {
          if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
          if (line === `branch ${branchRef}` && currentPath) {
            try { execSync(`git worktree remove "${currentPath}" --force`, { cwd: basePath, stdio: "pipe" }); } catch {}
          }
        }
      } catch {}

      try { execSync(`git branch -D "${branchName}"`, { cwd: basePath, stdio: "pipe" }); } catch {}
      execSync(`git worktree add "${worktreePath}" -b "${branchName}" ${ref}`, { cwd: basePath, stdio: "pipe" });
      paths.set(agent.id, worktreePath);
      branches.set(agent.id, branchName);
    }
  } else if (workspace.type === "shared") {
    for (const agent of agents) {
      paths.set(agent.id, basePath);
    }
  } else {
    for (const agent of agents) {
      paths.set(agent.id, basePath);
    }
  }

  return { type: workspace.type, basePath, paths, baseSha, branches };
}
```

- [ ] **Étape 4 : Faire lire la map au nettoyage au lieu de reconstruire le nom**

Toujours dans `C:/Users/gagno/projet/essaim-new/src/orchestrator/workspace.ts`, remplacer les lignes 62 à 69, dont le contenu actuel est :

```ts
export function cleanupWorkspaces(workspace: WorkspaceResult): void {
  if (workspace.type !== "worktree") return;
  for (const [agentId, worktreePath] of workspace.paths) {
    const branchName = `mini-project-${agentId}`;
    try { execSync(`git worktree remove "${worktreePath}" --force`, { cwd: workspace.basePath, stdio: "pipe" }); } catch {}
    try { execSync(`git branch -D "${branchName}"`, { cwd: workspace.basePath, stdio: "pipe" }); } catch {}
  }
}
```

par :

```ts
export function cleanupWorkspaces(workspace: WorkspaceResult): void {
  if (workspace.type !== "worktree") return;
  for (const [agentId, worktreePath] of workspace.paths) {
    // Le nom vient de la création, il n'est plus recalculé ici : un nettoyage
    // qui recalcule est un nettoyage libre de viser la mauvaise branche.
    const branchName = workspace.branches.get(agentId);
    try { execSync(`git worktree remove "${worktreePath}" --force`, { cwd: workspace.basePath, stdio: "pipe" }); } catch {}
    if (branchName) {
      try { execSync(`git branch -D "${branchName}"`, { cwd: workspace.basePath, stdio: "pipe" }); } catch {}
    }
  }
}
```

- [ ] **Étape 5 : Purger les deux derniers sites de reconstruction, dans l'orchestrateur**

Dans `C:/Users/gagno/projet/essaim-new/src/orchestrator/orchestrator.ts`.

(a) Remplacer les lignes 638 à 644, dont le contenu actuel est :

```ts
  } else if (workspace.type === "worktree") {
    log.info("Worktrees preserved (use --cleanup to auto-remove)");
    for (const [agentId, wsPath] of workspace.paths) {
      const branchName = `mini-project-${agentId}`;
      log.info(`  ${agentId}: ${wsPath}  (branch: ${branchName})`);
    }
  }
```

par :

```ts
  } else if (workspace.type === "worktree") {
    log.info("Worktrees preserved (use --cleanup to auto-remove)");
    for (const [agentId, wsPath] of workspace.paths) {
      log.info(`  ${agentId}: ${wsPath}  (branch: ${workspace.branches.get(agentId) ?? ""})`);
    }
  }
```

(b) Remplacer les lignes 652 à 658, dont le contenu actuel est :

```ts
  const worktrees = workspace.type === "worktree"
    ? [...workspace.paths.entries()].map(([agentId, wsPath]) => ({
        agent_id: agentId,
        path: wsPath,
        branch: `mini-project-${agentId}`,
      }))
    : undefined;
```

par :

```ts
  const worktrees = workspace.type === "worktree"
    ? [...workspace.paths.entries()].map(([agentId, wsPath]) => ({
        agent_id: agentId,
        path: wsPath,
        branch: workspace.branches.get(agentId) ?? "",
      }))
    : undefined;
```

Ce `branch` alimente `RunResult.worktrees[].branch` (déclaré ligne 99 de `src/orchestrator/types.ts`) que le rapport Markdown affiche tel quel ligne 186 de `src/orchestrator/reporter.ts` — il suit donc le nouveau nom sans aucune autre modification.

- [ ] **Étape 6 : GREEN — le test passe**

```
npx vitest run tests/unit/workspace.test.ts
```

Résultat attendu : `Test Files  1 passed (1)` et `Tests  10 passed (10)` — les 3 tests d'origine du `describe("createWorkspaces")` (lignes 36 à 72), les 6 du `describe("resetBase — ESSAIM_RESET_BASE (#56)")` (lignes 84 à 155) et le nouveau. Les 3 premiers ne définissent pas `ESSAIM_RUN_ID`, donc `agentBranchName` y retombe sur `mini-project-<agentId>` : aucun d'eux ne change de comportement.

- [ ] **Étape 7 : Vérification manuelle : plus aucun site ne reconstruit le nom**

Le test ci-dessus prouve l'effet ; cette vérification prouve que la cause racine — le nom répété sur quatre sites — a disparu, ce qu'aucun test ne peut affirmer.

```
grep -rn "mini-project-" src/ cli/ tests/ behaviors/ presets/ templates/ .github/
```

Résultat attendu : EXACTEMENT deux lignes, toutes deux dans `src/orchestrator/workspace.ts`, à l'intérieur du corps de `agentBranchName` :

```
src/orchestrator/workspace.ts:  return runId ? `mini-project-${runId}-${agentId}` : `mini-project-${agentId}`;
```

(la commande affiche une seule ligne physique puisque les deux formes tiennent sur la même ligne ; l'essentiel est qu'aucune occurrence ne subsiste dans `orchestrator.ts`, dans les tests, dans les YAML du catalogue ni dans les workflows CI). Avant le correctif, la même commande rendait 4 lignes réparties sur 2 fichiers.

- [ ] **Étape 8 : Non-régression complète**

```
pnpm test && pnpm build
```

Résultat attendu : suite verte (les 65 fichiers de tests, `fileParallelism: false`) puis compilation `tsc` sans erreur. C'est exactement ce que joue la CI (`.github/workflows/test.yml` : `pnpm install && pnpm test && pnpm build`). `pnpm build` est ici la vraie garde : `vitest` n'effectue pas de vérification de types, donc seule la compilation démontre que le champ obligatoire `branches` est bien fourni par l'unique site de construction et lu correctement par `orchestrator.ts`.

- [ ] **Étape 9 : Commit**

```
git checkout -b fix/worktree-branch-run-scoped
git add src/orchestrator/types.ts src/orchestrator/workspace.ts src/orchestrator/orchestrator.ts tests/unit/workspace.test.ts
git commit -F - <<'EOF'
fix(worktree): le run suivant détruisait les worktrees promis préservés

Le nom de branche ne contenait que l'id d'agent, stable par template : le
run N+1 du même template retrouvait les branches du run N dans
`git worktree list --porcelain`, supprimait de force leur répertoire, puis
faisait `git branch -D` dessus. Sans `--cleanup` le worktree EST le
livrable — comparer un run N à un run N+1 était impossible par
construction.

Le runId, déjà frappé par ensureRunId 105 lignes avant createWorkspaces,
entre dans le nom. Et le nom cesse d'être reconstruit sur quatre sites : il
devient une donnée portée par WorkspaceResult.branches, que le nettoyage et
le rapport se contentent de lire.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**L'étape 4 (cleanupWorkspaces lit `workspace.branches` au lieu de recalculer `mini-project-${agentId}`) n'est couverte par AUCUN test : le nouveau test passe à l'identique si l'étape 4 est oubliée. worktree1 survit, les deux branches coexistent, ws1.branches !== ws2.branches — les trois points d'assertion sont verts. Or l'oubli est une vraie régression silencieuse : `git branch -D "mini-project-agent-chasseur-1"` viserait une branche inexistante, échouerait dans le `try {} catch {}` vide de la ligne 67, et `--cleanup` laisserait fuir une branche par agent et par run — exactement l'accumulation que le risque n°1 annonce comme le coût du correctif, mais multipliée puisque même le nettoyage explicite ne nettoierait plus. Étape 1 : remplacer la fin du bloc `it(...)`.**

Dans le bloc collé à l'étape 1, remplacer les trois dernières lignes

```ts
    cleanupWorkspaces(ws1);
  });
});
```

par :

```ts
    cleanupWorkspaces(ws1);

    // 4. le nettoyage LIT la map au lieu de recalculer le nom. Sans l'étape 4,
    //    `git branch -D` viserait `mini-project-agent-chasseur-1` — inexistante
    //    depuis que le runId entre dans le nom — échouerait dans le `try {}
    //    catch {}` vide, et la branche du run 1 survivrait au nettoyage.
    expect(localBranches()).not.toContain(ws1.branches.get("agent-chasseur-1"));
  });
});
```

Et compléter `pourquoi_le_test_discrimine` par cette phrase : « La quatrième assertion discrimine l'étape 4 seule : `cleanupWorkspaces` retire d'abord le worktree (`git worktree remove --force`), ce qui libère la branche, puis la supprime — avec la map le `git branch -D` porte sur `mini-project-raid-aaaaaaaa-agent-chasseur-1` et la branche disparaît de `git branch --list` ; avec un nom recalculé il porte sur `mini-project-agent-chasseur-1`, git répond `error: branch ... not found`, le `catch` vide l'avale, et la branche du run 1 figure toujours dans la liste. »

**L'étape 7 se contredit elle-même : elle annonce « Résultat attendu : EXACTEMENT deux lignes » puis, quatre lignes plus bas, « la commande affiche une seule ligne physique ». Vérifié : après le correctif, les deux formes `mini-project-${runId}-${agentId}` et `mini-project-${agentId}` tiennent sur le même `return`, donc `grep -rn` rend UNE ligne. Un lecteur qui applique la consigne littérale conclut à un échec de la vérification. Accessoirement `grep` n'existe pas en PowerShell natif, alors que l'environnement documenté est Windows.**

Remplacer intégralement le `contenu` de l'étape 7 par :

« Le test ci-dessus prouve l'effet ; cette vérification prouve que la cause racine — le nom répété sur quatre sites — a disparu, ce qu'aucun test ne peut affirmer.

Depuis la racine du dépôt, en Git Bash :

```
grep -rn "mini-project-" src/ cli/ tests/ behaviors/ presets/ compositions/ templates/ docs/ .github/ README.md
```

Équivalent PowerShell :

```
Select-String -Pattern 'mini-project-' -Path src,cli,tests,behaviors,presets,compositions,templates,docs,.github,README.md -Recurse
```

Résultat attendu : EXACTEMENT UNE ligne, celle du corps de `agentBranchName` — les deux formes du nom tiennent sur le même `return`, donc grep ne compte qu'une ligne physique :

```
src/orchestrator/workspace.ts:  return runId ? `mini-project-${runId}-${agentId}` : `mini-project-${agentId}`;
```

L'essentiel est qu'aucune occurrence ne subsiste dans `orchestrator.ts`, dans les tests, dans les YAML du catalogue, dans la documentation ni dans les workflows CI. Avant le correctif, la même commande rendait 4 lignes réparties sur 2 fichiers (`workspace.ts` 29 et 65, `orchestrator.ts` 641 et 656). »

**Le décompte d'agents par template du risque n°1 est faux pour 4 templates sur 5 de sa première catégorie, et il en omet 3. Vérifié par `grep -n "idPrefix\|count:" templates/*.yaml` : `carrefour.yaml:14`, `melee.yaml:14`, `swarm.yaml:14` et `sentinelle.yaml:14` portent tous `count: dynamic`, donc 2 à 4 agents (bridge.ts ligne 74), pas 1 ; seul `gardien` a réellement un unique groupe `count: 1`. Sont absents de l'énumération : `babel` (2 groupes × 1 = 2), `maitre` (1 + dynamic = 2 à 5) et `raid` lui-même (dynamic). L'ordre de grandeur annoncé (« 2 à 8 branches par run ») reste juste, mais le lecteur qui dimensionne son ménage sur « 1 agent » se trompe d'un facteur 4.**

Dans le risque « ACCUMULATION DE BRANCHES », remplacer la phrase

« Templates fournis : 1 agent (`gardien`, `carrefour`, `melee`, `swarm`, `sentinelle`), 3 (`arene`, `chaine`, `debat`, `relais`), 5 (`phare`), et pour les rôles `count: dynamic` la valeur vaut `Math.max(2, Math.min(context.modules.length || 2, 4))` (src/bridge.ts ligne 74), soit 2 à 4 par groupe — `revue` en a deux groupes, donc jusqu'à 8 branches par run. »

par

« Templates fournis (relevé exact de `count:` dans `templates/*.yaml`) : un seul agent pour `gardien` ; deux pour `babel` ; trois pour `arene`, `chaine`, `debat` et `relais` (trois groupes à `count: 1`) ; cinq pour `phare`. Les autres reposent sur `count: dynamic`, dont la valeur vaut `options?.agentCount ?? Math.max(2, Math.min(context.modules.length || 2, 4))` (src/bridge.ts ligne 74), soit 2 à 4 agents par groupe dynamique : `carrefour`, `melee`, `swarm`, `sentinelle` et `raid` ont un groupe dynamique unique (2 à 4 branches), `maitre` un groupe fixe plus un dynamique (2 à 5), `revue` deux groupes dynamiques (4 à 8). `migrate-phase2` combine `count: 1` et `count: per-module`, soit une branche par module détecté plus une. »

**Le nombre de fichiers de tests est faux, aux deux endroits où il est avancé : étape 8 « les 65 fichiers de tests » et risque n°3 « aucun des 65 fichiers de `tests/unit/` ». Compté sur le dépôt : `ls tests/unit/*.test.ts | wc -l` rend 67, et `find tests -name "*.test.ts" | wc -l` rend 67 aussi (tous les `.test.ts` vivent dans `tests/unit/`). `vitest.config.ts` collecte `tests/**/*.test.ts`, donc `pnpm test` annonce 67 fichiers. Le correctif n'en ajoute aucun puisqu'il complète un fichier existant. Le « 64 » de CLAUDE.md est lui-même périmé — ne pas s'en servir comme source.**

Étape 8 : remplacer « Résultat attendu : suite verte (les 65 fichiers de tests, `fileParallelism: false`) puis compilation `tsc` sans erreur. » par « Résultat attendu : suite verte (les 67 fichiers `tests/**/*.test.ts` collectés par `vitest.config.ts`, `fileParallelism: false` — le correctif n'en ajoute aucun, il complète `tests/unit/workspace.test.ts`) puis compilation `tsc` sans erreur. »

Risque n°3 : remplacer « aucun des 65 fichiers de `tests/unit/` » par « aucun des 67 fichiers de `tests/unit/` ».

**L'étape 1 fait dépendre la reproduction du défaut d'un filtre `-t` contenant un accent : `npx vitest run tests/unit/workspace.test.ts -t "deux runs du même template"`. L'environnement documenté est Windows/PowerShell, où la page de code de la console peut mutiler l'argument avant node ; le filtre ne matche alors rien et vitest sort en succès avec 0 test exécuté — ce qui se lit comme « le défaut n'existe pas » alors que rien n'a tourné. Ce n'est pas une erreur prouvée sur cette machine, mais le filtre ASCII a le même pouvoir discriminant pour zéro risque.**

Étape 1, remplacer le bloc de commande

```
npx vitest run tests/unit/workspace.test.ts -t "deux runs du même template"
```

par

```
npx vitest run tests/unit/workspace.test.ts -t "deux runs du"
```

(sous-chaîne ASCII, présente dans le seul nom de test visé et dans aucun autre du fichier), et ajouter juste après : « Si la sortie annonce `no test found` ou `Tests 0 passed`, le filtre n'a rien sélectionné — relancer sans `-t` plutôt que de conclure quoi que ce soit. »

**Risques :**
- ACCUMULATION DE BRANCHES — c'est le coût direct et assumé : les branches cessent d'être recyclées. Il s'en crée une par agent et par run. Templates fournis : 1 agent (`gardien`, `carrefour`, `melee`, `swarm`, `sentinelle`), 3 (`arene`, `chaine`, `debat`, `relais`), 5 (`phare`), et pour les rôles `count: dynamic` la valeur vaut `Math.max(2, Math.min(context.modules.length || 2, 4))` (src/bridge.ts ligne 74), soit 2 à 4 par groupe — `revue` en a deux groupes, donc jusqu'à 8 branches par run. `--agents N` (cli/run.ts ligne 12) n'a aucun plafond, et `migrate-phase2` utilise `count: per-module`, soit une branche par module détecté. Ordre de grandeur courant : 2 à 8 branches par run, contre 0 accumulation auparavant — au prix de la destruction du run précédent. Ménage exact, à lancer depuis la racine du dépôt cible (bash) : `git worktree prune && git branch --list 'mini-project-*' --format='%(refname:short)' | xargs -r git branch -D`. En PowerShell : `git worktree prune; git branch --list 'mini-project-*' --format='%(refname:short)' | ForEach-Object { git branch -D $_ }`. Ces commandes sont sûres : git refuse `branch -D` sur une branche encore montée dans un worktree vivant (« Cannot delete branch ... checked out at ... »), donc seules les branches orphelines partent. Pour tout reprendre à zéro, livrables compris : `rm -rf runs/ && git worktree prune && git branch --list 'mini-project-*' --format='%(refname:short)' | xargs -r git branch -D`.
- LONGUEUR DU NOM — aucune limite n'est franchie, vérification chiffrée. Le nom devient `mini-project-` (13 caractères) + runId + `-` + agentId. Le runId vaut `${templateId}-${randomUUID().slice(0, 8)}` (src/run-id.ts ligne 27) ; le plus long id de template livré est `migrate-phase2` (14), soit un runId de 23 caractères au maximum. Le plus long `idPrefix` livré est `agent-implementeur` (18), plus un suffixe `-1` à `-N` ou un slug de module. Pire cas réaliste : 13 + 23 + 1 + 20 ≈ 57 caractères. Git n'impose pas de limite propre aux noms de branches ; la contrainte réelle est le système de fichiers pour une ref lâche stockée en `.git/refs/heads/<nom>` — 255 octets par composant sur NTFS, ext4 et APFS — et MAX_PATH (260) pour le chemin complet sous Windows. 57 caractères ajoutés à la racine du dépôt laissent une marge confortable. Le nom ne contient aucune barre oblique, donc aucun conflit répertoire/fichier git entre `mini-project-<run>` et `mini-project-<run>-<agent>` : ce piège n'existe que pour les noms hiérarchiques à `/`, raison pour laquelle un schéma `essaim/<run>/<agent>` a été écarté. Le répertoire du worktree n'est pas touché : il reste `worktree-<agentId>` (ligne 28), déjà isolé par `runDir` = `runs/<projectId>-<mode>-<Date.now()>` (orchestrator.ts ligne 174).
- DÉPENDANCE AU FORMAT DU NOM — grep effectué avant conclusion, sur tout le dépôt : la chaîne `mini-project` (insensible à la casse) n'apparaît que dans DEUX fichiers suivis, `src/orchestrator/workspace.ts` (lignes 29 et 65) et `src/orchestrator/orchestrator.ts` (lignes 641 et 656) — soit exactement les quatre sites que le correctif remplace. Rien d'autre n'en dépend : aucun des 65 fichiers de `tests/unit/`, aucun test shell (`tests/track_activity_path_normalization.test.sh`, `tests/track_activity_secret_filtering.test.sh`), aucun workflow de `.github/workflows/`, aucun YAML de `behaviors/`, `presets/`, `compositions/` ou `templates/`, aucune documentation (`README.md`, `docs/`). Les seuls behaviors qui évoquent la branche ne la nomment jamais : `behaviors/worktree-isolation.yaml` lignes 11 et 16 (« Tu travailles dans un worktree git isolé. Ta branche est dédiée à ton travail. ») et `behaviors/mission-tasks-md.yaml` ligne 29 (« Commits fréquents sur ta branche worktree »). Aucun code ne fait `git merge`, `git cherry-pick`, `git log`, `git rev-list` ni `for-each-ref` sur ces branches (grep : zéro occurrence). Le rapport affiche `wt.branch` tel quel (reporter.ts ligne 186) et suit donc le nouveau nom sans modification. Enfin, le préfixe `mini-project-` est délibérément conservé : tout glob `mini-project-*` tapé par un opérateur ou figurant dans un script personnel continue de matcher, anciennes et nouvelles branches confondues.
- ESSAIM_RUN_ID ARBITRAIRE — nouveau mode d'échec, assumé et non masqué. `ESSAIM_RUN_ID` peut être imposé de l'extérieur (`ensureRunId` cède à une valeur préexistante, src/run-id.ts lignes 25-26) et n'était jusqu'ici utilisé que dans des charges utiles JSON, donc jamais contraint. Une valeur contenant un caractère que git refuse dans une ref (espace, `~`, `^`, `:`, `?`, `*`, `[`, `\`, une séquence `..`, un suffixe `.lock`) fait désormais échouer `git worktree add ... -b "<nom>"` ligne 46 — le seul `execSync` de la fonction qui ne soit pas enveloppé d'un `try/catch` : le run s'arrête net à la création des workspaces, avec le message de git `fatal: '<nom>' is not a valid branch name`. Choix délibéré de ne PAS assainir la valeur : un id nettoyé en silence rendrait l'id journalisé (orchestrator.ts ligne 182) différent de l'id gravé dans la branche, et masquerait une erreur d'opérateur. Contournement : `unset ESSAIM_RUN_ID` (PowerShell : `Remove-Item Env:ESSAIM_RUN_ID`) pour laisser `ensureRunId` frapper un id sûr, ou fournir une valeur limitée à `[A-Za-z0-9._-]`.
- CHAMP OBLIGATOIRE SUR UN TYPE PUBLIC — `WorkspaceResult` est ré-exporté par `src/index.ts` (ligne 10), donc `branches` devient visible dans l'API publique. Ce n'est pas cassant : le type n'est jamais construit hors de `src/orchestrator/workspace.ts` (ligne 59, vérifié par grep sur tout le dépôt) et tous les autres usages se contentent de le lire (`src/orchestrator/reporter.ts` ligne 33, `tests/unit/workspace.test.ts` ligne 20). Un consommateur externe qui fabriquerait un `WorkspaceResult` à la main pour le passer à `cleanupWorkspaces` verrait en revanche une erreur de compilation — c'est le comportement souhaité, puisque sans la map il ne saurait de toute façon plus quelle branche supprimer.
- REPLI SANS RUNID — appelée hors orchestrateur, `createWorkspaces` ne trouve pas `ESSAIM_RUN_ID` et retombe sur l'ancien nom, donc sur l'ancien comportement destructeur. C'est délibéré : cela garantit zéro changement de format pour les trois tests existants du `describe("createWorkspaces")` (lignes 36 à 72 de `tests/unit/workspace.test.ts`), qui ne définissent pas la variable. Dans le chemin CLI réel le repli est inatteignable : `ensureRunId(project.id)` est appelé ligne 180 de `src/orchestrator/orchestrator.ts`, 105 lignes avant `createWorkspaces` ligne 285, et publie la valeur dans l'environnement du processus.


---

### Tâche 6 : Réparer le premier contact public d'essaim : README, page GitHub Pages et garde-fou CI

**Objectif :** Rendre exécutables les commandes que le README et docs/index.html donnent à copier, remettre les compteurs du catalogue à leur valeur réelle, et ajouter au job CI existant un grep qui refuse la réapparition des trois jetons morts.

**Fichiers :**
- Modifier : `README.md` (73-79 (supprimées), 94 (note ajoutée avant), 232-233 (ligne security ajoutée), 315) — Quickstart qui fait démarrer un coordinator externe alors que `run` en démarre un sur le même port ; tableau CLI qui se dit exhaustif mais omet `essaim security` ; renvoi vers `essaim list presets` qui n'accepte pas d'argument.
- Modifier : `docs/index.html` (1234-1236, 1241, 1541-1542, 1714-1727, 1928, 1934, 1992-1993) — Page GitHub Pages : compteurs de catalogue périmés et quatre blocs de commandes copiables qui n'existent plus dans la CLI (`essaim bce …`, `--preset`, `mcp-coordinator run`).
- Modifier : `.github/workflows/test.yml` (28-29 (étape insérée à la fin du job no-domain-artifacts)) — Garde-fou : un `git grep` sur les trois jetons morts, calqué sur les deux étapes existantes du même job.
- Modifier : `src/orchestrator/orchestrator.ts` (134-141 (lecture seule — preuve, ne pas toucher)) — Source de vérité du défaut (a) : démarrage in-process du coordinator sur le port 3100.
- Modifier : `cli/index.ts` (19-26 (lecture seule — preuve, ne pas toucher)) — Source de vérité du défaut (d) : la liste exhaustive des huit commandes enregistrées.

**Interfaces :**
- Consomme : La surface CLI réelle, telle qu'enregistrée dans `cli/index.ts:19-26` (8 commandes : run, pipeline, solo, scan, security, init, list, self-update) et telle que déclarée option par option dans `cli/run.ts:11-26`, `cli/solo.ts:42-50`, `cli/init.ts:9-12`, `cli/security.ts:99-113`, `cli/list.ts:12-13` ; le comportement de démarrage du coordinator dans `src/orchestrator/orchestrator.ts:134-141` et `cli/run-core.ts:91` ; le nombre de fichiers YAML de `templates/` (15), `behaviors/` (46), `presets/` (29), `compositions/` (3) ; le patron des deux étapes de garde-fou existantes dans `.github/workflows/test.yml:13-28`.
- Produit : Un `README.md` dont le quickstart s'exécute d'un bout à l'autre sans coordinator externe et dont le tableau CLI est réellement exhaustif ; un `docs/index.html` dont chaque commande copiable est acceptée par la CLI et dont les compteurs égalent le catalogue ; une étape supplémentaire dans le job CI `no-domain-artifacts` qui échoue si `essaim bce`, `--preset` ou `mcp-coordinator run` réapparaît dans un fichier suivi autre que `CHANGELOG.md` et le workflow lui-même. Aucun fichier source TypeScript n'est modifié ; `pnpm test` et `pnpm build` restent inchangés.

**Contexte nécessaire :**

essaim est un orchestrateur CLI (MIT, v0.13.0) qui lance N agents Claude Code coordonnés sur des worktrees git. Son adoption passe par deux surfaces publiques : `README.md` (racine du dépôt) et `docs/index.html` (page GitHub Pages servie sur https://swoofer.github.io/essaim/). Aucune des deux n'est couverte par un test, donc les deux ont dérivé pendant que le code avançait — et la dérive est invisible parce que `pnpm test` et `pnpm build` passent parfaitement sur un README faux.

Le mécanisme central à comprendre est la « Strategy A » du coordinator. Historiquement, essaim déléguait la coordination à un serveur externe `mcp-coordinator` que l'opérateur lançait à la main. Ce n'est plus vrai : `src/orchestrator/orchestrator.ts:134-141` fait `if (mode === "with_coordinator" && !runOpts.coordinatorUrl) { const port = parseInt(process.env.PORT || "3100", 10); ... coordinatorHandle = await startServer({ port, dataDir, registerSignalHandlers: false }); }`, puis le `finally` de la même fonction appelle `coordinatorHandle.stop()` (ligne 157). Autrement dit `essaim run` démarre son propre coordinator **in-process sur le port 3100** et l'éteint à la fin. `cli/run-core.ts:91` ne fournit `coordinatorUrl` que si l'opérateur a passé `--coordinator-url` ou exporté `COORDINATOR_URL`. Conséquence : si le lecteur suit le README et lance d'abord `mcp-coordinator server start --daemon` (qui occupe 3100), l'étape suivante `essaim run swarm` meurt sur `EADDRINUSE` avant d'avoir lancé le moindre agent. L'étape 2 du quickstart casse l'étape 3.

Deuxième mécanisme : la CLI est construite avec commander v14 (`package.json:66`, résolu en 14.0.3). Dans cette version `_allowExcessArguments` vaut `false` par défaut (`node_modules/commander/lib/command.js:28`) et une option non déclarée déclenche `error: unknown option '--xxx'` (ligne 2135). Il n'y a donc aucune tolérance : une option ou un sous-argument inventé dans la doc est une commande qui échoue immédiatement, pas une commande qui « marche à peu près ». Les commandes réellement enregistrées sont exactement les huit de `cli/index.ts:19-26` : `run`, `pipeline`, `solo`, `scan`, `security`, `init`, `list`, `self-update`.

Troisième point : le catalogue YAML a grossi. `templates/` contient 15 fichiers, `behaviors/` 46, `presets/` 29, `compositions/` 3. Le README est à jour sur ces chiffres (lignes 55, 108, 119) ; la page HTML, elle, annonce encore 12 templates, 32 behaviors et 20-21 presets. Les nombres du hero sont animés par JavaScript à partir de l'attribut `data-count` (`docs/index.html:2458-2460`), donc c'est bien cet attribut qu'il faut corriger, pas le `0` affiché dans le HTML.

Enfin, la page est traduite en 6 langues par un dictionnaire JS (`docs/index.html:2533-3896`) : `setLanguage()` remplace le `innerHTML` de tout élément portant `data-i18n`. Les blocs de commandes visés ici (`.terminal`, `.code-block`, `.hero-term-line`) n'ont **pas** de `data-i18n` : ils sont littéraux et une seule édition suffit. Ne touchez pas aux clés du dictionnaire, vous devriez sinon éditer les six langues.

Attention au job CI `no-domain-artifacts` de `.github/workflows/test.yml`. Il refuse toute mention d'un nom de client précis dans n'importe quel fichier suivi ; ce terme n'est épelé que dans le fichier de workflow lui-même, qui s'exclut de sa propre recherche via le pathspec `':!.github/workflows/test.yml'`. Ne recopiez ce terme nulle part : le job échouerait sur son propre dépôt. C'est ce patron exact — un `git grep` sur des jetons morts, avec exclusion des fichiers qui ont une raison légitime de les contenir — que la nouvelle étape doit reproduire.

**Pourquoi le test discrimine :** Aucun test unitaire n'est proposé, et c'est délibéré : `vitest.config.ts` ne ramasse que `tests/**/*.test.ts`, et un test qui parserait `docs/index.html` pour compter des pastilles de statistiques coûterait plus cher en maintenance (sélecteurs, DOM, refontes de design) que le défaut qu'il attrape. Le garde-fou proportionné est le `git grep` de l'étape 8, et il discrimine réellement : sur l'arbre actuel il trouve exactement 7 lignes (docs/index.html:1241, 1715, 1718, 1721, 1724, 1928, 1934), sort en 0, et l'étape CI échoue ; une fois l'étape 7 appliquée il ne trouve plus rien, sort en 1, et l'étape passe. Le même grep exécuté sur l'arbre corrigé mais **sans** l'exclusion `':!CHANGELOG.md'` échouerait à cause des lignes 203 et 254 du CHANGELOG — c'est la preuve que l'exclusion n'est pas décorative mais nécessaire, exactement comme l'auto-exclusion du workflow dans l'étape voisine. Pour les compteurs, le discriminant est la comparaison directe `ls <dir>/*.yaml | wc -l` contre les `data-count` : elle donne 15/46/29 d'un côté et 12/32/21 de l'autre avant le patch, et l'égalité après. Pour le tableau CLI, le `diff` entre les fabriques `create*Command` de cli/index.ts et les lignes `| \\`essaim …\\`` du README signale `security` avant le patch et rien après. Pour le quickstart enfin, la seule vérification qui prouve le défaut est l'exécution : occuper 3100 puis lancer `essaim run` produit `EADDRINUSE`, et la même commande avec `--coordinator-url` ne le produit pas — un `--dry-run` ne discriminerait pas, puisque `cli/run-core.ts:114-127` retourne avant d'appeler `runProject`.

- [ ] **Étape 1 : Constater les quatre défauts avant de toucher quoi que ce soit**

Depuis la racine du dépôt (`C:/Users/gagno/projet/essaim-new`), en bash (Git Bash sous Windows) :

```bash
# (a) le coordinator est démarré automatiquement, port 3100
sed -n '134,141p' src/orchestrator/orchestrator.ts
# attendu, mot pour mot :
#   if (mode === "with_coordinator" && !runOpts.coordinatorUrl) {
#     const port = parseInt(process.env.PORT || "3100", 10);
#     const dataDir = process.env.COORDINATOR_DATA_DIR || "./tmp-essaim/coordinator-data";
#     log.info(`Starting in-process coordinator on port ${port} (dataDir: ${dataDir})`);
#     coordinatorHandle = await startServer({ port, dataDir, registerSignalHandlers: false });
#     runOpts = { ...runOpts, coordinatorUrl: `http://127.0.0.1:${coordinatorHandle.port}` };
#     log.info(`In-process coordinator ready at ${runOpts.coordinatorUrl}`);
#   }
sed -n '73,79p' README.md   # le quickstart qui occupe ce même port à la main

# (b) les jetons morts de la page
git grep -In -e 'essaim bce' -e '--preset' -e 'mcp-coordinator run' -- . ':!CHANGELOG.md' ':!.github/workflows/test.yml'
# attendu : 7 lignes, toutes dans docs/index.html (1241, 1715, 1718, 1721, 1724, 1928, 1934)

# (c) compteurs réels du catalogue
ls templates/*.yaml | wc -l      # 15
ls behaviors/*.yaml | wc -l      # 46
ls presets/*.yaml | wc -l        # 29
ls compositions/*.yaml | wc -l   # 3
grep -n 'data-count=\|<strong>32<\|<strong>20<\|12 Behavioral' docs/index.html
# attendu : 1234 data-count="12", 1235 data-count="32", 1236 data-count="21",
#           1541 <strong>32</strong>, 1542 <strong>20</strong>, 1992 "12 Behavioral Templates"

# (d) commandes enregistrées vs tableau du README
grep -n 'program.addCommand' cli/index.ts
# attendu : run, pipeline, solo, scan, security, init, list, self-update (8)
grep -n '^| `essaim ' README.md
# attendu : 7 lignes — `security` manque
```

Ne passez à la suite que si les six blocs ci-dessus donnent bien ce résultat. Si un numéro de ligne a bougé (rebase, autre branche), rectifiez-le avant d'éditer : toutes les étapes suivantes utilisent des remplacements de chaînes exactes, pas des numéros de ligne.

- [ ] **Étape 2 : README : supprimer l'étape « Start the coordinator »**

Dans `README.md`, remplacer ce bloc **exact** (lignes 73 à 81) :

```markdown
### Start the coordinator

essaim delegates all coordination state to `mcp-coordinator`. Start it once:

```bash
mcp-coordinator server start --daemon
```

### Run your first swarm
```

par cette seule ligne :

```markdown
### Run your first swarm
```

La table des matières (ligne 13) pointe sur `#quickstart`, pas sur cette sous-section : rien d'autre à mettre à jour. Vérifier :

```bash
git grep -In 'mcp-coordinator server' README.md   # attendu : aucune sortie
```

- [ ] **Étape 3 : README : dire que le coordinator est démarré tout seul, et comment en viser un externe**

Toujours dans `README.md`, remplacer la ligne 94 **exacte** :

```markdown
> The `swarm` preset runs discover → execute phases. Agents discover issues in read-only mode, share findings via the coordinator, then work-steal tasks from the shared pool until the pool is drained.
```

par :

```markdown
> **No coordinator to start by hand.** `essaim run` — and `essaim pipeline` / `essaim security`, which go through the same path — boots `mcp-coordinator` **in-process on port `3100`** (override with the `PORT` env var) and shuts it down when the run ends. If something is already listening on `3100`, point essaim at it instead; otherwise the run dies on `EADDRINUSE` before the first agent starts:
>
> ```bash
> essaim run swarm -p ~/my-project --agents 3 --coordinator-url http://127.0.0.1:3100
> ```
>
> `essaim solo` is different: it runs the agent in `solo_mode` and starts no coordinator at all.

> The `swarm` preset runs discover → execute phases. Agents discover issues in read-only mode, share findings via the coordinator, then work-steal tasks from the shared pool until the pool is drained.
```

La dernière phrase sur `solo` est vérifiable : `cli/solo.ts:113` fait directement `const child = spawn("claude", args, { stdio: "inherit", cwd: projectPath });` — aucun appel à `runProject`, donc aucun `startServer`.

- [ ] **Étape 4 : README : compléter le tableau CLI avec `essaim security` (et `--security` sur init)**

Dans `README.md`, remplacer ce bloc **exact** (lignes 232-233) :

```markdown
| `essaim scan <path>` | Auto-detect project language, structure, test framework |
| `essaim init [path] [--url url] [--name name] [--modules list]` | Install hooks + MCP config on a project |
```

par :

```markdown
| `essaim scan <path>` | Auto-detect project language, structure, test framework |
| `essaim security [-p path] [--engine list] [--scan-mode mode] [--scope-mode mode] [--diff-base ref] [--authorize] [--secrets-file path] [--scan-timeout min] [--no-require-findings] [--triage-only] [--agents N] [--timeout min] [--cleanup] [--dry-run] [--coordinator-url url]` | Scan for security findings, seed the coordinator, and let the swarm fix them (auto-fix on branches). Runs the `sentinelle` template; engines are out-of-process adapters (v1: Strix). |
| `essaim init [path] [--url url] [--name name] [--modules list] [--security]` | Install hooks + MCP config on a project. `--security` also scaffolds the security config + `.gitignore`. |
```

Deux points de vigilance :
- La ligne `security` est placée **entre** `scan` et `init` pour suivre l'ordre d'enregistrement de `cli/index.ts:19-26`.
- Aucune barre verticale littérale dans les cellules : les valeurs sont écrites `mode` et non `quick|deep`, sinon le tableau Markdown se casse. Les valeurs acceptées restent documentées dans `--help`.

Les drapeaux listés sont ceux de `cli/security.ts:99-113` et `cli/init.ts:9-12`, un pour un.

- [ ] **Étape 5 : README : corriger le renvoi vers `essaim list presets`**

`essaim list` ne déclare aucun argument (`cli/list.ts:7-13` : `new Command("list").description(...).option("-p, --project <path>", ...).option("--catalog <path>", ...)`). Avec commander 14, `essaim list presets` produit `error: too many arguments for 'list'. Expected 0 arguments but got 1.`

Dans `README.md`, remplacer la ligne 315 **exacte** :

```markdown
For per-template descriptions and the preset roles each one wires together, run `essaim list presets` or read [`compositions/`](./compositions/) in this repo.
```

par :

```markdown
For per-template descriptions, run `essaim list`. The preset roles each template wires together are declared in [`templates/`](./templates/) and defined in [`presets/`](./presets/) in this repo.
```

(Le renvoi vers `compositions/` était doublement faux : les rôles d'un template vivent dans `templates/*.yaml`, `compositions/` ne contient que les 3 règles de réécriture.)

- [ ] **Étape 6 : docs/index.html : remettre les compteurs aux valeurs réelles**

Trois remplacements dans `docs/index.html`. Aucun n'a d'attribut `data-i18n` sur le nombre lui-même, donc une seule édition par bloc suffit.

**6a — hero (lignes 1234-1236)**, remplacer :

```html
      <div class="stat-pill"><strong data-count="12">0</strong> <span data-i18n="hero.stat.tools">templates</span></div>
      <div class="stat-pill"><strong data-count="32">0</strong> <span data-i18n="hero.stat.behaviors">BCE behaviors</span></div>
      <div class="stat-pill"><strong data-count="21">0</strong> <span data-i18n="hero.stat.topics">presets</span></div>
```

par :

```html
      <div class="stat-pill"><strong data-count="15">0</strong> <span data-i18n="hero.stat.tools">templates</span></div>
      <div class="stat-pill"><strong data-count="46">0</strong> <span data-i18n="hero.stat.behaviors">BCE behaviors</span></div>
      <div class="stat-pill"><strong data-count="29">0</strong> <span data-i18n="hero.stat.topics">presets</span></div>
```

**6b — section BCE (lignes 1541-1542)**, remplacer :

```html
      <div class="stat-pill"><strong>32</strong> <span data-i18n="bce.stat.behaviors">behaviors</span></div>
      <div class="stat-pill"><strong>20</strong> <span data-i18n="bce.stat.presets">presets</span></div>
```

par :

```html
      <div class="stat-pill"><strong>46</strong> <span data-i18n="bce.stat.behaviors">behaviors</span></div>
      <div class="stat-pill"><strong>29</strong> <span data-i18n="bce.stat.presets">presets</span></div>
```

Ne touchez pas aux trois autres pastilles de ce bloc : `3` composition rules (3 fichiers dans `compositions/`), `3` workflow phases (discover / review / execute) et `4` behavioral layers (foundation / patterns / mission / transversal) sont exactes.

**6c — titre de la section Templates (lignes 1992-1993)**, remplacer :

```html
      <h2 class="section-title">12 Behavioral Templates</h2>
      <p class="section-sub">Pre-composed behavioral presets. Each template assembles agents from reusable YAML behaviors — coordination, workspace, mission, safety.</p>
```

par :

```html
      <h2 class="section-title">Behavioral Templates</h2>
      <p class="section-sub">Pre-composed behavioral presets. Each template assembles agents from reusable YAML behaviors — coordination, workspace, mission, safety. essaim ships 15; the 12 diagrammed below are the ones with a flow chart — <code style="color:var(--accent);font-size:0.85em;">essaim list</code> prints them all.</p>
```

Pourquoi ne pas écrire « 15 Behavioral Templates » : la grille ne contient que 12 cartes (`.tmpl-name` aux lignes 2009, 2037, 2063, 2090, 2118, 2145, 2171, 2201, 2232, 2261, 2288, 2319 — il manque `phare`, `sentinelle` et `migrate-phase2`). Mettre 15 en titre déplacerait le mensonge au lieu de le supprimer. Le sous-titre dit maintenant le vrai des deux nombres.

- [ ] **Étape 7 : docs/index.html : remplacer les quatre blocs de commandes mortes**

Quatre remplacements. Chaque nouvelle commande n'utilise que des drapeaux réellement déclarés (`cli/run.ts:11-26`, `cli/solo.ts:42-50`, `cli/init.ts:9-12`).

**7a — terminal du hero (ligne 1241)** : `--preset` n'existe sur aucune commande. Remplacer :

```html
      <div class="hero-term-line"><span class="t-dim">$</span> <span class="t-green">essaim run raid</span> -p . --agents <span class="t-yellow">4</span> --preset <span class="t-blue">bug-hunt</span></div>
```

par :

```html
      <div class="hero-term-line"><span class="t-dim">$</span> <span class="t-green">essaim run raid</span> -p . --agents <span class="t-yellow">4</span> --max-quota-pct <span class="t-blue">90</span></div>
```

**7b — bloc terminal « One CLI to compose, inspect and build » (lignes 1714-1727)** : il n'y a pas de sous-commande `bce`, `cli/index.ts` n'enregistre que huit commandes. Remplacer :

```html
    <div class="terminal fade-in" style="max-width: 760px;">
      <div><span class="t-green">$</span> essaim bce list behaviors</div>
      <div><span class="t-dim">46 behaviors &mdash; foundation / patterns / mission / transversal</span></div>
      <div>&nbsp;</div>
      <div><span class="t-green">$</span> essaim bce list presets</div>
      <div><span class="t-dim">29 presets &mdash; raid, melee, essaim, chaine, revue, maitre, &hellip;</span></div>
      <div>&nbsp;</div>
      <div><span class="t-green">$</span> essaim bce build raid <span class="t-yellow">--dry-run</span></div>
      <div><span class="t-dim"># Preview prompt.md + hooks + .mcp.json without writing to disk</span></div>
      <div>&nbsp;</div>
      <div><span class="t-green">$</span> essaim bce build raid \</div>
      <div>&nbsp;&nbsp;<span class="t-yellow">--set</span> coordinator-rules.solo_mode=true \</div>
      <div>&nbsp;&nbsp;<span class="t-yellow">--set</span> bug-hunting.modules=<span class="t-green">'["src/auth"]'</span></div>
    </div>
```

par :

```html
    <div class="terminal fade-in" style="max-width: 760px;">
      <div><span class="t-green">$</span> essaim list</div>
      <div><span class="t-dim">15 templates &mdash; raid, melee, swarm, chaine, revue, maitre, &hellip;</span></div>
      <div>&nbsp;</div>
      <div><span class="t-green">$</span> essaim run raid <span class="t-yellow">--dry-run</span></div>
      <div><span class="t-dim"># Preview the assembled prompts + agent plan without launching</span></div>
      <div>&nbsp;</div>
      <div><span class="t-green">$</span> essaim solo gardien -p . \</div>
      <div>&nbsp;&nbsp;<span class="t-yellow">--set</span> audit-output.paths=<span class="t-green">'["AUDIT.md"]'</span></div>
      <div>&nbsp;</div>
      <div><span class="t-green">$</span> essaim run raid -p . \</div>
      <div>&nbsp;&nbsp;<span class="t-yellow">--set</span> bug-hunting.modules=<span class="t-green">'["src/auth"]'</span></div>
    </div>
```

(Le titre `bce.usage.title` de la ligne 1711, « One CLI to compose, inspect and build », reste juste : ces quatre commandes composent, inspectent et lancent. Ne pas y toucher — il est traduit dans les six langues.)

**7c — carte « Initialize your project » (ligne 1928)** : `--preset` n'existe pas sur `init`. Remplacer :

```html
        <div class="code-block">essaim init ~/project \<br/>  --url http://localhost:3100 \<br/>  --name "Alice" \<br/>  --preset bug-hunt</div>
```

par :

```html
        <div class="code-block">essaim init ~/project \<br/>  --url http://127.0.0.1:3100 \<br/>  --name "Alice" \<br/>  --modules src/auth,src/users</div>
```

(`127.0.0.1` plutôt que `localhost` : c'est la valeur par défaut de `cli/init.ts:9` et le dépôt a déjà un test dédié à ce piège, `tests/unit/coordinator-url-ipv4.test.ts`.)

**7d — carte « Run your first swarm » (ligne 1934)** : `mcp-coordinator` n'a pas de sous-commande `run` de templates ; c'est le binaire `essaim` qui lance un swarm. Remplacer :

```html
        <div class="code-block">cd ~/project && claude<br/><span style="color:var(--muted)"># or</span><br/>mcp-coordinator run raid -p . --agents 3</div>
```

par :

```html
        <div class="code-block">cd ~/project && claude<br/><span style="color:var(--muted)"># or</span><br/>essaim run raid -p . --agents 3</div>
```

- [ ] **Étape 8 : CI : ajouter le grep de garde-fou au job `no-domain-artifacts` existant**

Un test unitaire sur du HTML de présentation coûterait plus cher que ce qu'il garde (il faudrait parser le DOM, maintenir des sélecteurs, et il casserait à chaque retouche de design). Le garde-fou proportionné est un grep, sur trois jetons morts et vérifiables uniquement.

Le patron à suivre est celui des deux étapes déjà présentes dans `.github/workflows/test.yml` (lignes 17-28) : un `git grep -In` dont la sortie est capturée, un `if` qui échoue avec `::error::` et affiche les lignes fautives, et surtout un **pathspec d'exclusion `':!<fichier>'` pour tout fichier qui a une raison légitime de contenir le jeton** — l'étape existante s'exclut elle-même parce qu'elle est le seul endroit où le terme interdit est épelé.

Dans `.github/workflows/test.yml`, remplacer ce bloc **exact** (lignes 23 à 29, la ligne 29 étant la ligne vide qui précède `  test:`) :

```yaml
      - name: Refuser toute mention "<terme-interdit>"
        run: |
          if git grep -In -i '<terme-interdit>' -- . ':!.github/workflows/test.yml' > /tmp/hits 2>/dev/null; then
            echo "::error::Le terme '<terme-interdit>' est réapparu dans des fichiers suivis :"; cat /tmp/hits; exit 1
          fi
          echo "OK — aucune trace <terme-interdit>."

```

ATTENTION : `<terme-interdit>` ci-dessus est un masque. **Ne le tapez pas** — ouvrez le fichier, laissez l'étape existante rigoureusement intacte, et **insérez** seulement le bloc ci-dessous juste après sa dernière ligne (`echo "OK — …"`, ligne 28) et avant la ligne vide qui précède `  test:` :

```yaml

      # Même patron que ci-dessus : un git grep sur des jetons morts et vérifiables,
      # avec exclusion des fichiers qui ont une raison légitime de les contenir.
      # `essaim bce`, `--preset` et `mcp-coordinator run` n'existent dans aucune des
      # huit commandes enregistrées par cli/index.ts. Les laisser dans la doc publique,
      # c'est offrir au premier visiteur une commande qui échoue immédiatement
      # (commander 14 refuse une option inconnue et un argument en trop).
      # CHANGELOG.md est exclu : il documente légitimement la suppression passée de
      # `essaim bce`. Ce workflow s'exclut lui-même, comme l'étape précédente.
      - name: Refuser les commandes CLI inexistantes dans la doc
        run: |
          if git grep -In -e 'essaim bce' -e '--preset' -e 'mcp-coordinator run' -- . ':!CHANGELOG.md' ':!.github/workflows/test.yml' > /tmp/dead-cli 2>/dev/null; then
            echo "::error::Commandes CLI inexistantes dans la doc :"; cat /tmp/dead-cli; exit 1
          fi
          echo "OK — aucune commande CLI morte."
```

Notes de mise en œuvre :
- `-e '--preset'` est sûr : `git grep` traite l'argument qui suit `-e` comme un motif, jamais comme une option.
- Le job `no-domain-artifacts` utilise `actions/checkout` sans `fetch-depth` particulier ; `git grep` opère sur l'arbre de travail, une profondeur de 1 suffit.
- Le job tourne en parallèle du job `test` ; il ne rallonge pas la CI.

- [ ] **Étape 9 : Vérification finale et commit**

Vérification manuelle exacte, à exécuter depuis la racine du dépôt en bash :

```bash
# 1. Le garde-fou est vert (c'est le test discriminant)
git grep -In -e 'essaim bce' -e '--preset' -e 'mcp-coordinator run' -- . ':!CHANGELOG.md' ':!.github/workflows/test.yml'; echo "exit=$?"
# AVANT le patch : 7 lignes dans docs/index.html, exit=0  → l'étape CI échouerait
# APRÈS le patch : aucune sortie, exit=1                  → l'étape CI passe

# 2. Compteurs de la page == catalogue réel
echo "templates=$(ls templates/*.yaml | wc -l) behaviors=$(ls behaviors/*.yaml | wc -l) presets=$(ls presets/*.yaml | wc -l) compositions=$(ls compositions/*.yaml | wc -l)"
# attendu : templates=15 behaviors=46 presets=29 compositions=3
grep -n 'data-count="15"\|data-count="46"\|data-count="29"\|<strong>46</strong>\|<strong>29</strong>' docs/index.html
# attendu : 5 lignes (1234, 1235, 1236, 1541, 1542)
git grep -In '12 Behavioral Templates\|<strong>32</strong>\|<strong>20</strong>\|data-count="12"\|data-count="32"\|data-count="21"' docs/index.html
# attendu : aucune sortie

# 3. Le tableau CLI du README == les commandes enregistrées
grep -o 'create[A-Za-z]*Command' cli/index.ts | sed 's/^create//;s/Command$//' | tr 'A-Z' 'a-z' | sort > /tmp/registered.txt
grep -o '^| `essaim [a-z-]*' README.md | sed 's/^| `essaim //' | sort > /tmp/documented.txt
diff /tmp/registered.txt /tmp/documented.txt
# attendu : aucune sortie (8 == 8 ; `selfupdate` vs `self-update` : si diff signale
# uniquement cette paire, c'est le camelCase du nom de fabrique, pas un manque —
# vérifiez alors à l'œil que la ligne `essaim self-update` est bien présente)

# 4. Toutes les commandes de la doc répondent vraiment (aucun token consommé)
pnpm dev -- --help
pnpm dev -- security --help
pnpm dev -- init --help          # doit lister --url, --name, --modules, --security
pnpm dev -- run --help           # NE doit PAS lister --preset
pnpm dev -- list                 # doit imprimer 15 templates
pnpm dev -- run raid -p . --dry-run
pnpm dev -- list presets ; echo "exit=$?"
# attendu : "error: too many arguments for 'list'..." et exit=1
#           → confirme a posteriori que le renvoi corrigé à l'étape 5 était bien mort

# 5. Rien d'autre n'a bougé
pnpm test && pnpm build
```

Vérification optionnelle du défaut (a), si vous voulez le voir échouer en vrai (nécessite un dépôt git jetable dans `/tmp/essaim-smoke`) :

```bash
node -e "const s=require('net').createServer(); s.listen(3100, ()=>console.log('port 3100 occupé')); setTimeout(()=>s.close(), 30000)" &
pnpm dev -- run gardien -p /tmp/essaim-smoke
# attendu : Error: listen EADDRINUSE: address already in use :::3100
# puis, avec le contournement que le README documente désormais :
pnpm dev -- run gardien -p /tmp/essaim-smoke --coordinator-url http://127.0.0.1:3100
# attendu : plus d'EADDRINUSE (essaim ne tente plus de binder le port)
```

Commit (message exact) :

```
docs: le premier contact public ne marche plus, on le répare

Le quickstart du README faisait démarrer un coordinator externe sur 3100
alors que `essaim run` en démarre un in-process sur ce même port depuis la
Strategy A (orchestrator.ts:134-141) : l'étape 2 tuait l'étape 3 sur un
EADDRINUSE, avant le premier agent. L'étape disparaît, remplacée par la
note qui dit ce qui se passe vraiment et comment viser un coordinator déjà
en place avec --coordinator-url.

docs/index.html donnait quatre commandes copiables qui n'existent dans
aucune des huit commandes de cli/index.ts : `essaim bce list|build`,
`--preset` (sur run et sur init), et `mcp-coordinator run raid`. Avec
commander 14 ce ne sont pas des approximations, ce sont des erreurs
immédiates. Elles sont remplacées par des commandes réelles.

Les compteurs de la page annonçaient 12 templates / 32 behaviors /
20-21 presets ; le catalogue en contient 15 / 46 / 29. Le titre de la
section Templates ne prétend plus être exhaustif : la grille n'en
diagramme que 12 sur 15.

Le tableau CLI du README se disait exhaustif sans lister `essaim security`.

Un test unitaire sur du HTML de présentation coûterait plus que ce qu'il
garde ; le job no-domain-artifacts reçoit à la place un git grep sur les
trois jetons morts, calqué sur ses deux étapes existantes, exclusions
comprises.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

#### Corrections de relecture — à appliquer AVANT d'exécuter cette tâche

Une passe adversariale a relu cette tâche fichier par fichier. Les points ci-dessous corrigent le contenu au-dessus ; en cas de contradiction, **c'est cette section qui fait foi**.

**DANGER — Étape 8 : l'instruction est contradictoire et, prise au premier degré, neutralise silencieusement le garde-fou existant. Elle dit d'abord « remplacer ce bloc **exact** (lignes 23 à 29) » en montrant un bloc où le terme filtré est masqué en `<terme-interdit>`, puis dit deux paragraphes plus loin « Ne le tapez pas … insérez seulement ». Un implémenteur qui suit la première phrase remplace l'étape réelle (lignes 23-28 du fichier, vérifiées : `- name: Refuser toute mention "mekova"` / `git grep -In -i 'mekova' -- . ':!.github/workflows/test.yml'` / `echo "OK — aucune trace mekova."`) par une étape qui grep la chaîne littérale `<terme-interdit>` : la CI reste verte, le job passe, et le garde-fou du dépôt public est mort sans que personne ne le voie. L'étape doit être une insertion pure, jamais un remplacement.**

Remplacer intégralement le champ `contenu` de l'étape 8 par :

---
Un test unitaire sur du HTML de présentation coûterait plus cher que ce qu'il garde (parser le DOM, maintenir des sélecteurs, casser à chaque retouche de design). Le garde-fou proportionné est un grep, sur trois jetons morts et vérifiables uniquement.

**N'ÉDITEZ AUCUNE LIGNE EXISTANTE.** Le job `no-domain-artifacts` de `.github/workflows/test.yml` se termine aujourd'hui ainsi :

- ligne 23 : `      - name: Refuser toute mention "…"` — le terme filtré est épelé en clair dans ce fichier, qui est le seul endroit du dépôt autorisé à le contenir. Ne le lisez pas à voix haute, ne le recopiez nulle part, ne retapez pas cette ligne.
- ligne 25 : le `git grep -In -i '…' -- . ':!.github/workflows/test.yml'` correspondant
- ligne 28 : `          echo "OK — aucune trace …."`
- ligne 29 : ligne vide
- ligne 30 : `  test:`

Opération : **insertion pure**. Placez le curseur à la fin de la ligne 28 et insérez le bloc ci-dessous (une ligne vide, puis huit lignes de commentaire, puis la nouvelle étape). La ligne vide d'origine et `  test:` restent en dessous, inchangées.

```yaml

      # Même patron que l'étape précédente : un git grep sur des jetons morts et
      # vérifiables, avec exclusion des fichiers qui ont une raison légitime de les
      # contenir. `essaim bce`, `--preset` et `mcp-coordinator run` n'existent dans
      # aucune des huit commandes enregistrées par cli/index.ts. Les laisser dans la
      # doc publique, c'est offrir au premier visiteur une commande qui échoue
      # immédiatement (commander 14 refuse une option inconnue et un argument en trop).
      # CHANGELOG.md est exclu : il documente légitimement la suppression passée de
      # `essaim bce`. Ce workflow s'exclut lui-même, comme l'étape précédente.
      - name: Refuser les commandes CLI inexistantes dans la doc
        run: |
          if git grep -In -e 'essaim bce' -e '--preset' -e 'mcp-coordinator run' -- . ':!CHANGELOG.md' ':!.github/workflows/test.yml' > /tmp/dead-cli 2>/dev/null; then
            echo "::error::Commandes CLI inexistantes dans la doc :"; cat /tmp/dead-cli; exit 1
          fi
          echo "OK — aucune commande CLI morte."
```

Contrôle immédiat après insertion (15 lignes ajoutées après la ligne 28) :

```bash
grep -n 'name: Refuser\|^  test:' .github/workflows/test.yml
# attendu, exactement 4 lignes :
#   17: - name: Refuser les fichiers …      (intacte)
#   23: - name: Refuser toute mention …     (intacte)
#   38: - name: Refuser les commandes CLI inexistantes dans la doc
#   45: test:
# Si la ligne 23 a changé de texte, vous avez écrasé le garde-fou : annulez (git checkout -- .github/workflows/test.yml) et recommencez en insertion.
```

Notes de mise en œuvre :
- `-e '--preset'` est sûr : `git grep` traite l'argument qui suit `-e` comme un motif, jamais comme une option.
- Le `if git grep …; then` met le grep en position de condition : `bash -e` (le shell par défaut de GitHub Actions) ne coupe donc pas l'étape quand le grep sort en 1.
- Le job `no-domain-artifacts` utilise `actions/checkout` sans `fetch-depth` particulier ; `git grep` opère sur l'arbre de travail, une profondeur de 1 suffit.
- Le job tourne en parallèle du job `test` ; il ne rallonge pas la CI.
---

**Étape 9, vérification n°3 : la commande de comparaison README ↔ CLI est cassée et ne peut PAS donner le résultat annoncé. `grep -o 'create[A-Za-z]*Command' cli/index.ts` matche à la fois les 8 lignes d'import (`import { createRunCommand } from "./run.js";`, lignes 3-10) ET les 8 lignes `program.addCommand(createRunCommand());` (19-26) : le fichier /tmp/registered.txt contient donc 16 entrées, chaque nom en double, face à 8 côté README. Exécuté tel quel sur l'arbre actuel, le pipeline sort : `init / init / list / list / pipeline / pipeline / run / run / scan / scan / security / security / selfupdate / selfupdate / solo / solo`. Le `diff` ne sera jamais vide, ni avant ni après le patch, alors que l'étape annonce « attendu : aucune sortie (8 == 8) ». La vérification ne discrimine rien et envoie un faux signal d'échec.**

Dans l'étape 9, remplacer le bloc « # 3. Le tableau CLI du README == les commandes enregistrées » par :

```bash
# 3. Le tableau CLI du README == les commandes enregistrées
#    On ancre sur `addCommand(create…` pour ne pas compter deux fois les imports,
#    et on réécrit le camelCase de la fabrique SelfUpdate en son id CLI self-update.
diff <(grep -o 'addCommand(create[A-Za-z]*Command' cli/index.ts \
        | sed 's/addCommand(create//;s/Command$//;s/SelfUpdate/self-update/' \
        | tr 'A-Z' 'a-z' | sort) \
     <(grep -o '^| `essaim [a-z-]*' README.md | sed 's/^| `essaim //' | sort)
# AVANT le patch : une seule ligne, `< security` — la commande enregistrée mais absente du tableau
# APRÈS le patch : aucune sortie, exit 0
```

(Vérifié : exécuté sur l'arbre actuel ce pipeline sort exactement `6d5` puis `< security`. C'est bien un contrôle discriminant, contrairement à la version d'origine.)

**Étape 1, bloc (c) : la sortie attendue du grep est fausse — il manque la ligne 1237. `grep -n 'data-count=\|<strong>32<\|<strong>20<\|12 Behavioral' docs/index.html` renvoie 7 lignes, pas 6 : 1234, 1235, 1236, **1237** (`<strong data-count="4">0</strong>` — les 4 niveaux d'effort, valeur correcte à ne pas toucher), 1541, 1542, 1992. Comme l'étape 1 se termine par « Ne passez à la suite que si les six blocs ci-dessus donnent bien ce résultat », l'implémenteur constate un écart et se bloque, ou pire, croit devoir « corriger » le compteur 4.**

Dans l'étape 1, remplacer les trois lignes de commentaire du bloc (c) par :

```bash
grep -n 'data-count=\|<strong>32<\|<strong>20<\|12 Behavioral' docs/index.html
# attendu : 7 lignes —
#   1234 data-count="12"   1235 data-count="32"   1236 data-count="21"   <- à corriger
#   1237 data-count="4"    <- CORRECT (4 niveaux d'effort), ne pas y toucher
#   1541 <strong>32</strong>   1542 <strong>20</strong>                    <- à corriger
#   1992 "12 Behavioral Templates"                                          <- à corriger
```

**Risque n°3 : l'énumération des occurrences de `v0.9.x` dans docs/index.html est incomplète. Le fichier en contient 13, pas 10 : les lignes 2432, 2541, 2759, 2768, 2986, 2995, 3213, 3222, 3440, 3449 citées, **plus 3667 (pied de page chinois), 3676 (hero japonais) et 3894 (pied de page japonais)**. Un lecteur qui reprendrait ce risque pour un futur commit de mise à jour de version laisserait deux locales sur six en v0.9.x.**

Remplacer le troisième élément de `risques` par :

« `docs/index.html` affiche encore `v0.9.x` dans le hero et le pied de page — 13 occurrences, lignes 2432, 2541, 2759, 2768, 2986, 2995, 3213, 3222, 3440, 3449, 3667, 3676 et 3894 (les trois dernières sont le pied de page chinois puis le hero et le pied de page japonais) — alors que `package.json:3` est en `"version": "0.13.0"` ; et un mock de dashboard affiche `essaim v0.1.0` (ligne 1894). Non corrigé ici : ce sont des chaînes traduites dans six langues, hors du périmètre « compteurs du catalogue », et elles ne cassent aucune commande. Contrôle si vous les reprenez un jour : `grep -c 'v0\.9\.x' docs/index.html` doit tomber à 0, pas à 3. »

**Incohérence interne entre la fiche `fichiers` et l'étape 2 sur la plage README supprimée. La fiche annonce « lignes 73-79 (supprimées) », l'étape 2 dit « remplacer ce bloc exact (lignes 73 à 81) ». Vérifié dans le fichier : 73 `### Start the coordinator`, 74 vide, 75 texte, 76 vide, 77 ```bash, 78 `mcp-coordinator server start --daemon`, 79 ```, 80 vide, 81 `### Run your first swarm`. Le remplacement porte donc bien sur 73-81 et supprime réellement 73-80, la ligne 81 étant conservée. Ni « 73-79 » ni la lecture naïve de « 73 à 81 supprimées » ne décrivent l'opération.**

Dans `fichiers`, remplacer le champ `lignes` de l'entrée README.md par :

"73-80 (supprimées : du titre `### Start the coordinator` jusqu'à la ligne vide qui précède `### Run your first swarm`, cette dernière étant conservée), 94 (note insérée avant), 232-233 (ligne `essaim security` ajoutée entre les deux), 315 (renvoi réécrit)"

Et ajouter en fin de l'étape 2, après la commande de vérification :

```bash
grep -n '^### ' README.md | sed -n '1,4p'
# attendu : 61:### Prerequisites, 67:### Install, 73:### Run your first swarm
# (le titre "### Start the coordinator" a disparu, "Run your first swarm" remonte de 81 à 73)
```

**Risques :**
- Le terme client filtré par le job `no-domain-artifacts` n'est épelé que dans `.github/workflows/test.yml`. Si vous le recopiez dans un commentaire, un message de commit versionné ou une note, la CI échouera sur son propre dépôt. L'étape 8 le masque volontairement en `<terme-interdit>` : ouvrez le fichier, n'y touchez pas, insérez seulement le nouveau bloc après.
- Le motif `--preset` du garde-fou bloquera une future documentation légitime d'un drapeau `--preset` si la CLI en gagne un un jour. C'est assumé : aucune commande n'en déclare aujourd'hui, et le jour où l'une le fera, l'auteur retirera le motif dans le même commit.
- `docs/index.html` affiche encore `v0.9.x` dans le hero et le pied de page (lignes 2432, 2541, 2759, 2768, 2986, 2995, 3213, 3222, 3440, 3449) alors que `package.json` est en 0.13.0, et un mock de dashboard affiche `essaim v0.1.0` (ligne 1894). Non corrigé ici : ce sont des chaînes traduites dans six langues, hors du périmètre « compteurs du catalogue », et elles ne cassent aucune commande.
- La carte « Step 1 » de la page s'intitule encore `Start the coordinator` (ligne 1920) au-dessus d'un bloc `npm install -g essaim`. Le titre est une clé i18n présente dans les six dictionnaires ; le corriger correctement demanderait six traductions. La commande sous-jacente, elle, est juste, et l'étape 7d supprime la seule vraie casse de ce parcours.
- Le README (ligne 342) affirme que `run` **et** `solo` font le pré-vol de quota Anthropic. Vérification faite, l'action de `cli/solo.ts:62-133` n'appelle jamais `preflightQuotaCheck` : elle scanne, assemble et `spawn("claude", …)`. De même, `cli/solo.ts:47-50` déclare une option `--coordinator-url` que le corps de l'action n'utilise jamais. Deux défauts réels mais hors périmètre de cette tâche : à traiter séparément, côté code plutôt que côté doc.
- Ne modifiez aucune clé du dictionnaire `translations` (docs/index.html:2533-3896) en passant : `setLanguage()` écrase le `innerHTML` de tout élément portant `data-i18n`, et une clé touchée dans une seule langue produit une page incohérente selon la locale du visiteur. Tous les blocs édités ici en sont dépourvus — vérifiable en relisant les lignes citées.
- La CI ne construit ni ne publie `docs/` (absent de la liste `files` de package.json ; GitHub Pages sert le fichier tel quel). Aucune étape de build à déclencher : le rendu se vérifie en ouvrant le fichier dans un navigateur, et le hero doit animer 15 / 46 / 29 / 4.

