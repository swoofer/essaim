import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  verifyFailingTest,
  isTestFile,
  parseChangedFiles,
  parseUntrackedFiles,
  type ExecResult,
} from "../../src/agent-loop/falsifiability.js";

/** Faux executeur : git n'est jamais appele pour de vrai. */
function fakeExec(responses: Record<string, ExecResult>) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      async exec(cmd: string, args: string[]): Promise<ExecResult> {
        const key = `${cmd} ${args[0] ?? ""}`;
        calls.push(`${cmd} ${args.join(" ")}`);
        return responses[key] ?? { code: 0, stdout: "" };
      },
    },
  };
}

const TEST_CMD = { cmd: "pnpm", args: ["exec", "vitest", "run"] };

describe("isTestFile", () => {
  it("reconnait un test vitest", () => {
    expect(isTestFile("tests/unit/foo.test.ts")).toBe(true);
    expect(isTestFile("tests\\unit\\foo.test.ts")).toBe(true);
  });
  it("rejette le code de production", () => {
    expect(isTestFile("src/security/ingest.ts")).toBe(false);
    expect(isTestFile("tests/fixtures/data.json")).toBe(false);
  });

  // #157 — dérivé du langage : sans ça, essaim ne marchait VRAIMENT que sur
  // essaim (le seul dépôt où le pattern vitest figé rendait true). Table de
  // chemins réels par langage.
  it("classe les tests selon le langage (#157)", () => {
    // Go — *_test.go
    expect(isTestFile("pkg/foo_test.go", "go")).toBe(true);
    expect(isTestFile("pkg/foo.go", "go")).toBe(false);
    // Python — test_*.py / *_test.py / tests/**
    expect(isTestFile("tests/test_foo.py", "python")).toBe(true);
    expect(isTestFile("app/foo_test.py", "python")).toBe(true);
    expect(isTestFile("app/foo.py", "python")).toBe(false);
    // Rust — tests/*.rs (les #[test] inline dans le source ne sont pas détectables par nom)
    expect(isTestFile("tests/integration.rs", "rust")).toBe(true);
    expect(isTestFile("src/lib.rs", "rust")).toBe(false);
    // Java — ANCRÉ sur src/test/, PAS un basename *Test : une classe de DOMAINE
    // de production finissant par Test (LabTest…) reste SOURCE, sinon faux vert.
    expect(isTestFile("src/test/java/FooTest.java", "java")).toBe(true);
    expect(isTestFile("src/main/java/Foo.java", "java")).toBe(false);
    expect(isTestFile("src/main/java/com/clinic/domain/LabTest.java", "java")).toBe(false);
    // TS/JS (défaut) — *.test.* / *.spec.* partout, plus le .e2e-spec de NestJS…
    expect(isTestFile("src/a.test.ts", "typescript")).toBe(true);
    expect(isTestFile("src/a.spec.tsx", "typescript")).toBe(true);
    expect(isTestFile("test/app.e2e-spec.ts", "typescript")).toBe(true);
    expect(isTestFile("src/a.ts", "typescript")).toBe(false);
    // …mais on n'ouvre PAS `-spec` en général : un fichier de production reste source.
    expect(isTestFile("src/openapi-spec.ts", "typescript")).toBe(false);
  });
});

describe("parseChangedFiles", () => {
  it("extrait les chemins du porcelain", () => {
    expect(parseChangedFiles(" M src/a.ts\n?? tests/unit/b.test.ts\n")).toEqual([
      "src/a.ts",
      "tests/unit/b.test.ts",
    ]);
  });
});

