import { execSync } from "child_process";
import path from "path";
import type { AgentConfig, WorkspaceResult } from "./types.js";

export function createWorkspaces(
  workspace: { type: "worktree" | "shared" | "none"; base?: string; baseRef?: string },
  agents: AgentConfig[],
  outputDir: string
): WorkspaceResult {
  const paths = new Map<string, string>();
  const basePath = workspace.base || process.cwd();
  const ref = workspace.baseRef || "HEAD";

  if (workspace.type === "worktree") {
    // Prune stale worktree references from previous runs
    try { execSync(`git worktree prune`, { cwd: basePath, stdio: "pipe" }); } catch {}

    for (const agent of agents) {
      const worktreePath = path.join(outputDir, `worktree-${agent.id}`);
      const branchName = `mini-project-${agent.id}`;
      const branchRef = `refs/heads/${branchName}`;

      // Force-remove any previous worktree that still holds this branch
      // (handles leftover from a previous run at a different path)
      try {
        const porcelain = execSync(`git worktree list --porcelain`, { cwd: basePath, encoding: "utf-8" });
        let currentPath = "";
        for (const line of porcelain.split("\n")) {
          if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
          if (line === `branch ${branchRef}` && currentPath) {
            try { execSync(`git worktree remove "${currentPath}" --force`, { cwd: basePath, stdio: "pipe" }); } catch {}
          }
        }
      } catch {}

      try { execSync(`git branch -D "${branchName}"`, { cwd: basePath, stdio: "pipe" }); } catch {}
      execSync(`git worktree add "${worktreePath}" -b "${branchName}" ${ref}`, { cwd: basePath, stdio: "pipe" });
      paths.set(agent.id, worktreePath);
    }
  } else if (workspace.type === "shared") {
    for (const agent of agents) {
      paths.set(agent.id, basePath);
    }
  } else {
    for (const agent of agents) {
      paths.set(agent.id, basePath);
    }
  }

  return { type: workspace.type, basePath, paths };
}

export function cleanupWorkspaces(workspace: WorkspaceResult): void {
  if (workspace.type !== "worktree") return;
  for (const [agentId, worktreePath] of workspace.paths) {
    const branchName = `mini-project-${agentId}`;
    try { execSync(`git worktree remove "${worktreePath}" --force`, { cwd: workspace.basePath, stdio: "pipe" }); } catch {}
    try { execSync(`git branch -D "${branchName}"`, { cwd: workspace.basePath, stdio: "pipe" }); } catch {}
  }
}

/**
 * "Reset" the worktree base directory by discarding uncommitted changes and
 * deleting untracked files. DESTRUCTIVE — it nukes the user's `.claude/`,
 * any local config, any in-progress edits.
 *
 * Worktrees do NOT need a clean source: `git worktree add` snapshots from a
 * ref, independent of the source tree's working state. So this is opt-in
 * only: set ESSAIM_RESET_BASE=1 if you really want it (typical use: a
 * dedicated sandbox dir under `/tmp/essaim-sandbox/`, never your real
 * project). Without the opt-in, we just log a warning if there's dirt and
 * return — let `git worktree add` do its thing from the committed state.
 */
export function resetBase(basePath: string): void {
  if (process.env.ESSAIM_RESET_BASE !== "1") {
    let dirty = "";
    try {
      dirty = execSync("git status --porcelain", { cwd: basePath, encoding: "utf8" }).trim();
    } catch { /* not a git repo? defer to caller */ }
    if (dirty) {
      const lines = dirty.split("\n");
      console.warn(
        `[workspace] base has ${lines.length} dirty/untracked entr${lines.length === 1 ? "y" : "ies"} — leaving them alone (set ESSAIM_RESET_BASE=1 to git clean -fd + git checkout -- .).\n` +
        `            worktrees snapshot from a git ref so this is fine; your local files stay safe.`,
      );
    }
    return;
  }
  console.warn("[workspace] ESSAIM_RESET_BASE=1 — running destructive git checkout -- . + git clean -fd on " + basePath);
  execSync("git checkout -- .", { cwd: basePath, stdio: "pipe" });
  execSync("git clean -fd", { cwd: basePath, stdio: "pipe" });
}


