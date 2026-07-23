import { describe, it, expect } from "vitest";
import { authorizeRun, assertAuthorizedRun } from "../../src/security/authorization.js";
import { SecurityAuthorizationError } from "../../src/security/errors.js";
import type { SecurityConfig } from "../../src/security/types.js";

function cfg(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    version: 1,
    engines: ["strix"],
    scan_mode: "quick",
    scope: { mode: "diff", diff_base: "main", exclude_paths: [] },
    authorization: { affirmed: true, authorized_by: "jane" },
    scanTimeoutMs: 1_800_000,
    requireFindings: true,
    ...overrides,
  };
}

describe("authorizeRun (FAIL-CLOSED)", () => {
  it("proceeds only when everything is satisfied", () => {
    expect(authorizeRun(cfg())).toEqual({ canProceed: true });
  });

  it("refuses when affirmed is not strictly true", () => {
    expect(authorizeRun(cfg({ authorization: { affirmed: false, authorized_by: "" } })).canProceed).toBe(false);
    // truthy-but-not-true must NOT pass
    const sneaky = cfg();
    (sneaky.authorization as unknown as { affirmed: unknown }).affirmed = 1;
    expect(authorizeRun(sneaky).canProceed).toBe(false);
  });

  it("accepts CI env affirmation for a static scan", () => {
    const c = cfg({ authorization: { affirmed: false, authorized_by: "" } });
    expect(authorizeRun(c, { envAffirmed: true }).canProceed).toBe(true);
  });

  it("refuses when engines is empty", () => {
    expect(authorizeRun(cfg({ engines: [] })).canProceed).toBe(false);
  });

  it("refuses an engine that needs a live target (not available in v1)", () => {
    const c = cfg();
    (c.engines as unknown as string[]) = ["pentagi"];
    const r = authorizeRun(c);
    expect(r.canProceed).toBe(false);
    expect(r.reason).toMatch(/not available in v1/i);
  });

  it("refuses diff mode with no resolvable base", () => {
    const c = cfg({ scope: { mode: "diff", diff_base: "", exclude_paths: [] } });
    expect(authorizeRun(c).canProceed).toBe(false);
    // a resolved base from context rescues it
    expect(authorizeRun(c, { resolvedDiffBase: "abc123" }).canProceed).toBe(true);
  });

  it("allows full mode without a base", () => {
    expect(authorizeRun(cfg({ scope: { mode: "full", diff_base: "", exclude_paths: [] } })).canProceed).toBe(true);
  });
});

describe("assertAuthorizedRun", () => {
  it("throws SecurityAuthorizationError on refusal", () => {
    expect(() => assertAuthorizedRun(cfg({ authorization: { affirmed: false, authorized_by: "" } }))).toThrow(
      SecurityAuthorizationError,
    );
  });
  it("does not throw when authorized", () => {
    expect(() => assertAuthorizedRun(cfg())).not.toThrow();
  });
});
