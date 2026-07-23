// src/security/scope.ts — resolve the scan scope and filter findings to what's in scope.
import type { Finding, ResolvedScope, SecurityConfig } from "./types.js";
import { SecurityConfigError } from "./errors.js";
import { normPath } from "./finding.js";

/** Convert a simple glob (supporting * and **) to an anchored RegExp over normalized paths.
 *  NOTE: exclude_paths patterns must use forward slashes (only the finding's file is normalized).
 *  A `**` segment matches ZERO OR MORE path segments (not one-or-more): a leading `**/` or
 *  trailing `/**` therefore also matches the zero-directory case (e.g. `**\/x/**` matches the
 *  repo-root path `x/y.ts`, not just `a/x/y.ts`). A MIDDLE `**` (e.g. `a/**\/b`) still requires
 *  exactly one mandatory separator from the preceding literal — it must NOT become optional,
 *  or `a/**\/b` would wrongly match `ab` (an in-scope path silently dropped as excluded). */
export function globToRegExp(glob: string): RegExp {
  const esc = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // * within a single segment -> [^/]* ; segment literals escaped.
  const translateSegment = (seg: string) => seg.split("*").map(esc).join("[^/]*");

  // Collapse consecutive "**" segments to a single "**" before translating — e.g. "dist/**/**"
  // must behave exactly like "dist/**", not compile into a degenerate match-nothing regex.
  const segments = glob.split("/").filter((seg, i, arr) => !(seg === "**" && arr[i - 1] === "**"));
  let body = "";
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;
    if (seg === "**") {
      if (isFirst && isLast) {
        body += ".*"; // whole pattern is just "**"
      } else if (isFirst) {
        body += "(?:.*/)?"; // leading **/ -> zero or more leading dirs (carries its own trailing slash)
      } else if (isLast) {
        body += "(?:/.*)?"; // trailing /** -> zero or more dirs (carries its own leading slash)
      } else {
        // Middle /**/ between two literals: keep exactly ONE mandatory separator from the
        // previous segment (do NOT let it become optional, or "a/**/b" would over-match "ab"),
        // then zero-or-more dirs each terminated by "/" before the next segment.
        const prevSeg = segments[i - 1];
        if (prevSeg !== "**") body += "/";
        body += "(?:.*/)?";
      }
    } else {
      const prevSeg = segments[i - 1];
      // No literal "/" needed before this segment when the previous segment was "**":
      // its (?:.*/)? / (?:/.*)? group already accounts for the separator.
      if (!isFirst && prevSeg !== "**") body += "/";
      body += translateSegment(seg);
    }
  }
  return new RegExp("^" + body + "$");
}

/** Resolve config + run context into a concrete scope; REFUSES (throws) rather than widening. */
export function resolveScope(cfg: SecurityConfig, ctx: { repoPath: string; baseSha?: string }): ResolvedScope {
  const mode = cfg.scope.mode;
  let diffBase: string | undefined;
  if (mode === "diff") {
    diffBase = cfg.scope.diff_base?.trim() || ctx.baseSha;
    if (!diffBase) {
      throw new SecurityConfigError(
        "scope.mode=diff but no diff_base configured and no worktree baseSha resolved — refusing to silently widen scope to full tree",
      );
    }
  }
  return {
    targetPath: ctx.repoPath,
    mode,
    scanMode: cfg.scan_mode,
    diffBase,
    excludeMatchers: cfg.scope.exclude_paths.map(globToRegExp),
  };
}

/** A finding is in scope iff it has a file and that file matches no exclude pattern. */
export function isInScope(f: Finding, scope: ResolvedScope): boolean {
  if (!f.file) return false;
  const p = normPath(f.file);
  return !scope.excludeMatchers.some((re) => re.test(p));
}

/** Partition findings into kept (in scope) and a dropped count. Single chokepoint before any sink. */
export function dropOutOfScope(findings: Finding[], scope: ResolvedScope): { kept: Finding[]; dropped: number } {
  const kept: Finding[] = [];
  let dropped = 0;
  for (const f of findings) {
    if (isInScope(f, scope)) kept.push(f);
    else dropped++;
  }
  return { kept, dropped };
}
