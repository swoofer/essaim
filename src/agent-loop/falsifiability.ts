import { createLogger } from "../logger.js";

const log = createLogger("falsifiability");

/**
 * Vérifie qu'un test de régression ÉCHOUE sans le patch.
 *
 * Les missions de chasse aux bugs et de remédiation exigent déjà « écris un
 * test qui échoue avant ton patch ». Rien ne le vérifiait. Mesuré : un agent a
 * « corrigé » deux champs qui ne sont pas contrôlables par le moteur — un SHA-1
 * calculé localement et une valeur passée par une allowlist stricte — avec un
 * test qui passait dans les deux cas, et a conclu DONE.
 *
 * Le principe : NEUTRALISER les fichiers non-test modifiés, relancer les tests
 * touchés, et exiger un échec. Si le test passe sans le patch, il ne prouve
 * rien — la tâche n'est pas terminée.
 */

export interface ExecResult {
  code: number;
  stdout: string;
}

export interface FalsifiabilityDeps {
  /** Exécute une commande dans le worktree. Ne doit jamais jeter. */
  exec(cmd: string, args: string[]): Promise<ExecResult>;
  /**
   * Écrit un patch dans un fichier temporaire HORS du worktree et rend son
   * chemin. Séparé d'`exec` pour une raison mécanique : `exec` n'a pas d'entrée
   * standard, et `git apply` ne lit un patch que depuis un fichier ou stdin.
   * Injectable pour que les tests puissent le simuler.
   */
  writeTemp?(content: string): Promise<string>;
}

export interface FalsifiabilityVerdict {
  /** true = le test échoue sans le patch, donc il prouve quelque chose. */
  falsifiable: boolean;
  reason: string;
  /** Fichiers de test détectés dans le diff. */
  testFiles: string[];
  /** Fichiers de production neutralisés le temps du contrôle. */
  sourceFiles: string[];
}

/**
 * Un chemin de test, selon le LANGAGE du dépôt (#157). Codé en dur sur vitest
 * `tests/**.test.ts`, il ne rendait `true` que sur essaim lui-même : sur un
 * dépôt Go/Python, TOUS les fichiers de test que l'agent écrivait tombaient en
 * « source », et le garde refusait « aucun fichier de test modifié » sur du vrai
 * travail — essaim ne marchait donc VRAIMENT que sur essaim. Dérivé du langage,
 * comme test_command l'est déjà (agent-loop.ts:testCommandFor). Défaut TS :
 * rétro-compatible pour l'appelant historique.
 */
export function isTestFile(path: string, language = "typescript"): boolean {
  const p = path.replace(/\\/g, "/");
  switch (language) {
    case "go":
      return /(^|\/)[^/]+_test\.go$/.test(p);
    case "python":
      return /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(p) || /(^|\/)tests?\/.*\.py$/.test(p);
    case "rust":
      return /(^|\/)tests\/.*\.rs$/.test(p);
    case "java":
      return /(^|\/)[^/]*Tests?\.java$/.test(p) || /(^|\/)src\/test\/.*\.java$/.test(p);
    default: // typescript / javascript (vitest/jest) — `*.test.ts`/`*.spec.ts` partout
      return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p);
  }
}

/**
 * `git status --porcelain` → chemins modifiés ou ajoutés.
 *
 * Un RENOMMAGE se présente `R  ancien -> nouveau` : sans le décoder, le chemin
 * retenu devenait la CHAÎNE ENTIÈRE, flèche comprise. Passée telle quelle à
 * `git diff` sous `shell: true`, cmd.exe interprétait le `>` comme une
 * REDIRECTION et ÉCRASAIT le fichier de l'agent avec la sortie de git. Le
 * `shell: true` a disparu côté git (voir gitExec dans agent-loop.ts), mais un
 * pathspec portant une flèche ne désignerait toujours aucun fichier — on garde
 * donc le décodage.
 */
export function parseChangedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).trim())
    .map((p) => {
      const arrow = p.indexOf(" -> ");
      return arrow === -1 ? p : p.slice(arrow + 4).trim();
    })
    .filter(Boolean);
}

/** `git status --porcelain` → chemins SUIVIS seulement (tout sauf `??`). */
export function parseTrackedChanges(porcelain: string): string[] {
  const tracked = porcelain.split("\n").filter((l) => l.length > 3 && !l.startsWith("??"));
  return parseChangedFiles(tracked.join("\n"));
}

/** `git status --porcelain` → chemins NON SUIVIS seulement (préfixe `??`). */
export function parseUntrackedFiles(porcelain: string): string[] {
  const untracked = porcelain.split("\n").filter((l) => l.startsWith("??"));
  return parseChangedFiles(untracked.join("\n"));
}

