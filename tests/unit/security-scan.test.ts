import { describe, it, expect } from "vitest";
import { runSecurityScan } from "../../src/security/scan.js";
import { createRegistry } from "../../src/security/registry.js";
import type { EngineAdapter, EngineId, ResolvedScope, Finding } from "../../src/security/types.js";

const scope: ResolvedScope = { targetPath: "/repo", mode: "full", scanMode: "quick", excludeMatchers: [] };

function finding(id: string): Finding {
  return {
    id, engine: "strix", ruleId: "r", title: "t", description: "d", severity: "high",
    category: "sqli", file: "src/a.ts", fingerprint: id, status: "new", discoveredAt: "t", raw: null,
  };
}

function adapter(id: string, res: Partial<import("../../src/security/types.js").EngineRunResult>): EngineAdapter {
  return {
    capabilities: { id: id as EngineId, displayName: id, modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "MIT" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run() {
      return { engine: id as EngineId, status: "no_vulns", findings: [], startedAt: "t", finishedAt: "t", durationMs: 1, ...res };
    },
  };
}

describe("runSecurityScan", () => {
  it("collects findings from a successful engine, degraded=false", async () => {
    const reg = createRegistry();
    reg.register(adapter("strix", { status: "vulns_found", findings: [finding("a"), finding("b")] }));
    const out = await runSecurityScan(reg, ["strix"] as EngineId[], scope, new AbortController().signal);
    expect(out.findings).toHaveLength(2);
    expect(out.degraded).toBe(false);
    expect(out.results[0].status).toBe("vulns_found");
  });

  it("sets degraded=true when any engine errors, keeping partial findings", async () => {
    const reg = createRegistry();
    reg.register(adapter("strix", { status: "partial", findings: [finding("a")], error: { kind: "crash", message: "x", retriable: true } }));
    const out = await runSecurityScan(reg, ["strix"] as EngineId[], scope, new AbortController().signal);
    expect(out.findings).toHaveLength(1);
    expect(out.degraded).toBe(true);
  });

  it("degraded=true and no throw when an adapter's run() itself rejects", async () => {
    const reg = createRegistry();
    const throwing = adapter("strix", {});
    throwing.run = async () => {
      throw new Error("unexpected");
    };
    reg.register(throwing);
    const out = await runSecurityScan(reg, ["strix"] as EngineId[], scope, new AbortController().signal);
    expect(out.degraded).toBe(true);
    expect(out.findings).toHaveLength(0);
  });
});
