// src/security/verify.ts — deterministic re-scan of fixed worktrees. REPORT-ONLY in v1:
// records verified/reopened; does NOT mutate the coordinator. (Corrected justification: an
// /api/unclaim-task endpoint EXISTS, but it cannot reopen these threads — by the time verify runs
// the thread is already `resolving`/resolved and the caller is the synthetic author, not the
// claimer, so the unclaim SQL (`WHERE status='open' AND claimed_by=?`) matches nothing. A real
// reopen needs a coordinator change and is DEFERRED to v2 — spec §7.3/§14.)
import { existsSync } from "node:fs";
import type { AdapterRegistry, EngineId, Finding, ResolvedScope } from "./types.js";
import { runSecurityScan } from "./scan.js";

export interface VerifyItem {
  finding: Finding;
  worktreePath: string; // the agent branch that should contain the fix
  threadId: string;
  engineId: EngineId;
  scanMode: "quick" | "deep";
}

export interface VerifyResult {
  threadId: string;
  fingerprint: string;
  status: "verified" | "reopened";
}

export async function verifyFixes(
  registry: AdapterRegistry,
  items: VerifyItem[],
  signal: AbortSignal,
  deps: { existsFn?: (p: string) => boolean } = {},
): Promise<VerifyResult[]> {
  const exists = deps.existsFn ?? existsSync;
  const out: VerifyResult[] = [];
  for (const it of items) {
    // Conservative: if the worktree is gone (e.g. --cleanup removed it) we cannot prove closure → reopened.
    if (!exists(it.worktreePath)) {
      out.push({ threadId: it.threadId, fingerprint: it.finding.fingerprint, status: "reopened" });
      continue;
    }
    const scope: ResolvedScope = { targetPath: it.worktreePath, mode: "full", scanMode: it.scanMode, excludeMatchers: [] };
    const scan = await runSecurityScan(registry, [it.engineId], scope, signal);
    if (scan.degraded) {
      // re-scan failed/degraded → cannot prove closure → conservative reopened (anti-false-clean)
      out.push({ threadId: it.threadId, fingerprint: it.finding.fingerprint, status: "reopened" });
      continue;
    }
    const stillThere = scan.findings.some((f) => f.fingerprint === it.finding.fingerprint);
    out.push({ threadId: it.threadId, fingerprint: it.finding.fingerprint, status: stillThere ? "reopened" : "verified" });
  }
  return out;
}
