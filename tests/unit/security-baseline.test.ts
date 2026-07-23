import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baselinePath,
  loadBaseline,
  applyBaseline,
  writeBaseline,
  upsertBaselineEntry,
} from "../../src/security/baseline.js";
import { SecurityConfigError } from "../../src/security/errors.js";
import type { Finding, BaselineFile } from "../../src/security/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "essaim-baseline-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function finding(fp: string): Finding {
  return {
    id: "x", engine: "strix", ruleId: "r", title: "t", description: "d",
    severity: "high", category: "sqli", file: "src/a.ts", fingerprint: fp,
    status: "new", discoveredAt: "2026-07-22T00:00:00Z", raw: null,
  };
}

describe("loadBaseline", () => {
  it("returns an empty baseline when the file is absent", () => {
    expect(loadBaseline(dir)).toEqual({ version: 1, entries: {} });
  });

  it("loads an existing baseline", () => {
    const bl: BaselineFile = { version: 1, entries: { abc: { status: "false_positive", reason: "r", by: "j", at: "2026-07-20" } } };
    mkdirSync(join(dir, ".essaim", "security"), { recursive: true });
    writeFileSync(baselinePath(dir), JSON.stringify(bl));
    expect(loadBaseline(dir)).toEqual(bl);
  });

  it("throws on a malformed baseline", () => {
    mkdirSync(join(dir, ".essaim", "security"), { recursive: true });
    writeFileSync(baselinePath(dir), JSON.stringify({ version: 2 }));
    expect(() => loadBaseline(dir)).toThrow(SecurityConfigError);
  });

  it("throws SecurityConfigError on a JSON syntax error", () => {
    mkdirSync(join(dir, ".essaim", "security"), { recursive: true });
    writeFileSync(baselinePath(dir), "{ not valid json");
    expect(() => loadBaseline(dir)).toThrow(SecurityConfigError);
  });

  it("throws SecurityConfigError on a literal null file", () => {
    mkdirSync(join(dir, ".essaim", "security"), { recursive: true });
    writeFileSync(baselinePath(dir), "null");
    expect(() => loadBaseline(dir)).toThrow(SecurityConfigError);
  });
});

describe("applyBaseline", () => {
  const baseline: BaselineFile = {
    version: 1,
    entries: {
      supp: { status: "false_positive", reason: "sanitized upstream", by: "j", at: "2026-07-20" },
      wont: { status: "wont_fix", reason: "accepted risk", by: "j", at: "2026-07-20" },
    },
  };

  it("drops suppressed and wont_fix findings, keeps the rest", () => {
    const res = applyBaseline([finding("supp"), finding("fresh1"), finding("wont"), finding("fresh2")], baseline);
    expect(res.fresh.map((f) => f.fingerprint)).toEqual(["fresh1", "fresh2"]);
    expect(res.suppressed).toBe(2);
  });
});

describe("writeBaseline + upsertBaselineEntry", () => {
  it("creates the directory and round-trips", () => {
    const before = loadBaseline(dir);
    const after = upsertBaselineEntry(before, "newfp", { status: "false_positive", reason: "x", by: "j", at: "2026-07-22" });
    writeBaseline(dir, after);
    expect(existsSync(baselinePath(dir))).toBe(true);
    expect(loadBaseline(dir).entries.newfp.status).toBe("false_positive");
    // human-readable (pretty-printed)
    expect(readFileSync(baselinePath(dir), "utf8")).toContain("\n  ");
    // original baseline was not mutated
    expect(before.entries.newfp).toBeUndefined();
  });
});
