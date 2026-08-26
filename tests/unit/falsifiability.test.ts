import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  verifyFailingTest,
  isTestFile,
  parseChangedFiles,
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

  it("restaure toujours le patch remise", async () => {
    const { deps, calls } = fakeExec({
      "git status": { code: 0, stdout: " M src/a.ts\n M tests/unit/x.test.ts\n" },
      "git stash": { code: 0, stdout: "" },
      "pnpm exec": { code: 0, stdout: "" },
    });
    await verifyFailingTest(deps, TEST_CMD);
    expect(calls.some((c) => c.startsWith("git stash pop"))).toBe(true);
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
    // « Le test » sort 0 tant que le patch est absent du worktree — donc il
    // ne sort 0 QUE si la remise a réellement retiré newsrc.js. Un verdict
    // négatif prouve d'un coup que le fichier de test a été vu ET remisé.
    const probe = {
      cmd: process.execPath,
      args: ["-e", "process.exit(require('fs').existsSync('newsrc.js') ? 1 : 0)"],
    };
    const v = await verifyFailingTest(realExec(repo), probe);

    expect(v.testFiles).toEqual(["tests/z.test.js"]);
    expect(v.sourceFiles).toEqual(["newsrc.js"]);
    expect(v.falsifiable).toBe(false);
    expect(v.reason).toContain("passe SANS le patch");
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
