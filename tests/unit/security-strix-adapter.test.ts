import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStrixAdapter, STRIX_CAPABILITIES } from "../../src/security/adapters/strix.js";
import type { SpawnFn } from "../../src/security/adapters/base.js";
import type { ResolvedScope } from "../../src/security/types.js";

const fx = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "security", name), "utf8");

const scope: ResolvedScope = { targetPath: "C:/repo", mode: "diff", scanMode: "quick", diffBase: "abc123", excludeMatchers: [] };

interface Invocation {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: Record<string, string | undefined> };
}

/** Build a SpawnFn that dispatches on (command, args) so `strix --version`, `strix -n …`, and
 *  `docker info` can each be scripted independently. Records every invocation. */
function makeSpawn(
  handlers: {
    match: (cmd: string, args: string[]) => boolean;
    stdout?: string;
    code?: number | null;
    hang?: boolean; // never closes on its own — only via kill()
  }[],
  invocations: Invocation[] = [],
): SpawnFn {
  return ((cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }) => {
    invocations.push({ cmd, args, opts });
    const handler = handlers.find((h) => h.match(cmd, args));
    const stdout = handler?.stdout ?? "";
    const code = handler?.code ?? 0;
    const hang = handler?.hang ?? false;

    let closeCb: ((code: number | null) => void) | null = null;
    const child = {
      stdout: { on: (_e: "data", cb: (c: string) => void) => setTimeout(() => cb(stdout), 0) },
      stderr: { on: () => {} },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        if (ev === "close") {
          closeCb = cb as (code: number | null) => void;
          if (!hang) setTimeout(() => cb(code), 5);
        }
      },
      kill: () => {
        if (hang && closeCb) closeCb(null);
      },
    };
    return child as unknown as ReturnType<SpawnFn>;
  }) as unknown as SpawnFn;
}

const okVersion = { match: (cmd: string, args: string[]) => cmd === "strix" && args[0] === "--version", code: 0 };
const okDockerInfo = { match: (cmd: string) => cmd === "docker", code: 0 };

describe("STRIX_CAPABILITIES", () => {
  it("declares Apache-2.0, static, process transport", () => {
    expect(STRIX_CAPABILITIES.license).toBe("Apache-2.0");
    expect(STRIX_CAPABILITIES.requiresRunningTarget).toBe(false);
    expect(STRIX_CAPABILITIES.transport).toBe("process");
  });
});

describe("StrixAdapter.healthCheck", () => {
  it("strix + docker both present → ok:true", async () => {
    const spawnFn = makeSpawn([okVersion, okDockerInfo]);
    const a = createStrixAdapter({ runId: "r1", spawnFn });
    const res = await a.healthCheck();
    expect(res.ok).toBe(true);
    expect(res.detail).toContain("strix cli ok");
    expect(res.detail).toContain("docker ok");
  });

  it("strix --version non-zero → ok:false, mentions pip install strix-agent", async () => {
    const spawnFn = makeSpawn([{ match: (cmd, args) => cmd === "strix" && args[0] === "--version", code: 1 }]);
    const a = createStrixAdapter({ runId: "r1", spawnFn });
    const res = await a.healthCheck();
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("pip install strix-agent");
  });

  it("docker info non-zero → ok:false, mentions Docker", async () => {
    const spawnFn = makeSpawn([okVersion, { match: (cmd) => cmd === "docker", code: 1 }]);
    const a = createStrixAdapter({ runId: "r1", spawnFn });
    const res = await a.healthCheck();
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("Docker");
  });
});