describe("verifyFailingTest", () => {
  it("refuse quand le test passe SANS le patch", async () => {
    const { deps } = fakeExec({
      "git status": { code: 0, stdout: " M src/security/ingest.ts\n M tests/unit/x.test.ts\n" },
      "git stash": { code: 0, stdout: "" },
      "pnpm exec": { code: 0, stdout: "all passed" },
    });
    const v = await verifyFailingTest(deps, TEST_CMD);
    expect(v.falsifiable).toBe(false);
    expect(v.reason).toContain("passe SANS le patch");
  });

  it("accepte quand le test echoue sans le patch", async () => {
    const { deps } = fakeExec({
      "git status": { code: 0, stdout: " M src/security/ingest.ts\n M tests/unit/x.test.ts\n" },
      "git stash": { code: 0, stdout: "" },
      "pnpm exec": { code: 1, stdout: "1 failed" },
    });
    const v = await verifyFailingTest(deps, TEST_CMD);
    expect(v.falsifiable).toBe(true);
  });

  it("refuse quand aucun test n'a ete modifie", async () => {
    const { deps } = fakeExec({
      "git status": { code: 0, stdout: " M src/security/ingest.ts\n" },
    });
    const v = await verifyFailingTest(deps, TEST_CMD);
    expect(v.falsifiable).toBe(false);
    expect(v.reason).toContain("aucun fichier de test");
  });

  it("accepte un test seul, sans patch", async () => {
    const { deps } = fakeExec({
      "git status": { code: 0, stdout: "?? tests/unit/x.test.ts\n" },
    });
    const v = await verifyFailingTest(deps, TEST_CMD);
    expect(v.falsifiable).toBe(true);
  });

  it("fail-open si git est indisponible", async () => {
    const { deps } = fakeExec({ "git status": { code: 128, stdout: "" } });
    const v = await verifyFailingTest(deps, TEST_CMD);
    expect(v.falsifiable).toBe(true);
  });

  it("n'accepte PAS quand le lanceur de tests ne démarre pas", async () => {
    // Le défaut le plus grave trouvé sur le terrain : la commande était codée
    // en dur à `pnpm exec vitest run`. Sur un dépôt sans vitest elle sortait
    // non-zéro APRÈS la remise, ce qui se lisait « le test échoue sans le
    // patch » — un ACCEPT silencieux sur exactement le cas surveillé.
    const { deps, calls } = fakeExec({
      "git status": { code: 0, stdout: " M src/a.ts\n M tests/unit/x.test.ts\n" },
      "pnpm exec": { code: 1, stdout: "vitest: not found" },
    });
    const v = await verifyFailingTest(deps, TEST_CMD);
    expect(v.reason).toContain("échoue déjà AVEC le patch");
    // Rien n'a été remisé : on abandonne AVANT de toucher au worktree.
    expect(calls.some((c) => c.startsWith("git stash push"))).toBe(false);
  });

  it("restaure toujours le patch remise", async () => {
    const { deps, calls } = fakeExec({
      "git status": { code: 0, stdout: " M src/a.ts\n M tests/unit/x.test.ts\n" },
      "git stash": { code: 0, stdout: "" },
      "pnpm exec": { code: 0, stdout: "" },
    });
    await verifyFailingTest(deps, TEST_CMD);
    expect(calls.some((c) => c.startsWith("git stash pop"))).toBe(true);
  });

  it("REFUSE (pas fail-open) quand le lanceur ne DÉMARRE pas — code -1, binaire absent (#157)", async () => {
    // Le fail-open acceptait TOUT DONE sur un dépôt sans lanceur (binaire
    // introuvable → spawn error → code -1). Désormais : refus EXPLICITE. Distinct
    // du cas « le lanceur tourne mais rend rouge » (code>0), qui reste fail-open.
    const { deps, calls } = fakeExec({
      "git status": { code: 0, stdout: " M src/a.ts\n M tests/unit/x.test.ts\n" },
      "pnpm exec": { code: -1, stdout: "spawn ENOENT" },
    });
    const v = await verifyFailingTest(deps, TEST_CMD);
    expect(v.falsifiable).toBe(false); // PAS le fail-open true
    expect(v.reason).toContain("ne démarre pas");
    // Refus AVANT de toucher au worktree — rien n'est remisé.
    expect(calls.some((c) => c.startsWith("git stash push"))).toBe(false);
  });
});

