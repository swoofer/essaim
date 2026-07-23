import { describe, it, expect } from "vitest";
import { verifyFixes, type VerifyItem } from "../../src/security/verify.js";
import { createRegistry } from "../../src/security/registry.js";
import type { EngineAdapter, EngineId, Finding } from "../../src/security/types.js";

function finding(fp: string): Finding {
  return {
    id: fp, engine: "strix", ruleId: "r", title: "t", description: "d", severity: "high",
    category: "sqli", file: "src/a.ts", fingerprint: fp, status: "fixed", discoveredAt: "t", raw: null,
  };
}

// Adapter whose re-scan returns findings with the given fingerprints.
function rescanAdapter(returnFingerprints: string[]): EngineAdapter {
  return {
    capabilities: { id: "strix", displayName: "s", modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "Apache-2.0" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run() {
      return {
        engine: "strix" as EngineId, status: returnFingerprints.length ? "vulns_found" : "no_vulns",
        findings: returnFingerprints.map(finding), startedAt: "t", finishedAt: "t", durationMs: 1,
      };
    },
  };
}

// Adapter whose re-scan errors out (degraded) — must NOT be trusted to prove closure.
function degradedAdapter(): EngineAdapter {
  return {
    capabilities: { id: "strix", displayName: "s", modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "Apache-2.0" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run() {
      return {
        engine: "strix" as EngineId, status: "error",
        findings: [], startedAt: "t", finishedAt: "t", durationMs: 1,
      };
    },
  };
}

describe("verifyFixes", () => {
  const existsTrue = { existsFn: () => true };

  it("marks a finding VERIFIED when the re-scan no longer detects its fingerprint", async () => {
    const reg = createRegistry();
    reg.register(rescanAdapter([])); // clean re-scan
    const items: VerifyItem[] = [{ finding: finding("fp1"), worktreePath: "/wt/a", threadId: "t-1", engineId: "strix", scanMode: "quick" }];
    const res = await verifyFixes(reg, items, new AbortController().signal, existsTrue);
    expect(res).toEqual([{ threadId: "t-1", fingerprint: "fp1", status: "verified" }]);
  });

  it("marks a finding REOPENED when the re-scan still detects its fingerprint", async () => {
    const reg = createRegistry();
    reg.register(rescanAdapter(["fp1"])); // still there
    const items: VerifyItem[] = [{ finding: finding("fp1"), worktreePath: "/wt/a", threadId: "t-1", engineId: "strix", scanMode: "quick" }];
    const res = await verifyFixes(reg, items, new AbortController().signal, existsTrue);
    expect(res[0].status).toBe("reopened");
  });

  it("marks REOPENED (conservative) when the worktree is gone (e.g. --cleanup)", async () => {
    const reg = createRegistry();
    reg.register(rescanAdapter([])); // even a clean adapter cannot save a missing worktree
    const items: VerifyItem[] = [{ finding: finding("fp1"), worktreePath: "/gone", threadId: "t-1", engineId: "strix", scanMode: "quick" }];
    const res = await verifyFixes(reg, items, new AbortController().signal, { existsFn: () => false });
    expect(res[0].status).toBe("reopened");
  });

  it("re-scan that DEGRADES (engine error) → reopened, not a false verified", async () => {
    const reg = createRegistry();
    reg.register(degradedAdapter()); // adapter run() returns status: "error", findings: []
    const items: VerifyItem[] = [{ finding: finding("fp1"), worktreePath: "/wt/a", threadId: "t-1", engineId: "strix", scanMode: "quick" }];
    const res = await verifyFixes(reg, items, new AbortController().signal, { existsFn: () => true });
    expect(res[0].status).toBe("reopened");
  });
});
