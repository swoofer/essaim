import { describe, it, expect } from "vitest";
import { fingerprint, normPath, toSubjectSeverity } from "../../src/security/finding.js";

describe("normPath", () => {
  it("normalizes backslashes to forward slashes and strips leading ./", () => {
    expect(normPath("src\\auth\\login.ts")).toBe("src/auth/login.ts");
    expect(normPath("./src/auth.ts")).toBe("src/auth.ts");
  });
});

describe("fingerprint", () => {
  const base = { engine: "strix" as const, ruleId: "sqli-concat", file: "src/db.ts", category: "sqli" };

  it("is stable for identical inputs", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it("is LINE-insensitive (two findings differing ONLY by line collide)", () => {
    // fingerprint()'s input has no `line` field, so the same vuln at different lines must collide.
    const atLine10 = { ...base, line: 10 };
    const atLine999 = { ...base, line: 999 };
    expect(fingerprint(atLine10)).toBe(fingerprint(atLine999));
  });

  it("is path-separator insensitive (\\ vs /)", () => {
    expect(fingerprint({ ...base, file: "src\\db.ts" })).toBe(fingerprint({ ...base, file: "src/db.ts" }));
  });

  it("differs when rule/category/file/engine differ", () => {
    expect(fingerprint({ ...base, ruleId: "xss-reflected" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, category: "xss" })).not.toBe(fingerprint(base));
    expect(fingerprint({ ...base, file: "src/other.ts" })).not.toBe(fingerprint(base));
  });

  it("returns a 12-char hex string", () => {
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe("toSubjectSeverity", () => {
  it("collapses 5-level native severity into essaim's 3-level", () => {
    expect(toSubjectSeverity("critical")).toBe("critical");
    expect(toSubjectSeverity("high")).toBe("critical");
    expect(toSubjectSeverity("medium")).toBe("warning");
    expect(toSubjectSeverity("low")).toBe("warning");
    expect(toSubjectSeverity("info")).toBe("info");
  });
});