// ── Contre un VRAI dépôt git ───────────────────────────────────────────
//
// Les cas ci-dessus injectent l'exécuteur : ils valident la logique, jamais
// le dialogue avec git. Deux défauts sont passés à travers pour cette raison
// exacte, et seul un dépôt réel les a exposés :
//
//  1. `git status --porcelain` REPLIE un répertoire entièrement non suivi en
//     une entrée (`?? tests/`). Le test que l'agent venait d'écrire n'était
//     jamais vu → « aucun fichier de test » sur une tâche qui en produisait un.
//  2. `git stash push -- <fichier>` ÉCHOUE sur un fichier non suivi. Un patch
//     qui CRÉE un fichier source ouvrait le contrôle en grand.
//
// D'où ce test : il crée un fichier source ET un test tous deux NON SUIVIS,
// la combinaison qui déclenchait les deux.
describe("verifyFailingTest contre un vrai dépôt git", () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });

  const realExec = (cwd: string) => ({
    async exec(cmd: string, args: string[]): Promise<ExecResult> {
      const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
      return { code: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
    },
  });

  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "essaim-fals-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "base.js"), "export const a = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    // Le patch de l'agent : un fichier source neuf + un test, tous deux NON
    // SUIVIS, dans un répertoire tests/ qui n'existait pas.
    writeFileSync(join(repo, "newsrc.js"), "export const helper = () => 1;\n");
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "z.test.js"), "// complaisant\n");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("voit le test non suivi et refuse un test complaisant", async () => {
    // Sonde délibérément COMPLAISANTE : elle sort 0 quel que soit l'état du
    // worktree — exactement le test que le garde-fou doit refuser. Elle note
    // au passage ce qu'elle a vu, ce qui prouve que la remise a bien retiré
    // le fichier source sans faire dépendre la preuve du code de sortie
    // (la mesure de référence exige que la sonde passe AVEC le patch).
    const probe = {
      cmd: process.execPath,
      args: [
        "-e",
        "const fs=require('fs');" +
          "fs.appendFileSync('probe.log', fs.existsSync('newsrc.js')?'present\\n':'absent\\n');",
      ],
    };
    const v = await verifyFailingTest(realExec(repo), probe);

    expect(v.testFiles).toEqual(["tests/z.test.js"]);
    expect(v.sourceFiles).toEqual(["newsrc.js"]);
    expect(v.falsifiable).toBe(false);
    expect(v.reason).toContain("passe SANS le patch");

    // Référence patch en place, puis contrôle patch remisé : la sonde doit
    // avoir vu le fichier source disparaître entre les deux.
    const seen = readFileSync(join(repo, "probe.log"), "utf8").trim().split("\n");
    expect(seen).toEqual(["present", "absent"]);
  });

  it("restaure le patch non suivi et ne laisse aucune remise", async () => {
    await verifyFailingTest(realExec(repo), {
      cmd: process.execPath,
      args: ["-e", "process.exit(0)"],
    });

    expect(existsSync(join(repo, "newsrc.js"))).toBe(true);
    expect(existsSync(join(repo, "tests", "z.test.js"))).toBe(true);
    expect(git(repo, "stash", "list").stdout.trim()).toBe("");
  });
});

