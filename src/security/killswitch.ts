// src/security/killswitch.ts — operator halt + orphan-container teardown (safety).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnCaptured, type SpawnFn } from "./adapters/base.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

/** Operator kill-switch: a reports/security/STOP file or ESSAIM_SECURITY_HALT=1. */
export function isHaltRequested(projectPath: string): boolean {
  if (process.env.ESSAIM_SECURITY_HALT === "1") return true;
  return existsSync(join(projectPath, "reports", "security", "STOP"));
}

/**
 * Kill any container still named essaim-security-<runId>. Returns how many were killed.
 *
 * NOTE: this targets the OLD `essaim-security-<runId>` naming from the removed `docker run` model.
 * Strix now creates + owns its sandbox container internally (via the Docker SDK), so essaim has no
 * handle to it — this sweep is a best-effort legacy backstop and does NOT target Strix-managed
 * sandbox containers. Real label-based cleanup for Strix sandboxes is pending live validation (see
 * docs/superpowers/specs/2026-07-23-strix-adapter-real-invocation-design.md §7).
 */
export async function sweepOrphanContainers(runId: string, opts: { spawnFn?: SpawnFn } = {}): Promise<number> {
  const filter = `name=essaim-security-${runId}`;
  const ps = await spawnCaptured("docker", ["ps", "-q", "--filter", filter], { spawnFn: opts.spawnFn }).catch(() => ({
    code: 1, stdout: "", stderr: "", timedOut: false,
  }));
  const ids = ps.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let killed = 0;
  for (const id of ids) {
    const r = await spawnCaptured("docker", ["kill", id], { spawnFn: opts.spawnFn }).catch(() => ({ code: 1 } as { code: number }));
    if (r.code === 0) {
      killed++;
      log.warn(`security: swept orphan container ${id} (run ${runId})`);
    }
  }
  return killed;
}
