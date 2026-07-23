// cli/security.ts — `essaim security`: scan → seed coordinator → swarm fixes → verify → report.
import { Command } from "commander";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadSecurityConfig, SECURITY_CONFIG_REL } from "../src/security/config.js";
import type { MiniProjectSecurity, SecurityRunLedger, EngineId, SecurityScopeConfig, SecurityConfig } from "../src/security/types.js";
import { executeRun } from "./run-core.js";

export interface SecurityCliOpts {
  project: string;
  engine: string; // comma-separated; v1: "strix"
  scanMode: "quick" | "deep";
  scopeMode: "diff" | "full";
  diffBase?: string;
  authorize?: boolean;
  secretsFile?: string;
  scanTimeout?: string; // minutes
  requireFindings?: boolean;
  triageOnly?: boolean;
  agents?: string;
  timeout?: string;
  cleanup?: boolean;
  dryRun?: boolean;
  coordinatorUrl?: string;
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

function defaultIsTracked(projectPath: string): (path: string) => boolean {
  return (path) => {
    try {
      execFileSync("git", ["ls-files", "--error-unmatch", path], { cwd: projectPath, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
}

export function assembleSecurity(
  opts: SecurityCliOpts,
  projectPath: string,
  deps: { isTracked?: (path: string) => boolean } = {},
): { security: MiniProjectSecurity; triageOnly: boolean } {
  if (opts.coordinatorUrl && !isLoopback(opts.coordinatorUrl)) {
    throw new Error(
      `Refusing an external coordinator (${opts.coordinatorUrl}). v1 security runs require the essaim-managed ` +
        `loopback coordinator (security threads must not share a coordinator with untrusted agents/viewers).`,
    );
  }
  const engines = opts.engine.split(",").map((s) => s.trim()).filter(Boolean) as EngineId[];

  // Only override scope keys the operator actually set — do NOT wipe file/default exclude_paths.
  const scopeOverride: Partial<SecurityScopeConfig> = { mode: opts.scopeMode };
  if (opts.diffBase) scopeOverride.diff_base = opts.diffBase;

  // Build overrides omitting undefined keys — spreading `undefined` over loadSecurityConfig's
  // shallow merge would clobber the 30-min scanTimeoutMs / requireFindings:true defaults.
  const overrides: Partial<SecurityConfig> = { scope: scopeOverride as SecurityScopeConfig };
  if (engines.length) overrides.engines = engines;
  if (opts.scanMode) overrides.scan_mode = opts.scanMode;
  if (opts.scanTimeout) overrides.scanTimeoutMs = parseInt(opts.scanTimeout, 10) * 60 * 1000;
  if (opts.requireFindings !== undefined) overrides.requireFindings = opts.requireFindings;
  const config = loadSecurityConfig(projectPath, overrides);

  const perRunAffirmed = opts.authorize === true || process.env.ESSAIM_SECURITY_AFFIRMED === "1";

  // Footgun guard (decision #4): a COMMITTED affirmed:true is not enough on its own — require --authorize.
  const isTracked = deps.isTracked ?? defaultIsTracked(projectPath);
  if (config.authorization.affirmed === true && !perRunAffirmed && isTracked(join(projectPath, SECURITY_CONFIG_REL))) {
    throw new Error(
      "`.essaim/security.yaml` is committed with affirmed:true — pass --authorize to confirm this run (footgun guard, decision #4).",
    );
  }

  return {
    security: { config, secretsFile: opts.secretsFile, envAffirmed: perRunAffirmed },
    triageOnly: opts.triageOnly === true,
  };
}

/** Mirror the Strix contract: 1 on engine error, 2 when findings existed, else 0. */
export function securityExitCode(ledger: SecurityRunLedger): 0 | 1 | 2 {
  if (ledger.status === "error" || ledger.status === "timeout" || ledger.degraded) return 1;
  if (ledger.ingested > 0 || ledger.reopened > 0) return 2;
  return 0;
}

export function createSecurityCommand(): Command {
  return new Command("security")
    .description("Scan for security findings, seed the coordinator, and let the swarm fix them (auto-fix on branches)")
    .option("-p, --project <path>", "Target project path", ".")
    .option("--engine <list>", "Engine(s) (v1: strix)", "strix")
    .option("--scan-mode <mode>", "quick|deep", "quick")
    .option("--scope-mode <mode>", "diff|full", "diff")
    .option("--diff-base <ref>", "Base ref for diff scope (default: worktree baseSha)")
    .option("--authorize", "Affirm you own/are authorized to scan this repo")
    .option("--secrets-file <path>", "0600 dotenv file with LLM_API_KEY / STRIX_LLM (not process.env)")
    .option("--scan-timeout <min>", "Engine scan timeout in minutes", "30")
    .option("--no-require-findings", "Do not abort when the scan finds nothing")
    .option("--triage-only", "Scan + report only (no swarm fixes)")
    .option("-n, --agents <count>", "Number of fix agents")
    .option("-t, --timeout <min>", "Swarm timeout in minutes")
    .option("--cleanup", "Remove worktrees after execution")
    .option("--dry-run", "Preview without launching")
    .option("--coordinator-url <url>", "Coordinator URL (loopback only in v1)")
    .action(async (opts: SecurityCliOpts) => {
      const projectPath = resolve(opts.project);
      const { security, triageOnly } = assembleSecurity(opts, projectPath);
      const result = await executeRun({
        template: "sentinelle",
        project: opts.project,
        agentCount: opts.agents ? parseInt(opts.agents, 10) : undefined,
        timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
        cleanup: opts.cleanup,
        dryRun: opts.dryRun,
        setParams: {},
        coordinatorUrl: opts.coordinatorUrl,
        catalogs: [],
        security,
        triageOnly,
      });
      if (!result) process.exit(0); // --dry-run: executeRun returns undefined, nothing ran
      const code = result.security ? securityExitCode(result.security) : 0;
      process.exit(code);
    });
}