/** `git diff --name-only` → un chemin par ligne, sans code d'état. */
export function parseNameOnly(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Retire le patch de production du worktree, et sait le remettre.
 * Deux mécanismes, parce que `git stash` ne peut pas retirer un COMMIT.
 */
type Neutralization =
  | { ok: true; restore: () => Promise<void> }
  | { ok: false; reason: string };

/** Voie historique : suffisante tant que le patch est resté dans l'arbre. */
async function neutralizeByStash(
  deps: FalsifiabilityDeps,
  sourceFiles: string[],
): Promise<Neutralization> {
  // `--include-untracked` : un patch qui CRÉE un fichier source ne serait pas
  // remisé sans lui, la remise échouerait, et le contrôle s'ouvrirait en grand
  // sur exactement le cas qu'il doit surveiller.
  const stash = await deps.exec("git", ["stash", "push", "--quiet", "--include-untracked", "--", ...sourceFiles]);
  if (stash.code !== 0) return { ok: false, reason: "remise impossible — contrôle sauté" };
  return {
    ok: true,
    restore: async () => {
      const pop = await deps.exec("git", ["stash", "pop", "--quiet"]);
      if (pop.code !== 0) {
        // Laisser un worktree amputé de son patch serait pire que tout.
        log.error("git stash pop a échoué — le patch est resté remisé", { sourceFiles });
      }
    },
  };
}

/**
 * PATCH INVERSE : le seul primitif symétrique quand le patch est COMMITÉ.
 *
 * `git stash push` sur des chemins propres-parce-que-commités sort 0 SANS RIEN
 * REMISER — vérifié sur un dépôt jetable, patch et test commités, arbre propre :
 * `git status:[]`, `git stash push --include-untracked -- src.ts` → exit 0, rien
 * de remisé, src.ts contenait toujours « patched ». Le contrôle rejouait alors
 * le test AVEC le patch en place, il passait, et le verdict devenait « le test
 * passe SANS le patch ». Réparer la base de diff sans réparer la neutralisation
 * aurait transformé 54 refus MUETS en 54 refus MENSONGERS : les deux ou aucun.
 *
 * `git diff <baseSha> -- <fichiers>` diffe baseSha contre l'ARBRE DE TRAVAIL :
 * il couvre donc le commité ET le non commité en une seule passe, et `git apply
 * -R` puis `git apply` forment un aller-retour exact (vérifié aussi sur un
 * worktree CRLF, où le patch émis par git est en LF).
 */
async function neutralizeByReversePatch(
  deps: FalsifiabilityDeps,
  baseSha: string,
  sourceFiles: string[],
  untracked: Set<string>,
): Promise<Neutralization> {
  if (!deps.writeTemp) return { ok: false, reason: "écriture de patch indisponible — contrôle sauté" };

  // ON NE TOUCHE JAMAIS À UN FICHIER NON SUIVI. La rédaction précédente les
  // faisait entrer dans le patch via `git add --intent-to-add`, pour que le
  // patch inverse les supprime. Deux conséquences mesurées, toutes deux pires
  // que le défaut réparé :
  //
  //  1. `.mcp.json` est non suivi dans TOUS les worktrees d'agent (promptweave
  //     l'y dépose à la création). Il devenait donc « fichier de production »
  //     à chaque tâche, et se faisait supprimer par la neutralisation.
  //  2. La restauration est un `git apply` unique, donc ATOMIQUE : si le seul
  //     lancement des tests recrée un artefact non suivi, `git apply` refuse
  //     le patch ENTIER (« already exists in working directory »), et le
  //     correctif de l'agent n'est PAS restauré — pendant que le verdict reste
  //     `falsifiable: true` et que la tâche part en `completeTask`. La remise
  //     historique, elle, laissait au moins une entrée récupérable dans
  //     `git stash list`.
  //
  // Un fichier non suivi APPARU pendant la tâche est traité en amont (il fait
  // fail-open explicite) ; un fichier non suivi préexistant n'est simplement
  // pas de notre ressort.
  const stillUntracked = sourceFiles.filter((f) => untracked.has(f));
  if (stillUntracked.length) {
    return { ok: false, reason: "fichier source non suivi — contrôle sauté" };
  }

  // `--binary` : sans lui, git rend « Binary files ... differ », un en-tête que
  // `git apply` REFUSE (« cannot apply binary patch without full index line »).
  // Un seul binaire non suivi dans le lot — capture, .db, fixture PNG —
  // désarmait donc tout le contrôle par fail-open.
  const patch = await deps.exec("git", ["diff", "--binary", baseSha, "--", ...sourceFiles]);
  if (patch.code !== 0 || !patch.stdout.trim()) {
    return { ok: false, reason: "aucun patch de production à neutraliser — contrôle sauté" };
  }

  const patchFile = await deps.writeTemp(patch.stdout);
  const reverted = await deps.exec("git", ["apply", "-R", patchFile]);
  if (reverted.code !== 0) {
    return { ok: false, reason: "patch inverse inapplicable — contrôle sauté" };
  }

  const restore = async () => {
    const back = await deps.exec("git", ["apply", patchFile]);
    if (back.code === 0) return;
    // `git apply` est ATOMIQUE : il refuse le patch ENTIER dès qu'un seul
    // fichier gêne — typiquement « already exists in working directory » quand
    // le lancement des tests a recréé un fichier que la neutralisation venait
    // de supprimer. Sans rattrapage, le correctif de l'agent est PERDU alors
    // que le verdict reste positif et que la tâche part en completeTask.
    // `git checkout HEAD --` rend leur contenu commité à tous les chemins
    // concernés : c'est exactement l'état d'avant le contrôle, puisque le
    // commit par tâche est ce que phase-execute.yaml:56 exige.
    const hard = await deps.exec("git", ["checkout", "HEAD", "--", ...sourceFiles]);
    if (hard.code !== 0) {
      log.error("restauration impossible — le worktree est resté sans son patch", { patchFile, sourceFiles });
      return;
    }
    log.warn("git apply a échoué — patch restauré depuis HEAD", { patchFile, sourceFiles });
  };

  // LE GARDE-FOU DU GARDE-FOU. `git apply -R` peut sortir 0 sans avoir rien
  // changé, comme `git stash push` le faisait. Un refus ne doit JAMAIS reposer
  // sur une neutralisation qui n'a pas eu lieu : si le patch est toujours là on
  // ne sait rien, et on le DIT. Le seul verdict négatif légitime reste « le
  // test est complaisant ».
  const effect = await deps.exec("git", ["diff", "--name-only", baseSha, "--", ...sourceFiles]);
  if (effect.code !== 0 || effect.stdout.trim()) {
    await restore();
    return { ok: false, reason: "neutralisation sans effet — contrôle sauté" };
  }

  return { ok: true, restore };
}

/**
 * Rejoue les tests sans les modifications de production.
 *
 * `baseSha` est le HEAD relevé AVANT que l'agent travaille sur la tâche. Sans
 * lui, le comportement historique est conservé (arbre de travail + remise).
 *
 * Fail-open sur toute anomalie d'outillage (git indisponible, neutralisation
 * impossible ou sans effet) : ce garde-fou doit attraper un test complaisant,
 * pas bloquer une tâche légitime parce que git a hoqueté. Le seul verdict
 * négatif est « le test passe sans le patch ».
 */
export async function verifyFailingTest(
  deps: FalsifiabilityDeps,
  testCommand: { cmd: string; args: string[] },
  baseSha?: string,
  baseUntracked?: string[],
  language = "typescript",
): Promise<FalsifiabilityVerdict> {
  // CONTRAT : ne jette JAMAIS. La docstring le promet depuis toujours et
  // l'appelant ne l'entoure d'aucun try — une exception ici remonte au catch
  // global d'agent-loop.ts et arrête la boucle de travail ENTIÈRE, pas le seul
  // contrôle. Mesuré : 900 fichiers non suivis sous dist/ suffisaient à faire
  // sortir `spawn` en ENAMETOOLONG et à tuer l'agent.
  try {
    return await runVerification(deps, testCommand, baseSha, baseUntracked, language);
  } catch (err) {
    return {
      falsifiable: true,
      reason: `contrôle impossible (${(err as Error).message}) — contrôle sauté`,
      testFiles: [],
      sourceFiles: [],
    };
  }
}

async function runVerification(
  deps: FalsifiabilityDeps,
  testCommand: { cmd: string; args: string[] },
  baseSha?: string,
  baseUntracked?: string[],
  language = "typescript",
): Promise<FalsifiabilityVerdict> {
  // `--untracked-files=all` est obligatoire : sans lui, git REPLIE un
  // répertoire entièrement non suivi en une seule entrée (`?? tests/`) et le
  // fichier de test que l'agent vient d'écrire n'est jamais vu — le verdict
  // devient « aucun fichier de test » sur une tâche qui en a bien produit un.
  const status = await deps.exec("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) {
    return { falsifiable: true, reason: "git status indisponible — contrôle sauté", testFiles: [], sourceFiles: [] };
  }

  const worktreeChanges = parseChangedFiles(status.stdout);
  const untracked = new Set(parseUntrackedFiles(status.stdout));

  // LE COMMIT PAR TÂCHE EST VOULU — c'est le garde-fou qui doit s'y adapter.
  // behaviors/phase-execute.yaml:56 ordonne « chaque tâche nécessite son PROPRE
  // commit », :59 « puis dis DONE: », et falsifiability.ts:70 n'interrogeait que
  // `git status` : l'ARBRE, que le commit vient précisément de vider. Le
  // garde-fou n'était pas trop strict, il était AVEUGLE. Mesuré : 54 refus sur
  // un banc de 6 runs, TOUS « aucun fichier de test modifié — rien ne prouve le
  // défaut », 3 des 4 vrais défauts finissant `poisoned` par run. Sur un
  // worktree réel du banc, status ne montrait que `?? .mcp.json` pendant que
  // `git show --name-only HEAD` listait bien la source ET le test. D'où
  // l'UNION : ce qui a été COMMITÉ depuis baseSha + ce qui reste dans l'ARBRE.
  let changed = worktreeChanges;
  if (baseSha) {
    const committed = await deps.exec("git", ["diff", "--name-only", baseSha, "HEAD"]);
    if (committed.code !== 0) {
      return {
        falsifiable: true,
        reason: "diff depuis la base indisponible — contrôle sauté",
        testFiles: [],
        sourceFiles: [],
      };
    }
    // NON SUIVIS PRÉEXISTANTS : hors périmètre, et il FAUT les exclure.
    // `.mcp.json` est déposé dans chaque worktree AVANT que l'agent travaille ;
    // le compter comme « fichier de production changé » le faisait entrer dans
    // la neutralisation à chaque tâche, avec le risque de perte décrit plus
    // haut. La base de comparaison n'est donc pas seulement un SHA : c'est le
    // SHA **plus** l'ensemble des non-suivis déjà là au départ.
    const before = new Set(baseUntracked ?? []);
    const appeared = parseUntrackedFiles(status.stdout).filter((f) => !before.has(f));
    changed = [
      ...new Set([...parseNameOnly(committed.stdout), ...parseTrackedChanges(status.stdout), ...appeared]),
    ];
  }

  const testFiles = changed.filter((f) => isTestFile(f, language));
  const sourceFiles = changed.filter((f) => !isTestFile(f, language));

  if (testFiles.length === 0) {
    return { falsifiable: false, reason: "aucun fichier de test modifié — rien ne prouve le défaut", testFiles, sourceFiles };
  }
  if (sourceFiles.length === 0) {
    // Un test seul, sans patch : c'est le cas « j'expose le bug sans le
    // corriger », parfaitement valide pour une phase de chasse.
    return { falsifiable: true, reason: "test ajouté sans patch de production", testFiles, sourceFiles };
  }

  // MESURE DE RÉFÉRENCE, patch en place. Sans elle, un lanceur qui ne démarre
  // pas — mauvaise commande pour ce dépôt, dépendance absente, config cassée —
  // sort non-zéro APRÈS la neutralisation et se lit comme « le test échoue sans
  // le patch » : le garde-fou accepte, en silence, exactement ce qu'il
  // surveille. Mesuré : sur un dépôt sans vitest, `pnpm exec vitest run`
  // produisait un faux ACCEPT sur un test dont le verdict correct était
  // « ne prouve rien ».
  const baseline = await deps.exec(testCommand.cmd, [...testCommand.args, ...testFiles]);
  if (baseline.code === -1) {
    // Le lanceur ne DÉMARRE pas (binaire introuvable, spawn error, tué par
    // signal) : on ne peut RIEN prouver. Refus EXPLICITE, PAS fail-open (#157) —
    // sur un dépôt sans lanceur, l'ancien `falsifiable: true` (« contrôle sauté »)
    // acceptait en silence TOUT DONE sans preuve. Le préflight le dit une fois au
    // lancement ; ici on refuse par tâche au cas où il aurait été sauté.
    return {
      falsifiable: false,
      reason: `le lanceur de tests ne démarre pas (${testCommand.cmd} introuvable ou non exécutable) — impossible de prouver le défaut`,
      testFiles,
      sourceFiles,
    };
  }
  if (baseline.code !== 0) {
    return {
      falsifiable: true,
      reason: `le lanceur de tests échoue déjà AVEC le patch (${testCommand.cmd}, code ${baseline.code}) — contrôle sauté`,
      testFiles,
      sourceFiles,
    };
  }

  const neutral = baseSha
    ? await neutralizeByReversePatch(deps, baseSha, sourceFiles, untracked)
    : await neutralizeByStash(deps, sourceFiles);
  if (!neutral.ok) {
    return { falsifiable: true, reason: neutral.reason, testFiles, sourceFiles };
  }

  try {
    const run = await deps.exec(testCommand.cmd, [...testCommand.args, ...testFiles]);
    if (run.code === 0) {
      return {
        falsifiable: false,
        reason: "le test passe SANS le patch — il ne démontre aucun défaut",
        testFiles,
        sourceFiles,
      };
    }
    return { falsifiable: true, reason: "le test échoue sans le patch", testFiles, sourceFiles };
  } finally {
    await neutral.restore();
  }
}
