import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createStrixAdapter, STRIX_CAPABILITIES } from "../../src/security/adapters/strix.js";
import type { SpawnFn } from "../../src/security/adapters/base.js";
import type { ResolvedScope } from "../../src/security/types.js";

const fx = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "security", name), "utf8");

const scope: ResolvedScope = { targetPath: "C:/repo", mode: "diff", scanMode: "quick", diffBase: "abc123", excludeMatchers: [] };

// Build a SpawnFn that emits the given stdout + exit code, and records argv.
function scriptedSpawn(stdout: string, code: number, capture?: { args?: string[] }): SpawnFn {
  return ((_cmd: string, args: string[]) => {
    if (capture) capture.args = args;
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const stream = { on: (_e: "data", cb: (c: string) => void) => setTimeout(() => cb(stdout), 0) };
    return {
      stdout: stream,
      stderr: { on: () => {} },
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        (listeners[ev] ??= []).push(cb);
        if (ev === "close") setTimeout(() => cb(code), 5);
      },
      kill: () => {},
    };
  }) as unknown as SpawnFn;
}

describe("STRIX_CAPABILITIES", () => {
  it("declares Apache-2.0, static, process transport", () => {
    expect(STRIX_CAPABILITIES.license).toBe("Apache-2.0");
    expect(STRIX_CAPABILITIES.requiresRunningTarget).toBe(false);
    expect(STRIX_CAPABILITIES.transport).toBe("process");
  });
});

describe("StrixAdapter.healthCheck — placeholder digest guard", () => {
  it("refuses with a clear message when using the default (placeholder-digest) image, without spawning docker", async () => {
    let spawnCalled = false;
    const spawnFn: SpawnFn = ((..._args: unknown[]) => {
      spawnCalled = true;
      throw new Error("docker should not be spawned when the digest is a placeholder");
    }) as unknown as SpawnFn;
    // No `image` override → adapter uses the default PINNED_STRIX_IMAGE (still PLACEHOLDER_DIGEST).
    const a = createStrixAdapter({ runId: "r1", spawnFn });
    const res = await a.healthCheck();
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("PLACEHOLDER_DIGEST");
    expect(res.detail).toContain("PINNED_STRIX_IMAGE");
    expect(spawnCalled).toBe(false);
  });
});

describe("StrixAdapter.run — exit-code mapping", () => {
  it("exit 0 → no_vulns, no findings", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn(fx("strix-clean.stdout.txt"), 0) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("no_vulns");
    expect(res.findings).toHaveLength(0);
    expect(res.exitCode).toBe(0);
  });

  it("exit 2 → vulns_found, findings parsed + normalized", async () => {
    const cap: { args?: string[] } = {};
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn(fx("strix-vulns.stdout.txt"), 2, cap) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("vulns_found");
    expect(res.findings).toHaveLength(2);
    expect(res.findings[0].engine).toBe("strix");
    // argv carried the diff scope
    expect(cap.args).toEqual(expect.arrayContaining(["--diff-base", "abc123"]));
  });

  it("exit 1 → error", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn("boom", 1) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
    expect(res.error?.kind).toBe("crash");
  });

  it("exit 2 but ZERO parseable findings from non-empty stdout → error (never false no_vulns)", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn("noise but no json", 2) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
  });

  it("exit 2 but a clean-parsed empty findings array → error (never a false no_vulns)", async () => {
    // strix-clean.stdout.txt parses to {"findings": []}; paired with exit 2 this must be an error, not no_vulns.
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn(fx("strix-clean.stdout.txt"), 2) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.status).toBe("error");
  });

  it("stdoutExcerpt is redacted", async () => {
    const a = createStrixAdapter({ runId: "r1", spawnFn: scriptedSpawn(fx("strix-vulns.stdout.txt"), 2) });
    const res = await a.run(scope, new AbortController().signal);
    expect(res.stdoutExcerpt ?? "").not.toContain("sk-abcDEF0123456789ghijklmnop");
  });

  it("abort → status timeout AND issues a docker kill of the tracked container", async () => {
    const invocations: string[][] = [];
    // run child: closes only when killed via the signal; kill child: closes immediately.
    const spawnFn: SpawnFn = ((_cmd: string, args: string[]) => {
      invocations.push(args);
      const child: any = { stdout: { on: () => {} }, stderr: { on: () => {} }, kill: () => {}, _close: null };
      child.on = (ev: string, cb: (code: number | null) => void) => { if (ev === "close") child._close = cb; };
      if (args[0] === "kill") {
        setTimeout(() => child._close && child._close(0), 0); // teardown closes immediately
      } else {
        child.kill = () => child._close && child._close(null); // run child closes only when killed
      }
      return child;
    }) as unknown as SpawnFn;

    const ac = new AbortController();
    const a = createStrixAdapter({ runId: "r1", spawnFn });
    const p = a.run(scope, ac.signal);
    setTimeout(() => ac.abort(), 5);
    const res = await p;
    expect(res.status).toBe("timeout");
    expect(invocations.some((args) => args[0] === "kill")).toBe(true); // docker kill happened
  });
});
