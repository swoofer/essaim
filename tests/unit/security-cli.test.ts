import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleSecurity, securityExitCode, type SecurityCliOpts } from "../../cli/security.js";
import type { SecurityRunLedger } from "../../src/security/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "seccli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function opts(over: Partial<SecurityCliOpts> = {}): SecurityCliOpts {
  return { project: dir, engine: "strix", scanMode: "quick", scopeMode: "diff", authorize: true, ...over };
}

describe("assembleSecurity", () => {
  it("builds MiniProjectSecurity from flags + config, with authorize→affirmed", () => {
    const { security, triageOnly } = assembleSecurity(opts(), dir);
    expect(security.config.engines).toEqual(["strix"]);
    expect(security.config.scan_mode).toBe("quick");
    expect(security.envAffirmed).toBe(true); // --authorize
    expect(triageOnly).toBe(false);
  });

  it("passes secretsFile through", () => {
    const { security } = assembleSecurity(opts({ secretsFile: "/tmp/s.env" }), dir);
    expect(security.secretsFile).toBe("/tmp/s.env");
  });

  it("sets triageOnly from --triage-only", () => {
    expect(assembleSecurity(opts({ triageOnly: true }), dir).triageOnly).toBe(true);
  });

  it("REJECTS an external (non-loopback) coordinator URL", () => {
    expect(() => assembleSecurity(opts({ coordinatorUrl: "http://prod.example.com:3100" }), dir)).toThrow(/external coordinator/i);
  });

  it("accepts a loopback coordinator URL", () => {
    expect(() => assembleSecurity(opts({ coordinatorUrl: "http://localhost:3100" }), dir)).not.toThrow();
    expect(() => assembleSecurity(opts({ coordinatorUrl: "http://127.0.0.1:3100" }), dir)).not.toThrow();
  });

  it("PRESERVES the default exclude_paths (does not wipe them with [])", () => {
    const { security } = assembleSecurity(opts(), dir);
    expect(security.config.scope.exclude_paths).toContain("node_modules/**");
    expect(security.config.scope.exclude_paths).toContain("**/*fixtures*/**");
  });

  it("REFUSES when .essaim/security.yaml is committed with affirmed:true and no --authorize", () => {
    mkdirSync(join(dir, ".essaim"), { recursive: true });
    writeFileSync(
      join(dir, ".essaim", "security.yaml"),
      "version: 1\nengines: [strix]\nscan_mode: quick\nscope: { mode: diff, diff_base: \"\", exclude_paths: [] }\nauthorization: { affirmed: true, authorized_by: \"jane\" }\n",
    );
    // authorize omitted; simulate the file being git-tracked
    expect(() => assembleSecurity({ ...opts(), authorize: false }, dir, { isTracked: () => true })).toThrow(/committed/i);
    // with --authorize it proceeds
    expect(() => assembleSecurity({ ...opts(), authorize: true }, dir, { isTracked: () => true })).not.toThrow();
  });
});

describe("securityExitCode (mirrors Strix)", () => {
  function ledger(over: Partial<SecurityRunLedger> = {}): SecurityRunLedger {
    return {
      engine: "strix", status: "no_vulns",
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      ingested: 0, verified: 0, reopened: 0, falsePositives: 0, degraded: false,
      durationMs: 1, license: "Apache-2.0", outOfScopeDropped: 0, suppressed: 0, ...over,
    };
  }
  it("0 when clean (no findings)", () => {
    expect(securityExitCode(ledger())).toBe(0);
  });
  it("1 on engine error/degraded", () => {
    expect(securityExitCode(ledger({ status: "error", degraded: true }))).toBe(1);
  });
  it("2 when findings were ingested (even if some got verified)", () => {
    expect(securityExitCode(ledger({ status: "vulns_found", ingested: 3, verified: 3 }))).toBe(2);
  });
  it("2 when a finding reopened (never forces 1)", () => {
    expect(securityExitCode(ledger({ status: "vulns_found", ingested: 3, verified: 2, reopened: 1 }))).toBe(2);
  });
});
