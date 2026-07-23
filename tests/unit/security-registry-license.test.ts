import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/security/registry.js";
import { EngineLicenseError } from "../../src/security/errors.js";
import type { EngineAdapter, EngineCapabilities, EngineId } from "../../src/security/types.js";

function fakeAdapter(id: string, license: string): EngineAdapter {
  const capabilities: EngineCapabilities = {
    id: id as EngineId,
    displayName: id,
    modes: ["sast"],
    requiresRunningTarget: false,
    supportsDiffScope: true,
    transport: "process",
    license,
  };
  return {
    capabilities,
    async healthCheck() {
      return { ok: true, detail: "fake" };
    },
    async run() {
      return {
        engine: id as EngineId,
        status: "no_vulns",
        findings: [],
        startedAt: "t",
        finishedAt: "t",
        durationMs: 0,
      };
    },
  };
}

describe("createRegistry — license gate", () => {
  it("accepts a permissive (Apache-2.0) adapter", () => {
    const reg = createRegistry();
    expect(() => reg.register(fakeAdapter("strix", "Apache-2.0"))).not.toThrow();
    expect(reg.get("strix" as EngineId)?.capabilities.license).toBe("Apache-2.0");
  });

  it("REFUSES an AGPL-3.0 adapter", () => {
    const reg = createRegistry();
    expect(() => reg.register(fakeAdapter("shannon", "AGPL-3.0"))).toThrow(EngineLicenseError);
  });

  it("REFUSES an unknown/empty license", () => {
    const reg = createRegistry();
    expect(() => reg.register(fakeAdapter("x", ""))).toThrow(EngineLicenseError);
  });

  it("resolve() throws on an unregistered id", () => {
    const reg = createRegistry();
    reg.register(fakeAdapter("strix", "MIT"));
    expect(() => reg.resolve(["strix", "pentagi"] as EngineId[])).toThrow();
  });

  it("REFUSES confusable / near-miss license strings (exact match only)", () => {
    const reg = createRegistry();
    const refused = [
      "MIT-0",                          // not MIT
      "Apache-2.0-with-LLVM-exception", // not Apache-2.0
      "AGPL-3.0-with-MIT-exception",    // copyleft with a misleading suffix
      " MIT",                           // leading whitespace
      "mit",                            // wrong case
      "GPL-3.0",
      "SSPL-1.0",
    ];
    for (const lic of refused) {
      expect(
        () => reg.register(fakeAdapter("x", lic)),
        `license ${JSON.stringify(lic)} must be refused`
      ).toThrow(EngineLicenseError);
    }
  });
});
