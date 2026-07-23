import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHaltRequested, sweepOrphanContainers } from "../../src/security/killswitch.js";
import type { SpawnFn } from "../../src/security/adapters/base.js";

afterEach(() => {
  delete process.env.ESSAIM_SECURITY_HALT;
});

describe("isHaltRequested", () => {
  it("false when neither the STOP file nor the env flag is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-"));
    expect(isHaltRequested(dir)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  it("true when ESSAIM_SECURITY_HALT=1", () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-"));
    process.env.ESSAIM_SECURITY_HALT = "1";
    expect(isHaltRequested(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
  it("true when reports/security/STOP exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "halt-"));
    mkdirSync(join(dir, "reports", "security"), { recursive: true });
    writeFileSync(join(dir, "reports", "security", "STOP"), "");
    expect(isHaltRequested(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sweepOrphanContainers", () => {
  // ps child prints one container id; kill child closes cleanly.
  function spawnFor(psOutput: string, capture: string[][]): SpawnFn {
    return ((_cmd: string, args: string[]) => {
      capture.push(args);
      const child: any = {
        stdout: { on: (_e: "data", cb: (c: string) => void) => { if (args[0] === "ps") setTimeout(() => cb(psOutput), 0); } },
        stderr: { on: () => {} },
        kill: () => {},
        on: (ev: string, cb: (code: number | null) => void) => { if (ev === "close") setTimeout(() => cb(0), 1); },
      };
      return child;
    }) as unknown as SpawnFn;
  }

  it("kills each surviving essaim-security-<runId> container and returns the count", async () => {
    const calls: string[][] = [];
    const n = await sweepOrphanContainers("run-1", { spawnFn: spawnFor("abc123\n", calls) });
    expect(n).toBe(1);
    expect(calls[0]).toEqual(expect.arrayContaining(["ps", "-q"]));
    expect(calls.some((a) => a[0] === "kill" && a.includes("abc123"))).toBe(true);
  });

  it("returns 0 when nothing is running (no kill)", async () => {
    const calls: string[][] = [];
    const n = await sweepOrphanContainers("run-1", { spawnFn: spawnFor("\n", calls) });
    expect(n).toBe(0);
    expect(calls.some((a) => a[0] === "kill")).toBe(false);
  });
});
