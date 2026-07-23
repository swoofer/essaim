// src/security/adapters/strix-parse.ts — the ONE unit that depends on Strix's output format.
// Isolate all format brittleness here. If a real capture shows a different schema, only the
// RawStrixFinding mapping below changes.
import type { EngineId, Finding, Severity } from "../types.js";
import { fingerprint } from "../finding.js";
import { redact } from "../redact.js";

const STRIX: EngineId = "strix";

export class StrixParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrixParseError";
  }
}

export interface RawStrixFinding {
  ruleId: string;
  title: string;
  description: string;
  severity: string;
  category: string;
  cwe?: string;
  file?: string;
  line?: number;
  evidence?: string;
}

/** Extract the JSON report object embedded in Strix stdout (a ```json fenced block, else a raw {…}). */
function extractReportJson(stdout: string): { findings?: unknown[]; strix_version?: string } {
  const fenced = stdout.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1);
  if (!candidate || !candidate.trim().startsWith("{")) {
    throw new StrixParseError("no JSON report found in Strix stdout");
  }
  try {
    return JSON.parse(candidate);
  } catch (err) {
    throw new StrixParseError(`Strix report is not valid JSON: ${(err as Error).message}`);
  }
}

export function parseStrixReport(stdout: string): RawStrixFinding[] {
  const report = extractReportJson(stdout);
  if (!Array.isArray(report.findings)) {
    throw new StrixParseError("Strix report has no findings array");
  }
  return report.findings.map((f) => {
    const o = f as Record<string, unknown>;
    return {
      ruleId: String(o.rule_id ?? o.ruleId ?? "unknown"),
      title: String(o.title ?? "Untitled finding"),
      description: String(o.description ?? ""),
      severity: String(o.severity ?? "info"),
      category: String(o.category ?? "unknown"),
      cwe: o.cwe ? String(o.cwe) : undefined,
      file: o.file ? String(o.file) : undefined,
      line: typeof o.line === "number" ? o.line : undefined,
      evidence: o.evidence ? String(o.evidence) : undefined,
    };
  });
}

export function mapSeverity(s: string): Severity {
  const v = s.toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "medium" || v === "moderate") return "medium";
  if (v === "low") return "low";
  if (v === "info" || v === "informational" || v === "note") return "info";
  return "info"; // safe default — never throw here
}

export function toFinding(raw: RawStrixFinding, id: string): Finding {
  const fp = fingerprint({ engine: STRIX, ruleId: raw.ruleId, file: raw.file, category: raw.category });
  return {
    id,
    engine: STRIX,
    engineFindingId: raw.ruleId,
    ruleId: raw.ruleId,
    title: raw.title,
    description: raw.description,
    severity: mapSeverity(raw.severity),
    category: raw.category,
    cwe: raw.cwe,
    file: raw.file,
    line: raw.line,
    evidence: raw.evidence ? redact(raw.evidence) : undefined,
    fingerprint: fp,
    status: "new",
    discoveredAt: new Date().toISOString(),
    raw,
  };
}