describe("StrixAdapter.run — exit-code mapping", () => {
  it("exit 0 → no_vulns, no findings", async () => {
    const spawnFn = makeSpawn([{ match: (cmd, args) => cmd === "strix" && args[0] === "-n", code: 0, stdout: "clean" }]);
    const a = createStrixAdapter({ runId: "r1", spawnFn, makeWorkdir: () => "/fake", cleanup: () => {} });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("no_vulns");
    expect(res.findings).toHaveLength(0);
    expect(res.exitCode).toBe(0);
  });

  it("exit 2, artifacts readable → vulns_found, reconciled findings", async () => {
    const invocations: Invocation[] = [];
    const spawnFn = makeSpawn(
      [{ match: (cmd, args) => cmd === "strix" && args[0] === "-n", code: 2, stdout: "vulns found" }],
      invocations,
    );
    const a = createStrixAdapter({
      runId: "r1",
      spawnFn,
      makeWorkdir: () => "/fake",
      cleanup: () => {},
      readRun: () => ({ vulnJson: fx("strix-vulnerabilities.json"), sarif: fx("strix-findings.sarif") }),
    });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("vulns_found");
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0].engine).toBe("strix");
    // reconciliation: a json finding's file/line survives (already present in json, SARIF backfill n/a here)
    expect(res.findings.some((f) => f.file === "src/db/users.ts" && f.line === 42)).toBe(true);

    // argv carried the diff scope (via strixCliArgs)
    const runInvocation = invocations.find((i) => i.cmd === "strix" && i.args[0] === "-n");
    expect(runInvocation?.args).toEqual(expect.arrayContaining(["--diff-base", "abc123"]));
  });

  it("exit 2 but readRun returns {} (no artifacts) → error (zero-reads guard), NOT no_vulns", async () => {
    const spawnFn = makeSpawn([{ match: (cmd, args) => cmd === "strix" && args[0] === "-n", code: 2, stdout: "vulns found" }]);
    const a = createStrixAdapter({
      runId: "r1",
      spawnFn,
      makeWorkdir: () => "/fake",
      cleanup: () => {},
      readRun: () => ({}),
    });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
    expect(res.status).not.toBe("no_vulns");
  });

  it("exit 2 with vulnJson parsing to an empty array → error", async () => {
    const spawnFn = makeSpawn([{ match: (cmd, args) => cmd === "strix" && args[0] === "-n", code: 2, stdout: "vulns found" }]);
    const a = createStrixAdapter({
      runId: "r1",
      spawnFn,
      makeWorkdir: () => "/fake",
      cleanup: () => {},
      readRun: () => ({ vulnJson: "[]" }),
    });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
  });

  it("exit 1 → error", async () => {
    const spawnFn = makeSpawn([{ match: (cmd, args) => cmd === "strix" && args[0] === "-n", code: 1, stdout: "boom" }]);
    const a = createStrixAdapter({ runId: "r1", spawnFn, makeWorkdir: () => "/fake", cleanup: () => {} });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
    expect(res.error?.kind).toBe("crash");
  });

  it("stdoutExcerpt is redacted", async () => {
    const spawnFn = makeSpawn([
      { match: (cmd, args) => cmd === "strix" && args[0] === "-n", code: 2, stdout: "leaked sk-abcDEF0123456789ghijklmnop" },
    ]);
    const a = createStrixAdapter({
      runId: "r1",
      spawnFn,
      makeWorkdir: () => "/fake",
      cleanup: () => {},
      readRun: () => ({ vulnJson: fx("strix-vulnerabilities.json") }),
    });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.stdoutExcerpt ?? "").not.toContain("sk-abcDEF0123456789ghijklmnop");
  });

  it("passes secrets into the child env, never into argv", async () => {
    const invocations: Invocation[] = [];
    const spawnFn = makeSpawn([{ match: (cmd, args) => cmd === "strix" && args[0] === "-n", code: 0 }], invocations);
    const a = createStrixAdapter({
      runId: "r1",
      spawnFn,
      makeWorkdir: () => "/fake",
      cleanup: () => {},
      secrets: { STRIX_LLM: "anthropic/claude-sonnet-4-6", LLM_API_KEY: "sk-secret-value" },
    });
    await a.run(scope, new AbortController().signal);
    const runInvocation = invocations.find((i) => i.cmd === "strix" && i.args[0] === "-n");
    expect(runInvocation?.args.join(" ")).not.toContain("sk-secret-value");
    expect(runInvocation?.opts.env?.STRIX_LLM).toBe("anthropic/claude-sonnet-4-6");
    expect(runInvocation?.opts.env?.LLM_API_KEY).toBe("sk-secret-value");
  });

  it("abort → status timeout", async () => {
    const spawnFn = makeSpawn([{ match: (cmd, args) => cmd === "strix" && args[0] === "-n", hang: true }]);
    const ac = new AbortController();
    const a = createStrixAdapter({ runId: "r1", spawnFn, makeWorkdir: () => "/fake", cleanup: () => {} });
    const p = a.run(scope, ac.signal);
    setTimeout(() => ac.abort(), 5);
    const res = await p;
    expect(res.status).toBe("timeout");
  });
});
