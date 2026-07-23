import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecurityPrePhase, runSecurityVerifyPhase, buildVerifyItems } from "../../src/security/pre-phase.js";
import { createRegistry } from "../../src/security/registry.js";
import { syntheticAuthorId } from "../../src/security/ingest.js";
import type { EngineAdapter, EngineId, Finding, MiniProjectSecurity } from "../../src/security/types.js";
import { DEFAULT_SECURITY_CONFIG } from "../../src/security/config.js";

function finding(fp: string, file = "src/a.ts"): Finding {
  return {
    id: fp, engine: "strix", ruleId: "r", title: "t", description: "d", severity: "high",
    category: "sqli", file, fingerprint: fp, status: "new", discoveredAt: "t", raw: null,
  };
}

function fakeRegistry(findings: Finding[]) {
  const reg = createRegistry();
  const a: EngineAdapter = {
    capabilities: { id: "strix", displayName: "s", modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "Apache-2.0" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run() {
      return { engine: "strix" as EngineId, status: findings.length ? "vulns_found" : "no_vulns", findings, startedAt: "t", finishedAt: "t", durationMs: 5, exitCode: findings.length ? 2 : 0 };
    },
  };
  reg.register(a);
  return reg;
}

afterEach(() => vi.unstubAllGlobals());

describe("runSecurityPrePhase", () => {
  it("scans, ingests, and returns a ledger + posted map", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/register")) return { ok: true, json: async () => ({}) };
      if (url.includes("/api/threads-active")) return { ok: true, json: async () => [] }; // pool clean
      return { ok: true, json: async () => ({ thread_id: "t-1", status: "open" }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: true, authorized_by: "test" }, scope: { mode: "diff", diff_base: "HEAD~1", exclude_paths: [] } },
    };
    const res = await runSecurityPrePhase(
      { coordinatorUrl: "http://127.0.0.1:3100", runId: "run-1", projectPath: dir, baseSha: "abc", security },
      { registry: fakeRegistry([finding("fp1")]), halt: () => false, sweep: async () => undefined },
    );

    expect(res.ledger.engine).toBe("strix");
    expect(res.ledger.ingested).toBe(1);
    expect(res.ledger.findingsBySeverity.high).toBe(1);
    expect(res.postedMap).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("REFUSES to seed when the coordinator pool-purity query fails (fail-closed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/register")) return { ok: true, json: async () => ({}) };
      if (url.includes("/api/threads-active")) return { ok: false, status: 500 }; // query fails
      return { ok: true, json: async () => ({ thread_id: "t-1", status: "open" }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: true, authorized_by: "test" }, scope: { mode: "diff", diff_base: "HEAD~1", exclude_paths: [] } },
    };
    await expect(
      runSecurityPrePhase(
        { coordinatorUrl: "http://127.0.0.1:3100", runId: "run-1", projectPath: dir, baseSha: "abc", security },
        { registry: fakeRegistry([finding("fp1")]), halt: () => false, sweep: async () => undefined },
      ),
    ).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses (throws) when authorization is not affirmed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: false, authorized_by: "" } },
    };
    await expect(
      runSecurityPrePhase({ coordinatorUrl: "http://127.0.0.1:3100", runId: "r", projectPath: dir, baseSha: "abc", security }, { registry: fakeRegistry([]) }),
    ).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("REFUSES to seed when coordinatorUrl is not loopback (env-fallback bypass guard, decision #3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    // No fetch stub needed — the loopback guard must throw before any seeding POST is made.
    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: true, authorized_by: "test" }, scope: { mode: "diff", diff_base: "HEAD~1", exclude_paths: [] } },
    };
    await expect(
      runSecurityPrePhase(
        { coordinatorUrl: "http://prod.example.com:3100", runId: "run-1", projectPath: dir, baseSha: "abc", security },
        { registry: fakeRegistry([finding("fp1")]), halt: () => false, sweep: async () => undefined },
      ),
    ).rejects.toThrow(/loopback/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("REJECTS the purity check when the pool contains a foreign (non-self) thread", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/register")) return { ok: true, json: async () => ({}) };
      if (url.includes("/api/threads-active")) return { ok: true, json: async () => [{ initiator_id: "someone-else" }] };
      return { ok: true, json: async () => ({ thread_id: "t-1", status: "open" }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: true, authorized_by: "test" }, scope: { mode: "diff", diff_base: "HEAD~1", exclude_paths: [] } },
    };
    await expect(
      runSecurityPrePhase(
        { coordinatorUrl: "http://127.0.0.1:3100", runId: "run-1", projectPath: dir, baseSha: "abc", security },
        { registry: fakeRegistry([finding("fp1")]), halt: () => false, sweep: async () => undefined },
      ),
    ).rejects.toThrow(/pool is not clean/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does NOT reject the purity check when the only thread belongs to the synthetic author (self-allow)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prephase-"));
    const authorId = syntheticAuthorId(dir);
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/api/register")) return { ok: true, json: async () => ({}) };
      if (url.includes("/api/threads-active")) return { ok: true, json: async () => [{ initiator_id: authorId }] };
      return { ok: true, json: async () => ({ thread_id: "t-1", status: "open" }) };
    });
    vi.stubGlobal("fetch", mockFetch);

    const security: MiniProjectSecurity = {
      config: { ...DEFAULT_SECURITY_CONFIG, authorization: { affirmed: true, authorized_by: "test" }, scope: { mode: "diff", diff_base: "HEAD~1", exclude_paths: [] } },
    };
    const res = await runSecurityPrePhase(
      { coordinatorUrl: "http://127.0.0.1:3100", runId: "run-1", projectPath: dir, baseSha: "abc", security },
      { registry: fakeRegistry([finding("fp1")]), halt: () => false, sweep: async () => undefined },
    );
    expect(res.postedMap).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("buildVerifyItems (git-diff mapping)", () => {
  it("maps each posted finding to the worktree whose diff touched its file", () => {
    const postedMap = [
      { threadId: "t-1", finding: finding("fp1", "src/a.ts") },
      { threadId: "t-2", finding: finding("fp2", "src/b.ts") },
    ];
    const workspacePaths = new Map([["agentA", "/wt/a"], ["agentB", "/wt/b"]]);
    const diffFn = (worktree: string) => (worktree === "/wt/a" ? ["src/a.ts"] : ["src/b.ts"]);
    const items = buildVerifyItems({ postedMap, workspacePaths, baseSha: "abc", engineId: "strix", scanMode: "quick" }, { diffFn });
    expect(items).toHaveLength(2);
    expect(items.find((i) => i.finding.fingerprint === "fp1")?.worktreePath).toBe("/wt/a");
    expect(items.find((i) => i.finding.fingerprint === "fp2")?.worktreePath).toBe("/wt/b");
  });

  it("omits a finding no worktree touched (nobody fixed it)", () => {
    const postedMap = [{ threadId: "t-1", finding: finding("fp1", "src/a.ts") }];
    const workspacePaths = new Map([["agentA", "/wt/a"]]);
    const diffFn = () => ["src/other.ts"];
    const items = buildVerifyItems({ postedMap, workspacePaths, baseSha: "abc", engineId: "strix", scanMode: "quick" }, { diffFn });
    expect(items).toHaveLength(0);
  });
});

