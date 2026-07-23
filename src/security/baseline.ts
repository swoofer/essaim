// src/security/baseline.ts — committed cross-run suppression store, keyed by fingerprint.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { BaselineEntry, BaselineFile, Finding } from "./types.js";
import { SecurityConfigError } from "./errors.js";

export const BASELINE_REL = join(".essaim", "security", "baseline.json");

const SUPPRESSED_STATUSES = new Set<BaselineEntry["status"]>(["false_positive", "wont_fix", "suppressed"]);

export function baselinePath(projectPath: string): string {
  return join(projectPath, BASELINE_REL);
}

export function loadBaseline(projectPath: string): BaselineFile {
  const p = baselinePath(projectPath);
  if (!existsSync(p)) return { version: 1, entries: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new SecurityConfigError(`baseline.json is not valid JSON: ${p}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SecurityConfigError(`baseline.json must be an object { version: 1, entries: {} }: ${p}`);
  }
  const b = raw as Partial<BaselineFile>;
  if (b.version !== 1 || typeof b.entries !== "object" || b.entries === null || Array.isArray(b.entries)) {
    throw new SecurityConfigError(`baseline.json must be { version: 1, entries: {} }: ${p}`);
  }
  return b as BaselineFile;
}

/** Drop findings whose fingerprint is suppressed in the baseline. */
export function applyBaseline(
  findings: Finding[],
  baseline: BaselineFile,
): { fresh: Finding[]; suppressed: number } {
  const fresh: Finding[] = [];
  let suppressed = 0;
  for (const f of findings) {
    const e = baseline.entries[f.fingerprint];
    if (e && SUPPRESSED_STATUSES.has(e.status)) suppressed++;
    else fresh.push(f);
  }
  return { fresh, suppressed };
}

export function upsertBaselineEntry(baseline: BaselineFile, fingerprint: string, entry: BaselineEntry): BaselineFile {
  return { version: 1, entries: { ...baseline.entries, [fingerprint]: entry } };
}

export function writeBaseline(projectPath: string, baseline: BaselineFile): void {
  const p = baselinePath(projectPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(baseline, null, 2) + "\n", "utf8");
}
