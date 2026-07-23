// src/security/config.ts — load + validate .essaim/security.yaml. Pure w.r.t. secrets (never reads keys).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EngineId, SecurityConfig } from "./types.js";
import { SecurityConfigError } from "./errors.js";

export const SECURITY_CONFIG_REL = join(".essaim", "security.yaml");

const KNOWN_ENGINES = new Set<string>(["strix"]);
const SCAN_MODES = new Set(["quick", "deep"]);
const SCOPE_MODES = new Set(["diff", "full"]);

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  version: 1,
  engines: ["strix"],
  scan_mode: "quick",
  scope: { mode: "diff", diff_base: "", exclude_paths: ["node_modules/**", "**/*fixtures*/**", "vendor/**"] },
  authorization: { affirmed: false, authorized_by: "" },
  scanTimeoutMs: 30 * 60 * 1000,
  requireFindings: true,
};

/** Validate a raw parsed object into a SecurityConfig (merged over defaults). Throws on any violation. */
export function validateSecurityConfig(raw: unknown): SecurityConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.version !== 1) {
    throw new SecurityConfigError(`security config: version must be 1 (got ${JSON.stringify(r.version)})`);
  }
  const merged: SecurityConfig = {
    ...DEFAULT_SECURITY_CONFIG,
    ...(r as Partial<SecurityConfig>),
    scope: { ...DEFAULT_SECURITY_CONFIG.scope, ...((r.scope as object) ?? {}) },
    authorization: { ...DEFAULT_SECURITY_CONFIG.authorization, ...((r.authorization as object) ?? {}) },
  };

  if (!Array.isArray(merged.engines) || merged.engines.length === 0) {
    throw new SecurityConfigError("security config: engines must be a non-empty array");
  }
  for (const e of merged.engines) {
    if (!KNOWN_ENGINES.has(e)) {
      throw new SecurityConfigError(
        `security config: unknown engine '${e}' (v1 supports: ${[...KNOWN_ENGINES].join(", ")})`,
      );
    }
  }
  if (!SCAN_MODES.has(merged.scan_mode)) {
    throw new SecurityConfigError(`security config: scan_mode must be quick|deep (got '${merged.scan_mode}')`);
  }
  if (!SCOPE_MODES.has(merged.scope.mode)) {
    throw new SecurityConfigError(`security config: scope.mode must be diff|full (got '${merged.scope.mode}')`);
  }
  if (!Array.isArray(merged.scope.exclude_paths)) {
    throw new SecurityConfigError("security config: scope.exclude_paths must be an array");
  }
  return { ...merged, engines: merged.engines as EngineId[] };
}

/**
 * Load .essaim/security.yaml (or defaults if absent), validate, then apply overrides (CLI flags).
 * Resolution precedence: overrides > file > default.
 */
export function loadSecurityConfig(projectPath: string, overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  const p = join(projectPath, SECURITY_CONFIG_REL);
  let fileCfg: SecurityConfig;
  if (existsSync(p)) {
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(p, "utf8"));
    } catch (err) {
      throw new SecurityConfigError(`security config: invalid YAML in ${p}: ${(err as Error).message}`);
    }
    fileCfg = validateSecurityConfig(parsed);
  } else {
    fileCfg = { ...DEFAULT_SECURITY_CONFIG };
  }
  return {
    ...fileCfg,
    ...overrides,
    scope: { ...fileCfg.scope, ...(overrides.scope ?? {}) },
    authorization: { ...fileCfg.authorization, ...(overrides.authorization ?? {}) },
  };
}