/** Fake registry whose `run()` returns findings keyed by the scanned worktree path (scope.targetPath),
 *  so a per-worktree re-scan outcome (still-vulnerable vs. fixed) can be controlled per test. */
function pathKeyedRegistry(byPath: Record<string, Finding[]>) {
  const reg = createRegistry();
  const a: EngineAdapter = {
    capabilities: { id: "strix", displayName: "s", modes: ["sast"], requiresRunningTarget: false, supportsDiffScope: true, transport: "process", license: "Apache-2.0" },
    async healthCheck() { return { ok: true, detail: "" }; },
    async run(scope) {
      const findings = byPath[scope.targetPath] ?? [];
      return { engine: "strix" as EngineId, status: findings.length ? "vulns_found" : "no_vulns", findings, startedAt: "t", finishedAt: "t", durationMs: 5, exitCode: findings.length ? 2 : 0 };
    },
  };
  reg.register(a);
  return reg;
}

describe("runSecurityVerifyPhase", () => {
  it("tallies verified/reopened, INCLUDING a Change-B orphan (finding no worktree touched)", async () => {
    const wtA = mkdtempSync(join(tmpdir(), "verify-wtA-"));
    const wtB = mkdtempSync(join(tmpdir(), "verify-wtB-"));
    // fp1's file (src/a.ts) is touched by wtA, and the re-scan of wtA still finds it -> reopened.
    // fp2's file (src/b.ts) is touched by wtB, and the re-scan of wtB finds nothing -> verified.
    // fp3's file (src/c.ts) is touched by NO worktree diff -> never becomes a VerifyItem (Change B orphan) -> reopened.
    const postedMap = [
      { threadId: "t-1", finding: finding("fp1", "src/a.ts") },
      { threadId: "t-2", finding: finding("fp2", "src/b.ts") },
      { threadId: "t-3", finding: finding("fp3", "src/c.ts") },
    ];
    const workspacePaths = new Map([["agentA", wtA], ["agentB", wtB]]);
    const diffFn = (worktree: string) => (worktree === wtA ? ["src/a.ts"] : ["src/b.ts"]);
    // Injecting a registry bypasses createDefaultRegistry (no docker/env-file/adapter dependency needed).
    const registry = pathKeyedRegistry({ [wtA]: [finding("fp1", "src/a.ts")], [wtB]: [] });

    const result = await runSecurityVerifyPhase(
      { postedMap, workspacePaths, baseSha: "abc", engineId: "strix", scanTimeoutMs: 5000, scanMode: "quick" },
      { registry, diffFn },
    );

    expect(result.verified).toBe(1);
    expect(result.reopened).toBe(2);
    expect(result.details).toHaveLength(3);
    expect(result.details.find((d) => d.fingerprint === "fp1")?.status).toBe("reopened");
    expect(result.details.find((d) => d.fingerprint === "fp2")?.status).toBe("verified");
    expect(result.details.find((d) => d.fingerprint === "fp3")?.status).toBe("reopened");
    expect(result.details.find((d) => d.fingerprint === "fp3")?.threadId).toBe("t-3");

    rmSync(wtA, { recursive: true, force: true });
    rmSync(wtB, { recursive: true, force: true });
  });
});
