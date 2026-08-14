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

  // Pin the commit the worktrees branch off. The report needs it to measure what
  // an agent actually produced: agents are told to COMMIT their work, so a plain
  // `git diff HEAD` in the worktree shows nothing and every agent looked like it
  // changed nothing (#29). Diffing against this base captures commits too.
  let baseSha: string | undefined;
  try {
    baseSha = execSync(`git rev-parse ${ref}`, { cwd: basePath, encoding: "utf-8" }).trim();
  } catch { /* not a git repo — diff stats degrade to unavailable */ }

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

  return { type: workspace.type, basePath, paths, baseSha };
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
 * ref, independent of the source tree's working state. So this is opt-in only,
 * and the opt-in NAMES its target: set `ESSAIM_RESET_BASE=/path/to/sandbox`,
 * which must resolve to this run's base or the call throws. A boolean `=1`
 * used to authorize the operation without saying on what — see the refusal
 * below for why that was replaced (#56). Typical use remains a dedicated
 * sandbox dir under `/tmp/essaim-sandbox/`, never your real project.
 *
 * Without the opt-in, we just log a warning if there's dirt and return — let
 * `git worktree add` do its thing from the committed state.
 */
/**
 * Same directory? Compared on resolved form, case-insensitively on win32 where
 * the filesystem is.
 */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

export function resetBase(basePath: string): void {
  const authorized = process.env.ESSAIM_RESET_BASE;
  const target = path.resolve(basePath);

  if (!authorized) {
    let dirty = "";
    try {
      dirty = execSync("git status --porcelain", { cwd: basePath, encoding: "utf8" }).trim();
    } catch { /* not a git repo? defer to caller */ }
    if (dirty) {
      const lines = dirty.split("\n");
      console.warn(
        `[workspace] base has ${lines.length} dirty/untracked entr${lines.length === 1 ? "y" : "ies"} — leaving them alone (set ESSAIM_RESET_BASE=${target} to git clean -fd + git checkout -- .).\n` +
        `            worktrees snapshot from a git ref so this is fine; your local files stay safe.`,
      );
    }
    return;
  }

  // The variable NAMES the directory to destroy; it is not a boolean.
  //
  // `=1` authorized the operation without saying on what: the target came from
  // elsewhere (workspace.base, defaulting to cwd), so a stray `-p` was enough
  // to lose uncommitted work with nothing but a console.warn (#56).
  //
  // No heuristic fixes that. Refusing when the base equals the cwd — the
  // obvious guard — breaks the very usage this doc recommends
  // (`cd /tmp/sandbox && essaim run -p .`); it was implemented, and an existing
  // test proved it wrong. Naming the path is the only authorization with
  // neither false positives nor false negatives: you cannot destroy what you
  // did not name.
  if (!samePath(authorized, target)) {
    throw new Error(
      `resetBase refused: ESSAIM_RESET_BASE must name the directory to reset, not enable a mode. ` +
        `It is set to ${JSON.stringify(authorized)}, but this run's base is ${target}. ` +
        `This would run "git checkout -- ." + "git clean -fd" there, discarding uncommitted work. ` +
        `If that is really what you want: ESSAIM_RESET_BASE=${target}`,
    );
  }

  console.warn(`[workspace] ESSAIM_RESET_BASE names ${target} — running destructive git checkout -- . + git clean -fd`);
  execSync("git checkout -- .", { cwd: basePath, stdio: "pipe" });
  execSync("git clean -fd", { cwd: basePath, stdio: "pipe" });
}


