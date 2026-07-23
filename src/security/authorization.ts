// src/security/authorization.ts — THE fail-closed authorization gate.
//
// FAIL-CLOSED. Deliberately the INVERSE of preflightQuotaCheck (fail-open).
// A copy-paste that keeps preflight's fail-open branch turns this into a no-op —
// the single most dangerous bug in the subsystem. Default deny; refuse on every edge.
import type { AuthorizationResult, EngineId, SecurityConfig } from "./types.js";
import { SecurityAuthorizationError } from "./errors.js";

export interface AuthorizeContext {
  resolvedDiffBase?: string; // resolved at orchestration time (worktree baseSha)
  envAffirmed?: boolean; // ESSAIM_SECURITY_AFFIRMED=1 for static CI scans
}

// Engines that run purely static against a repo (no live target). v1 = strix only.
const STATIC_ENGINES = new Set<EngineId>(["strix"]);

export function authorizeRun(cfg: SecurityConfig, ctx: AuthorizeContext = {}): AuthorizationResult {
  const affirmed = cfg.authorization.affirmed === true || ctx.envAffirmed === true;
  if (!affirmed) {
    return {
      canProceed: false,
      reason:
        "authorization.affirmed is not true — set it in .essaim/security.yaml (or pass --authorize / ESSAIM_SECURITY_AFFIRMED=1) to affirm you own or are authorized to scan this target",
    };
  }
  if (!Array.isArray(cfg.engines) || cfg.engines.length === 0) {
    return { canProceed: false, reason: "no security engines configured" };
  }
  for (const e of cfg.engines) {
    if (!STATIC_ENGINES.has(e)) {
      return {
        canProceed: false,
        reason: `engine '${e}' requires dynamic/live-target execution, which is not available in v1 (static repo scan only)`,
      };
    }
  }
  if (cfg.scope.mode === "diff") {
    const base = (ctx.resolvedDiffBase ?? cfg.scope.diff_base ?? "").trim();
    if (!base) {
      return {
        canProceed: false,
        reason: "scope.mode=diff but no diff base is resolvable — refusing rather than widening to the full tree",
      };
    }
  }
  return { canProceed: true };
}

/** Throwing wrapper for the orchestrator's pre-scan gate (step 3.5). */
export function assertAuthorizedRun(cfg: SecurityConfig, ctx?: AuthorizeContext): void {
  const result = authorizeRun(cfg, ctx);
  if (!result.canProceed) {
    throw new SecurityAuthorizationError(result.reason ?? "security run refused by authorization gate");
  }
}