// ── Le défaut mesuré : l'agent COMMITE, le garde-fou regarde ailleurs ───
//
// 54 refus sur un banc de 6 runs, TOUS avec le même motif « aucun fichier de
// test modifié — rien ne prouve le défaut », et 3 des 4 vrais défauts finissant
// `poisoned` par run. Le garde-fou n'était pas trop strict, il était AVEUGLE :
// behaviors/phase-execute.yaml:56 ordonne « chaque tâche nécessite son PROPRE
// commit », falsifiability.ts:70 n'interrogeait que `git status` — l'arbre que
// le commit vient précisément de vider. Relevé sur un worktree réel du banc :
// `git status --porcelain --untracked-files=all` ne montrait que `?? .mcp.json`
// pendant que `git show --name-only HEAD` listait bien src ET tests.
describe("verifyFailingTest quand l'agent a COMMITÉ (arbre propre)", () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync("git", args, { cwd, encoding: "utf8" });

  const realExec = (cwd: string) => ({
    async exec(cmd: string, args: string[]): Promise<ExecResult> {
      const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
      return { code: r.status ?? -1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
    },
    // HORS du worktree : un patch déposé dedans se retrouverait dans le
    // `git status` du contrôle suivant, compté comme fichier source.
    async writeTemp(content: string): Promise<string> {
      const p = join(mkdtempSync(join(tmpdir(), "essaim-patch-")), "p.patch");
      writeFileSync(p, content);
      return p;
    },
  });

  let repo: string;
  let base: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "essaim-fals-commit-"));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "t@t");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "src.js"), "module.exports = 'buggy';\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "base");
    base = git(repo, "rev-parse", "HEAD").stdout.trim();
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  /** Ce que phase-execute EXIGE : patch + test, dans un commit, arbre vidé. */
  const commitPatchAndTest = () => {
    writeFileSync(join(repo, "src.js"), "module.exports = 'patched';\n");
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "a.test.js"), "// repro\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "fix(scanner): repro + patch");
  };

  /** Sonde HONNÊTE : elle échoue dès que le patch n'est plus là. */
  const honestProbe = {
    cmd: process.execPath,
    args: [
      "-e",
      "const fs=require('fs');" +
        "process.exit(fs.readFileSync('src.js','utf8').includes('patched')?0:1);",
    ],
  };

  it("voit le patch commité et accepte un test qui échoue sans lui", async () => {
    commitPatchAndTest();
    // L'arbre est propre : c'est tout ce que voyait le garde-fou.
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout.trim()).toBe("");

    const v = await verifyFailingTest(realExec(repo), honestProbe, base);

    expect(v.testFiles).toEqual(["tests/a.test.js"]);
    expect(v.sourceFiles).toEqual(["src.js"]);
    expect(v.falsifiable).toBe(true);
    expect(v.reason).toContain("échoue sans le patch");
  });

  it("refuse un test complaisant commité, et rend le worktree intact", async () => {
    commitPatchAndTest();
    // Sonde COMPLAISANTE : elle sort 0 quel que soit l'état du worktree.
    const v = await verifyFailingTest(
      realExec(repo),
      { cmd: process.execPath, args: ["-e", "process.exit(0)"] },
      base,
    );

    expect(v.falsifiable).toBe(false);
    expect(v.reason).toContain("passe SANS le patch");
    // Ne JAMAIS laisser un worktree amputé de son patch.
    expect(readFileSync(join(repo, "src.js"), "utf8")).toContain("patched");
    expect(git(repo, "stash", "list").stdout.trim()).toBe("");
  });

  it("neutralise aussi un fichier source NON SUIVI quand le test est commité", async () => {
    // Mixte : le test part au commit, le patch reste un fichier neuf non suivi.
    // `git diff` ignore les non-suivis — sans traitement explicite, le patch
    // serait invisible et le contrôle s'ouvrirait en grand.
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "b.test.js"), "// repro\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "test only");
    writeFileSync(join(repo, "newsrc.js"), "module.exports = 1;\n");

    const v = await verifyFailingTest(
      realExec(repo),
      {
        cmd: process.execPath,
        args: ["-e", "process.exit(require('fs').existsSync('newsrc.js')?0:1);"],
      },
      base,
    );

    // CONTRAT CHANGÉ, et c'est délibéré. La rédaction précédente faisait entrer
    // ce fichier non suivi dans le patch via `git add --intent-to-add` pour que
    // la neutralisation le supprime. Mesuré : ça mettait AUSSI `.mcp.json` — non
    // suivi dans tous les worktrees d'agent — dans le « patch de production »,
    // et comme la restauration est un `git apply` unique donc ATOMIQUE, un
    // artefact recréé par le lancement des tests faisait échouer le patch
    // ENTIER : le correctif de l'agent disparaissait pendant que la tâche
    // partait en completeTask. On préfère désormais ne rien conclure.
    expect(v.sourceFiles).toEqual(["newsrc.js"]);
    expect(v.falsifiable).toBe(true);
    expect(v.reason).toContain("non suivi");
    expect(v.reason).not.toContain("passe SANS le patch");
    // Et surtout : le fichier de l'agent n'a pas bougé d'un octet.
    expect(existsSync(join(repo, "newsrc.js"))).toBe(true);
    expect(git(repo, "status", "--porcelain", "--untracked-files=all").stdout).toContain("?? newsrc.js");
  });

  // RÉGRESSION — le garde-fou ne doit JAMAIS faire perdre le correctif.
  //
  // La première rédaction du patch inverse faisait entrer tout fichier NON
  // SUIVI non-test dans le « patch de production » via `git add
  // --intent-to-add`, pour que la neutralisation le supprime. Or `.mcp.json`
  // est non suivi dans TOUS les worktrees d'agent (promptweave l'y dépose à la
  // création), et la restauration est un `git apply` unique, donc ATOMIQUE :
  // il suffisait que le lancement des tests recrée l'artefact pour que git
  // refuse le patch ENTIER (« already exists in working directory ») et que le
  // correctif de l'agent disparaisse — pendant que le verdict restait
  // `falsifiable: true` et que la tâche partait en completeTask.
  //
  // La base de comparaison n'est donc pas un simple SHA : c'est le SHA PLUS
  // l'inventaire des non-suivis déjà présents. Ce test échoue si on le retire.
  it("ne touche pas à un artefact non suivi préexistant, et garde le patch intact", async () => {
    const mcp = join(repo, ".mcp.json");
    writeFileSync(mcp, "{}\n");
    const baseUntracked = parseUntrackedFiles(
      git(repo, "status", "--porcelain", "--untracked-files=all").stdout,
    );
    expect(baseUntracked).toContain(".mcp.json");

    // L'agent corrige la source ET écrit le test, puis COMMITE LES DEUX —
    // nommément, sans `git add -A` : dans les vrais worktrees du banc,
    // `.mcp.json` est resté NON SUIVI (`?? .mcp.json` dans status).
    writeFileSync(join(repo, "src.js"), "module.exports = 'patched';\n");
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "a.test.js"), "// repro\n");
    git(repo, "add", "--", "src.js", "tests/a.test.js");
    git(repo, "commit", "-qm", "fix + test");

    // Lanceur : recrée l'artefact (le cas qui faisait échouer la restauration
    // atomique), puis échoue si le patch est absent — un vrai test de régression.
    const runner = {
      cmd: process.execPath,
      args: [
        "-e",
        `const fs=require("fs");fs.writeFileSync(${JSON.stringify(mcp)},"{}");`
          + `process.exit(fs.readFileSync(${JSON.stringify(join(repo, "src.js"))},"utf8").includes("patched")?0:1)`,
      ],
    };

    const v = await verifyFailingTest(realExec(repo), runner, base, baseUntracked);

    expect(v.falsifiable).toBe(true);
    expect(v.sourceFiles).not.toContain(".mcp.json");
    // LE POINT DU TEST : le correctif de l'agent est toujours là.
    expect(readFileSync(join(repo, "src.js"), "utf8")).toContain("patched");
  });
});

