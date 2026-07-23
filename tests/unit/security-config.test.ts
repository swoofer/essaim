import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecurityConfig, DEFAULT_SECURITY_CONFIG, validateSecurityConfig } from "../../src/security/config.js";
import { SecurityConfigError } from "../../src/security/errors.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "essaim-seccfg-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeCfg(yamlText: string): void {
  mkdirSync(join(dir, ".essaim"), { recursive: true });
  writeFileSync(join(dir, ".essaim", "security.yaml"), yamlText, "utf8");
}

describe("loadSecurityConfig", () => {
  it("returns defaults (affirmed:false) when no file exists", () => {
    const cfg = loadSecurityConfig(dir);
    expect(cfg.authorization.affirmed).toBe(false);
    expect(cfg.engines).toEqual(["strix"]);
    expect(cfg.scope.mode).toBe("diff");
  });

  it("merges file values over defaults", () => {
    writeCfg(`
version: 1
engines: [strix]
scan_mode: deep
scope:
  mode: full
  diff_base: ""
  exclude_paths: ["vendor/**"]
authorization:
  affirmed: true
  authorized_by: "jane / TICKET-1"
`);
    const cfg = loadSecurityConfig(dir);
    expect(cfg.scan_mode).toBe("deep");
    expect(cfg.scope.mode).toBe("full");
    expect(cfg.scope.exclude_paths).toEqual(["vendor/**"]);
    expect(cfg.authorization.affirmed).toBe(true);
  });

  it("applies overrides with highest precedence (CLI flags)", () => {
    writeCfg(`version: 1
engines: [strix]
scan_mode: quick
scope: { mode: diff, diff_base: "", exclude_paths: [] }
authorization: { affirmed: false, authorized_by: "" }
`);
    const cfg = loadSecurityConfig(dir, { scan_mode: "deep", requireFindings: false });
    expect(cfg.scan_mode).toBe("deep");
    expect(cfg.requireFindings).toBe(false);
  });

  it("a PARTIAL scope override preserves sibling scope keys (exclude_paths, diff_base)", () => {
    writeCfg(`version: 1
engines: [strix]
scan_mode: quick
scope:
  mode: diff
  diff_base: "main"
  exclude_paths: ["node_modules/**", "vendor/**"]
authorization: { affirmed: false, authorized_by: "" }
`);
    const cfg = loadSecurityConfig(dir, { scope: { mode: "full" } as never });
    expect(cfg.scope.mode).toBe("full");            // overridden
    expect(cfg.scope.diff_base).toBe("main");       // preserved
    expect(cfg.scope.exclude_paths).toEqual(["node_modules/**", "vendor/**"]); // NOT wiped
  });

  it("a partial authorization override preserves sibling authorization keys", () => {
    writeCfg(`version: 1
engines: [strix]
scan_mode: quick
scope: { mode: diff, diff_base: "", exclude_paths: [] }
authorization: { affirmed: false, authorized_by: "jane / TICKET-9" }
`);
    const cfg = loadSecurityConfig(dir, { authorization: { affirmed: true } as never });
    expect(cfg.authorization.affirmed).toBe(true);              // overridden
    expect(cfg.authorization.authorized_by).toBe("jane / TICKET-9"); // preserved
  });

  it("applies defaults when the YAML omits the scope/authorization blocks", () => {
    writeCfg(`version: 1
engines: [strix]
scan_mode: quick
`);
    const cfg = loadSecurityConfig(dir);
    expect(cfg.scope.mode).toBe("diff");                       // default
    expect(cfg.scope.exclude_paths.length).toBeGreaterThan(0); // default excludes present
    expect(cfg.authorization.affirmed).toBe(false);            // default
  });

  it("rejects an unknown engine", () => {
    writeCfg(`version: 1
engines: [strix, metasploit]
scan_mode: quick
scope: { mode: diff, diff_base: "", exclude_paths: [] }
authorization: { affirmed: false, authorized_by: "" }
`);
    expect(() => loadSecurityConfig(dir)).toThrow(SecurityConfigError);
  });

  it("rejects a wrong version", () => {
    expect(() => validateSecurityConfig({ version: 2 })).toThrow(SecurityConfigError);
  });

  it("rejects an invalid scan_mode", () => {
    writeCfg(`version: 1
engines: [strix]
scan_mode: turbo
scope: { mode: diff, diff_base: "", exclude_paths: [] }
authorization: { affirmed: false, authorized_by: "" }
`);
    expect(() => loadSecurityConfig(dir)).toThrow(SecurityConfigError);
  });
});

describe("DEFAULT_SECURITY_CONFIG", () => {
  it("is affirmed:false and single-engine by default", () => {
    expect(DEFAULT_SECURITY_CONFIG.authorization.affirmed).toBe(false);
    expect(DEFAULT_SECURITY_CONFIG.engines).toEqual(["strix"]);
  });
});
