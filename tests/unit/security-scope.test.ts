import { describe, it, expect } from "vitest";
import { globToRegExp, resolveScope, isInScope, dropOutOfScope } from "../../src/security/scope.js";
import { SecurityConfigError } from "../../src/security/errors.js";
import type { Finding, SecurityConfig } from "../../src/security/types.js";

function cfg(overrides: Partial<SecurityConfig["scope"]> = {}): SecurityConfig {
  return {
    version: 1,
    engines: ["strix"],
    scan_mode: "quick",
    scope: { mode: "diff", diff_base: "", exclude_paths: ["node_modules/**", "**/*fixtures*/**"], ...overrides },
    authorization: { affirmed: true, authorized_by: "test" },
    scanTimeoutMs: 1_800_000,
    requireFindings: true,
  };
}

function finding(file: string): Finding {
  return {
    id: "x", engine: "strix", ruleId: "r", title: "t", description: "d",
    severity: "high", category: "sqli", file, fingerprint: "f", status: "new",
    discoveredAt: "2026-07-22T00:00:00Z", raw: null,
  };
}

describe("globToRegExp", () => {
  it("matches ** across path segments", () => {
    expect(globToRegExp("node_modules/**").test("node_modules/a/b.ts")).toBe(true);
    expect(globToRegExp("node_modules/**").test("src/a.ts")).toBe(false);
  });
  it("matches * within a single segment only", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/a.ts")).toBe(false);
  });
  it("preserves a literal space in a pattern (does not widen it to .*)", () => {
    const re = globToRegExp("vendor/some lib/**");
    expect(re.test("vendor/some lib/x.ts")).toBe(true);
    expect(re.test("vendor/other/x.ts")).toBe(false);
  });
  it("leading **/ matches zero directories (repo-root)", () => {
    const re = globToRegExp("**/*fixtures*/**");
    expect(re.test("fixtures/sample.ts")).toBe(true); // zero leading dirs
    expect(re.test("tests/__fixtures__/a.ts")).toBe(true);
    expect(re.test("a/b/fixtures-x/c/d.ts")).toBe(true);
    expect(re.test("src/app.ts")).toBe(false);
  });
  it("still preserves a literal space and single-segment *", () => {
    expect(globToRegExp("vendor/some lib/**").test("vendor/some lib/x.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/sub/a.ts")).toBe(false);
    expect(globToRegExp("node_modules/**").test("node_modules/a/b.ts")).toBe(true);
  });
  it("middle ** keeps a mandatory separator (does not glue literals)", () => {
    const re = globToRegExp("a/**/b");
    expect(re.test("a/b")).toBe(true);
    expect(re.test("a/x/b")).toBe(true);
    expect(re.test("a/x/y/b")).toBe(true);
    expect(re.test("ab")).toBe(false); // must NOT over-match
    const re2 = globToRegExp("src/**/gen.ts");
    expect(re2.test("src/gen.ts")).toBe(true);
    expect(re2.test("src/x/gen.ts")).toBe(true);
    expect(re2.test("srcgen.ts")).toBe(false); // must NOT over-match
  });
  it("collapses adjacent ** segments instead of producing a degenerate match-nothing regex", () => {
    const distDouble = globToRegExp("dist/**/**");
    const distSingle = globToRegExp("dist/**");
    expect(distDouble.test("dist/a/b.ts")).toBe(true);
    expect(distDouble.test("dist")).toBe(distSingle.test("dist"));
    expect(distDouble.test("dist")).toBe(true);
    // middle-** fix must remain intact after collapsing adjacent globstars elsewhere
    expect(globToRegExp("a/**/b").test("ab")).toBe(false);
  });
});

describe("resolveScope", () => {
  it("resolves diff_base from config when set", () => {
    const s = resolveScope(cfg({ diff_base: "main" }), { repoPath: "/repo", baseSha: "abc" });
    expect(s.diffBase).toBe("main");
  });
  it("falls back to worktree baseSha when diff_base is empty", () => {
    const s = resolveScope(cfg(), { repoPath: "/repo", baseSha: "abc123" });
    expect(s.diffBase).toBe("abc123");
  });
  it("REFUSES (throws) in diff mode when no base can be resolved", () => {
    expect(() => resolveScope(cfg(), { repoPath: "/repo" })).toThrow(SecurityConfigError);
  });
  it("does not require a base in full mode", () => {
    const s = resolveScope(cfg({ mode: "full" }), { repoPath: "/repo" });
    expect(s.mode).toBe("full");
    expect(s.diffBase).toBeUndefined();
  });
});

describe("isInScope / dropOutOfScope", () => {
  const scope = resolveScope(cfg({ diff_base: "main" }), { repoPath: "/repo" });

  it("excludes files matching exclude_paths (separator-insensitive)", () => {
    expect(isInScope(finding("node_modules/pkg/index.js"), scope)).toBe(false);
    expect(isInScope(finding("tests\\__fixtures__\\sample.ts"), scope)).toBe(false); // backslashes normalized
    expect(isInScope(finding("src/auth/login.ts"), scope)).toBe(true);
  });

  it("treats a finding with no file as out of scope", () => {
    expect(isInScope({ ...finding("x"), file: undefined }, scope)).toBe(false);
  });

  it("dropOutOfScope partitions and counts", () => {
    const res = dropOutOfScope(
      [finding("src/a.ts"), finding("node_modules/b.ts"), finding("src/c.ts")],
      scope,
    );
    expect(res.kept.map((f) => f.file)).toEqual(["src/a.ts", "src/c.ts"]);
    expect(res.dropped).toBe(1);
  });
});
