import { describe, it, expect } from "vitest";
// Importing every consumer forces them to compile against the ONE canonical types.ts.
// If any module redeclared Finding/EngineAdapter/etc., tsc (via vitest's esbuild) would surface drift.
import * as types from "../../src/security/types.js";
import * as finding from "../../src/security/finding.js";
import * as redact from "../../src/security/redact.js";
import * as scope from "../../src/security/scope.js";
import * as baseline from "../../src/security/baseline.js";
import * as config from "../../src/security/config.js";
import * as authorization from "../../src/security/authorization.js";
import * as registry from "../../src/security/registry.js";
import * as scan from "../../src/security/scan.js";
import * as ingest from "../../src/security/ingest.js";
import * as verify from "../../src/security/verify.js";
import * as prePhase from "../../src/security/pre-phase.js";
import { STRIX_CAPABILITIES } from "../../src/security/adapters/strix.js";

describe("security types integration", () => {
  it("all modules import cleanly against the one schema", () => {
    expect(typeof finding.fingerprint).toBe("function");
    expect(typeof redact.redact).toBe("function");
    expect(typeof scope.resolveScope).toBe("function");
    expect(typeof baseline.applyBaseline).toBe("function");
    expect(typeof config.loadSecurityConfig).toBe("function");
    expect(typeof authorization.authorizeRun).toBe("function");
    expect(typeof registry.createRegistry).toBe("function");
    expect(typeof scan.runSecurityScan).toBe("function");
    expect(typeof ingest.ingestFindings).toBe("function");
    expect(typeof verify.verifyFixes).toBe("function");
    expect(typeof prePhase.runSecurityPrePhase).toBe("function");
    expect(types.STRIX).toBe("strix");
  });

  it("the one adapter declares Apache-2.0 (guards against a license regression)", () => {
    expect(STRIX_CAPABILITIES.license).toBe("Apache-2.0");
  });
});
