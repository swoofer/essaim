// src/security/types.ts — THE canonical schema for the security subsystem.
// No other file redeclares Finding, EngineAdapter, EngineRunResult, or SecurityConfig.

export type EngineId = "strix"; // closed union in v1; widen as engines ship.
export const STRIX: EngineId = "strix";

export type Severity = "critical" | "high" | "medium" | "low" | "info"; // native 5-level
export type SubjectSeverity = "critical" | "warning" | "info"; // essaim 3-level (coordinator subject)

export type FindingStatus =
  | "new"
  | "ingested"
  | "in_progress"
  | "fixed" // patch proposed by swarm, NOT yet re-scanned
  | "verified" // deterministic re-scan confirms the vuln is gone
  | "reopened" // re-scan still detects it
  | "false_positive"
  | "wont_fix"
  | "suppressed";

export interface Finding {
  id: string; // UUID minted by the adapter layer (not engine-native)
  engine: EngineId;
  engineFindingId?: string; // native id, for traceability
  ruleId: string; // e.g. "sqli-concat"
  title: string;
  description: string;
  severity: Severity; // native 5-level
  category: string; // normalized slug: "sqli","xss","ssrf","secret","authz",...
  cwe?: string; // "CWE-89"
  file?: string; // repo-relative → coordinator target_files (v1: always set)
  line?: number;
  endLine?: number;
  symbol?: string; // fn/route → coordinator target_symbols
  evidence?: string; // REDACTED + length-capped before it ever leaves the adapter
  remediation?: string;
  fingerprint: string; // stable, LINE-insensitive, path-normalized; baseline + idempotency key
  status: FindingStatus;
  discoveredAt: string; // ISO
  raw: unknown; // engine-native record, kept ONLY in the local (redacted) audit file
}

export type EngineStatus = "no_vulns" | "vulns_found" | "partial" | "timeout" | "error" | "skipped";

export interface EngineError {
  kind: "unavailable" | "auth" | "timeout" | "crash" | "parse" | "config" | "version_unsupported";
  message: string;
  retriable: boolean;
}

export interface EngineRunResult {
  engine: EngineId;
  status: EngineStatus;
  findings: Finding[]; // populated even when status === "partial"
  exitCode?: number; // Strix 0/1/2
  engineVersion?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdoutExcerpt?: string; // truncated + redacted
  reportPath?: string; // reports/security/<engine>-<runId>.txt (redacted)
  error?: EngineError;
}

export interface EngineCapabilities {
  id: EngineId;
  displayName: string;
  modes: Array<"sast" | "diff">;
  requiresRunningTarget: boolean; // false for Strix static diff in v1
  supportsDiffScope: boolean;
  transport: "process"; // v1 is process-only
  license: string; // SPDX id — checked by the registry license gate (Plan 2)
}

export interface ResolvedScope {
  targetPath: string; // repo path (Docker mount source)
  mode: "diff" | "full";
  scanMode: "quick" | "deep"; // from SecurityConfig.scan_mode — wired into the engine's --scan-mode
  diffBase?: string; // resolved ref for Strix --diff-base
  excludeMatchers: RegExp[]; // compiled from SecurityConfig.scope.exclude_paths
}

// ---- The pluggable engine contract (adapters implement this; the registry holds them) ----

export interface EngineAdapter {
  readonly capabilities: EngineCapabilities;
  healthCheck(): Promise<{ ok: boolean; detail: string; version?: string }>;
  run(scope: ResolvedScope, signal: AbortSignal): Promise<EngineRunResult>;
}

export interface AdapterRegistry {
  register(a: EngineAdapter): void; // THROWS (EngineLicenseError) if capabilities.license ∉ permissive allowlist
  get(id: EngineId): EngineAdapter | undefined;
  resolve(ids: EngineId[]): EngineAdapter[]; // throws on an unknown/unregistered id
}

// ---- Config (loaded from .essaim/security.yaml; see config.ts) ----

export interface SecurityScopeConfig {
  mode: "diff" | "full";
  diff_base: string; // "" => resolve from worktree baseSha
  exclude_paths: string[];
}

export interface SecurityAuthorizationConfig {
  affirmed: boolean; // operator affirms ownership/authorization
  authorized_by: string; // audit: name + engagement ref
}

export interface SecurityConfig {
  version: 1;
  engines: EngineId[];
  scan_mode: "quick" | "deep";
  scope: SecurityScopeConfig;
  authorization: SecurityAuthorizationConfig;
  // Runtime fields (not in yaml; defaulted here, overridable by CLI in Plan 4):
  scanTimeoutMs: number;
  requireFindings: boolean;
}

// ---- Baseline / suppression store (see baseline.ts) ----

export interface BaselineEntry {
  status: "false_positive" | "wont_fix" | "suppressed";
  reason: string;
  by: string;
  at: string; // ISO date
}

export interface BaselineFile {
  version: 1;
  entries: Record<string, BaselineEntry>; // keyed by fingerprint
}

// ---- Authorization ----

export interface AuthorizationResult {
  canProceed: boolean;
  reason?: string;
}

// ---- Run-time integration types (Plan 3) ----

/** Attached to MiniProject.security to drive the orchestrator's security steps. */
export interface MiniProjectSecurity {
  config: SecurityConfig;
  secretsFile?: string; // path to a 0600 dotenv file with LLM_API_KEY / STRIX_LLM
  envAffirmed?: boolean; // ESSAIM_SECURITY_AFFIRMED=1 (CI static scans)
}

/** Summary of a security run, attached to RunResult.security and rendered by the reporter. */
export interface SecurityRunLedger {
  engine: EngineId;
  status: EngineStatus;
  findingsBySeverity: Record<Severity, number>;
  ingested: number;
  verified: number;
  reopened: number;
  falsePositives: number;
  degraded: boolean;
  durationMs: number;
  exitCode?: number;
  engineVersion?: string;
  license: string;
  imageDigest?: string;
  outOfScopeDropped: number;
  suppressed: number;
}
