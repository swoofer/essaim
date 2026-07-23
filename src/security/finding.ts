// src/security/finding.ts — pure helpers over Finding. No I/O.
import { createHash } from "node:crypto";
import type { Finding, Severity, SubjectSeverity } from "./types.js";

/** Normalize a repo-relative path for stable, cross-platform fingerprinting. */
export function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Stable, LINE-INSENSITIVE fingerprint: sha1(engine|ruleId|normPath(file)|category)[:12].
 * Survives code drift (no line number) and works as a baseline/suppression key.
 */
export function fingerprint(f: Pick<Finding, "engine" | "ruleId" | "file" | "category">): string {
  const key = [f.engine, f.ruleId, normPath(f.file ?? ""), f.category].join("|");
  return createHash("sha1").update(key).digest("hex").slice(0, 12);
}

/** Collapse the native 5-level severity into essaim's 3-level coordinator prefix. */
export function toSubjectSeverity(sev: Severity): SubjectSeverity {
  if (sev === "critical" || sev === "high") return "critical";
  if (sev === "medium" || sev === "low") return "warning";
  return "info";
}
