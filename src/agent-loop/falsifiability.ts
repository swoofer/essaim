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
 * Le principe : remiser les fichiers NON-test modifiés, relancer les tests
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
}

export interface FalsifiabilityVerdict {
  /** true = le test échoue sans le patch, donc il prouve quelque chose. */
  falsifiable: boolean;
  reason: string;
  /** Fichiers de test détectés dans le diff. */
  testFiles: string[];
  /** Fichiers de production remisés le temps du contrôle. */
  sourceFiles: string[];
}

/** Un chemin de test au sens de vitest.config.ts : tests/ **.test.ts */
export function isTestFile(path: string): boolean {
  return /(^|\/)tests\/.*\.test\.(ts|js)$/.test(path.replace(/\\/g, "/"));
}

/** `git status --porcelain` → chemins modifiés ou ajoutés. */
export function parseChangedFiles(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * Rejoue les tests sans les modifications de production.
 *
 * Fail-open sur toute anomalie d'outillage (git indisponible, remise
 * impossible) : ce garde-fou doit attraper un test complaisant, pas bloquer
 * une tâche légitime parce que git a hoqueté. Le seul verdict négatif est
 * « le test passe sans le patch ».
 */
export async function verifyFailingTest(
  deps: FalsifiabilityDeps,
  testCommand: { cmd: string; args: string[] },
): Promise<FalsifiabilityVerdict> {
  // `--untracked-files=all` est obligatoire : sans lui, git REPLIE un
  // répertoire entièrement non suivi en une seule entrée (`?? tests/`) et le
  // fichier de test que l'agent vient d'écrire n'est jamais vu — le verdict
  // devient « aucun fichier de test » sur une tâche qui en a bien produit un.
  const status = await deps.exec("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) {
    return { falsifiable: true, reason: "git status indisponible — contrôle sauté", testFiles: [], sourceFiles: [] };
  }

  const changed = parseChangedFiles(status.stdout);
  const testFiles = changed.filter(isTestFile);
  const sourceFiles = changed.filter((f) => !isTestFile(f));

  if (testFiles.length === 0) {
    return { falsifiable: false, reason: "aucun fichier de test modifié — rien ne prouve le défaut", testFiles, sourceFiles };
  }
  if (sourceFiles.length === 0) {
    // Un test seul, sans patch : c'est le cas « j'expose le bug sans le
    // corriger », parfaitement valide pour une phase de chasse.
    return { falsifiable: true, reason: "test ajouté sans patch de production", testFiles, sourceFiles };
  }

  // `--include-untracked` : un patch qui CRÉE un fichier source ne serait pas
  // remisé sans lui, la remise échouerait, et le contrôle s'ouvrirait en grand
  // sur exactement le cas qu'il doit surveiller.
  const stash = await deps.exec("git", ["stash", "push", "--quiet", "--include-untracked", "--", ...sourceFiles]);
  if (stash.code !== 0) {
    return { falsifiable: true, reason: "remise impossible — contrôle sauté", testFiles, sourceFiles };
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
    const pop = await deps.exec("git", ["stash", "pop", "--quiet"]);
    if (pop.code !== 0) {
      // Laisser un worktree amputé de son patch serait pire que tout.
      log.error("git stash pop a échoué — le patch est resté remisé", { sourceFiles });
    }
  }
}