// ── Second étage : une neutralisation sans effet ne doit RIEN conclure ──
//
// Réparer la base de diff sans réparer la neutralisation aurait été PIRE que le
// défaut d'origine : `git stash push` sur des chemins propres-parce-que-commités
// sort 0 SANS RIEN REMISER (vérifié sur un dépôt jetable), le test était alors
// rejoué AVEC le patch encore en place, il passait, et le garde-fou concluait
// « le test passe SANS le patch ». 54 refus muets seraient devenus 54 refus
// MENSONGERS. D'où ce contrôle de l'effet de la neutralisation.
describe("verifyFailingTest — garde-fou du garde-fou", () => {
  /** Faux exécuteur qui matche la ligne de commande COMPLÈTE. */
  function scriptedExec(reply: (line: string) => ExecResult | undefined) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        async exec(cmd: string, args: string[]): Promise<ExecResult> {
          const line = `${cmd} ${args.join(" ")}`;
          calls.push(line);
          return reply(line) ?? { code: 0, stdout: "" };
        },
        async writeTemp(_content: string): Promise<string> {
          return "/tmp/essaim.patch";
        },
      },
    };
  }

  it("fail-open explicite quand la neutralisation n'a rien changé", async () => {
    const { deps } = scriptedExec((line) => {
      if (line.startsWith("git status")) return { code: 0, stdout: "" }; // arbre propre
      if (line === "git diff --name-only BASE HEAD") return { code: 0, stdout: "src/a.ts\ntests/unit/x.test.ts\n" };
      if (line === "git diff --binary BASE -- src/a.ts") return { code: 0, stdout: "--- a/src/a.ts\n+++ b/src/a.ts\n" };
      if (line.startsWith("git apply -R")) return { code: 0, stdout: "" }; // ment : sort 0 sans agir
      // Le contrôle d'effet : le fichier est TOUJOURS modifié après « neutralisation ».
      if (line === "git diff --name-only BASE -- src/a.ts") return { code: 0, stdout: "src/a.ts\n" };
      return { code: 0, stdout: "" }; // le lanceur de tests passe, patch en place
    });

    const v = await verifyFailingTest(deps, TEST_CMD, "BASE");

    // Le seul verdict négatif légitime est « test complaisant ». Ici on ne sait
    // rien : il faut le dire, pas accuser.
    expect(v.falsifiable).toBe(true);
    expect(v.reason).toContain("sans effet");
    expect(v.reason).not.toContain("passe SANS le patch");
  });

});
