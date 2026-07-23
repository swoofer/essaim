import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseStrixVulnerabilitiesJson,
  parseStrixSarif,
  reconcileStrixFindings,
  mapSeverity,
  StrixParseError,
} from "../../src/security/adapters/strix-parse.js";
import type { Finding } from "../../src/security/types.js";

const fx = (name: string) => readFileSync(join(__dirname, "..", "fixtures", "security", name), "utf8");

describe("parseStrixVulnerabilitiesJson", () => {
  const findings = parseStrixVulnerabilitiesJson(fx("strix-vulnerabilities.json"));

  it("parses the top-level array into 2 findings", () => {
    expect(findings).toHaveLength(2);
  });

  it("maps file/line/endLine from code_locations[0]", () => {
    expect(findings[0].file).toBe("src/db/users.ts");
    expect(findings[0].line).toBe(42);
    expect(findings[0].endLine).toBe(44);
    expect(findings[1].file).toBe("src/routes/search.ts");
    expect(findings[1].line).toBe(17);
    expect(findings[1].endLine).toBeUndefined();
  });

  it("maps severity via mapSeverity and cwe", () => {
    expect(findings[0].severity).toBe("high");
    expect(findings[0].cwe).toBe("CWE-89");
    expect(findings[1].severity).toBe("medium");
    expect(findings[1].cwe).toBe("CWE-79");
  });

  it("uses a per-run engineFindingId (vuln-000N) for traceability, NOT as ruleId", () => {
    expect(findings[0].engineFindingId).toBe("vuln-0001");
    expect(findings[1].engineFindingId).toBe("vuln-0002");
    expect(findings[0].ruleId).not.toBe("vuln-0001");
  });

  it("derives a STABLE ruleId from cwe (lowercased)", () => {
    expect(findings[0].ruleId).toBe("cwe-89");
    expect(findings[1].ruleId).toBe("cwe-79");
  });

  it("computes a stable 12-hex fingerprint", () => {
    expect(findings[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(findings[1].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    // Re-parsing the same input yields the same fingerprint (stable across runs).
    const again = parseStrixVulnerabilitiesJson(fx("strix-vulnerabilities.json"));
    expect(again[0].fingerprint).toBe(findings[0].fingerprint);
    expect(again[1].fingerprint).toBe(findings[1].fingerprint);
  });

  it("redacts secret-shaped evidence", () => {
    expect(findings[0].evidence ?? "").not.toContain("sk-abcDEF0123456789ghijklmnop");
    expect(findings[0].evidence ?? "").toContain("«REDACTED»");
  });

  it("joins remediation_steps arrays and passes through string remediation_steps", () => {
    expect(findings[0].remediation).toBe("Use parameterized queries\nValidate that the id parameter is numeric before use");
    expect(findings[1].remediation).toBe("Escape user input before interpolating into HTML, or use a templating engine with auto-escaping enabled.");
  });

  it("sets engine/status/raw", () => {
    for (const f of findings) {
      expect(f.engine).toBe("strix");
      expect(f.status).toBe("new");
      expect(f.raw).toBeTruthy();
    }
  });

  it("throws StrixParseError when the input is not a JSON array", () => {
    expect(() => parseStrixVulnerabilitiesJson("{}")).toThrow(StrixParseError);
    expect(() => parseStrixVulnerabilitiesJson("not json")).toThrow(StrixParseError);
  });

  it("leaves file/line undefined when code_locations is absent", () => {
    const [f] = parseStrixVulnerabilitiesJson(JSON.stringify([{ id: "vuln-0009", title: "No location", severity: "low" }]));
    expect(f.file).toBeUndefined();
    expect(f.line).toBeUndefined();
  });
});

describe("parseStrixSarif", () => {
  const findings = parseStrixSarif(fx("strix-findings.sarif"));

  it("parses runs[].results[] into 2 findings", () => {
    expect(findings).toHaveLength(2);
  });

  it("maps file/line from physicalLocation", () => {
    expect(findings[0].file).toBe("src/db/users.ts");
    expect(findings[0].line).toBe(42);
    expect(findings[0].endLine).toBe(44);
    expect(findings[1].file).toBe("src/routes/search.ts");
    expect(findings[1].line).toBe(17);
  });

  it("maps SARIF level → severity (error→high, warning→medium)", () => {
    expect(findings[0].severity).toBe("high");
    expect(findings[1].severity).toBe("medium");
  });

  it("carries ruleId and message text", () => {
    expect(findings[0].ruleId).toBe("cwe-89");
    expect(findings[0].title).toContain("SQL injection");
    expect(findings[1].ruleId).toBe("cwe-79");
  });

  it("throws StrixParseError on non-SARIF input", () => {
    expect(() => parseStrixSarif("{}")).toThrow(StrixParseError);
    expect(() => parseStrixSarif("garbage")).toThrow(StrixParseError);
  });

  it("maps level→severity: error/warning/note/absent", () => {
    const doc = {
      runs: [
        {
          results: [
            { ruleId: "r-error", level: "error", message: { text: "e" } },
            { ruleId: "r-warning", level: "warning", message: { text: "w" } },
            { ruleId: "r-note", level: "note", message: { text: "n" } },
            { ruleId: "r-none", message: { text: "no level" } },
          ],
        },
      ],
    };
    const fs = parseStrixSarif(JSON.stringify(doc));
    expect(fs.map((f) => f.severity)).toEqual(["high", "medium", "low", "info"]);
  });

  it("refines severity via numeric security-severity when present", () => {
    const doc = {
      runs: [
        {
          results: [
            { ruleId: "r1", level: "warning", message: { text: "t" }, properties: { "security-severity": "9.8" } },
          ],
        },
      ],
    };
    const [f] = parseStrixSarif(JSON.stringify(doc));
    expect(f.severity).toBe("critical");
  });
});

describe("reconcileStrixFindings", () => {
  it("backfills file/line on a json finding that lacks them, matched by ruleId", () => {
    const jsonFindings = parseStrixVulnerabilitiesJson(
      JSON.stringify([{ id: "vuln-0001", title: "SQL injection via string concatenation", severity: "high", cwe: "CWE-89" }]),
    );
    expect(jsonFindings[0].file).toBeUndefined();

    const sarifFindings = parseStrixSarif(fx("strix-findings.sarif"));
    const reconciled = reconcileStrixFindings(jsonFindings, sarifFindings);

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].file).toBe("src/db/users.ts");
    expect(reconciled[0].line).toBe(42);
  });

  it("does not touch json findings that already have a file", () => {
    const jsonFindings = parseStrixVulnerabilitiesJson(fx("strix-vulnerabilities.json"));
    const sarifFindings = parseStrixSarif(fx("strix-findings.sarif"));
    const reconciled = reconcileStrixFindings(jsonFindings, sarifFindings);
    expect(reconciled).toHaveLength(2);
    expect(reconciled[0].file).toBe("src/db/users.ts");
    expect(reconciled[1].file).toBe("src/routes/search.ts");
  });

  it("does not duplicate entries (output length === jsonFindings length when json is non-empty)", () => {
    const jsonFindings = parseStrixVulnerabilitiesJson(fx("strix-vulnerabilities.json"));
    const sarifFindings = parseStrixSarif(fx("strix-findings.sarif"));
    const reconciled = reconcileStrixFindings(jsonFindings, sarifFindings);
    expect(reconciled.length).toBe(jsonFindings.length);
  });

  it("falls back to sarifFindings when jsonFindings is empty", () => {
    const sarifFindings = parseStrixSarif(fx("strix-findings.sarif"));
    const reconciled = reconcileStrixFindings([], sarifFindings);
    expect(reconciled).toEqual(sarifFindings);
  });

  it("returns jsonFindings unchanged when sarifFindings is empty", () => {
    const jsonFindings = parseStrixVulnerabilitiesJson(fx("strix-vulnerabilities.json"));
    const reconciled = reconcileStrixFindings(jsonFindings, []);
    expect(reconciled).toEqual(jsonFindings);
  });

  it("leaves an unmatched fileless finding as-is (no false backfill)", () => {
    const jsonFindings: Finding[] = parseStrixVulnerabilitiesJson(
      JSON.stringify([{ id: "vuln-0099", title: "Unrelated finding with no match", severity: "low" }]),
    );
    const sarifFindings = parseStrixSarif(fx("strix-findings.sarif"));
    const reconciled = reconcileStrixFindings(jsonFindings, sarifFindings);
    expect(reconciled[0].file).toBeUndefined();
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
