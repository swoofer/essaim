import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStrixReport, toFinding, mapSeverity, StrixParseError } from "../../src/security/adapters/strix-parse.js";

const fx = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "security", name), "utf8");

describe("parseStrixReport", () => {
  it("parses the findings array out of a JSON report embedded in stdout", () => {
    const raw = parseStrixReport(fx("strix-vulns.stdout.txt"));
    expect(raw).toHaveLength(2);
    expect(raw[0].ruleId).toBe("sqli-concat");
    expect(raw[0].file).toBe("src/db/users.ts");
    expect(raw[1].category).toBe("xss");
  });

  it("returns [] for a clean report", () => {
    expect(parseStrixReport(fx("strix-clean.stdout.txt"))).toEqual([]);
  });

  it("throws StrixParseError when stdout has no recognizable JSON report", () => {
    expect(() => parseStrixReport("total garbage, no json here")).toThrow(StrixParseError);
  });
});

describe("mapSeverity", () => {
  it("maps engine severity strings to the 5-level scale", () => {
    expect(mapSeverity("critical")).toBe("critical");
    expect(mapSeverity("HIGH")).toBe("high");
    expect(mapSeverity("medium")).toBe("medium");
    expect(mapSeverity("low")).toBe("low");
    expect(mapSeverity("informational")).toBe("info");
    expect(mapSeverity("weird-unknown")).toBe("info"); // safe default
  });
});

describe("toFinding", () => {
  it("normalizes a raw finding, computes a fingerprint, and REDACTS evidence", () => {
    const raw = parseStrixReport(fx("strix-vulns.stdout.txt"))[0];
    const f = toFinding(raw, "id-1");
    expect(f.engine).toBe("strix");
    expect(f.severity).toBe("high");
    expect(f.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(f.status).toBe("new");
    // the sk- token in the fixture evidence must be gone
    expect(f.evidence ?? "").not.toContain("sk-abcDEF0123456789ghijklmnop");
  });
});
