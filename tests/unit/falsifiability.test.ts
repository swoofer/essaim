import { describe, it, expect } from "vitest";
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
