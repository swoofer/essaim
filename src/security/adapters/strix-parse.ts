// src/security/adapters/strix-parse.ts — the ONE unit that depends on Strix's output format.
// Isolate all format brittleness here. If a real capture shows a different schema, only the
// mapping functions below change.
//
// Real Strix (strix-agent v1.3.1, verified from source — see
// docs/superpowers/specs/2026-07-23-strix-adapter-real-invocation-design.md) writes FILES, not
// stdout JSON: `vulnerabilities.json` (top-level JSON array of report dicts, primary/rich) and
// `findings.sarif` (SARIF 2.1.0, normalized cross-engine layer).
import { randomUUID } from "node:crypto";
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

export function mapSeverity(s: string): Severity {
  const v = s.toLowerCase();
  if (v === "critical") return "critical";
  if (v === "high") return "high";
  if (v === "medium" || v === "moderate") return "medium";
  if (v === "low") return "low";
  if (v === "info" || v === "informational" || v === "note") return "info";
  return "info"; // safe default — never throw here
}

/** Slugify a title into a stable-ish fallback rule identifier. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------------------------
// REAL Strix schema (verified from source). Parses vulnerabilities.json + findings.sarif files.
// ---------------------------------------------------------------------------------------------

interface RawCodeLocation {
  file?: unknown;
  start_line?: unknown;
  end_line?: unknown;
  snippet?: unknown;
  label?: unknown;
}

/** Derive a STABLE ruleId. r.id ("vuln-0001") is per-run sequential, NOT stable — never use it. */
function stableRuleId(r: Record<string, unknown>): string {
  if (r.cwe) return String(r.cwe).toLowerCase();
  return slugify(String(r.title ?? "untitled"));
}

/**
 * Parse `vulnerabilities.json` — a top-level JSON array of Strix report dicts.
 * Primary, rich source of Finding data.
 */
export function parseStrixVulnerabilitiesJson(text: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new StrixParseError(`vulnerabilities.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new StrixParseError("vulnerabilities.json must be a top-level JSON array");
  }

  return parsed.map((item): Finding => {
    const r = item as Record<string, unknown>;
    const ruleId = stableRuleId(r);
    const cwe = r.cwe ? String(r.cwe) : undefined;
    const category = String(r.cwe || r.finding_class || "unknown");

    const codeLocations = Array.isArray(r.code_locations) ? (r.code_locations as RawCodeLocation[]) : [];
    const cl = codeLocations[0];
    const file = cl?.file !== undefined && cl?.file !== null ? String(cl.file) : undefined;
    const line = cl && typeof cl.start_line === "number" ? cl.start_line : undefined;
    const endLine = cl && typeof cl.end_line === "number" ? cl.end_line : undefined;

    const evidenceSrc = r.evidence ?? r.poc_description;
    const evidence = evidenceSrc !== undefined && evidenceSrc !== null && evidenceSrc !== "" ? redact(String(evidenceSrc)) : undefined;

    const remediation = Array.isArray(r.remediation_steps)
      ? (r.remediation_steps as unknown[]).map(String).join("\n")
      : r.remediation_steps
        ? String(r.remediation_steps)
        : undefined;

    const fp = fingerprint({ engine: STRIX, ruleId, file: file ?? "", category });

    return {
      id: randomUUID(),
      engine: STRIX,
      engineFindingId: String(r.id),
      ruleId,
      title: String(r.title ?? "Untitled"),
      description: String(r.description ?? r.technical_analysis ?? ""),
      severity: mapSeverity(String(r.severity ?? "info")),
      category,
      cwe,
      file,
      line,
      endLine,
      evidence,
      remediation,
      fingerprint: fp,
      status: "new",
      discoveredAt: new Date().toISOString(),
      raw: r,
    };
  });
}

interface SarifPhysicalLocation {
  artifactLocation?: { uri?: unknown };
  region?: { startLine?: unknown; endLine?: unknown };
}

interface SarifResult {
  ruleId?: unknown;
  level?: unknown;
  message?: { text?: unknown };
  locations?: Array<{ physicalLocation?: SarifPhysicalLocation }>;
  properties?: Record<string, unknown>;
}

/** Strip a leading `file://` or `./` from a SARIF artifact URI. */
function normalizeSarifUri(uri: string): string {
  return uri.replace(/^file:\/\//, "").replace(/^\.\//, "");
}

/** Refine a level-derived severity using CVSS-like `security-severity` (numeric string), if present. */
function refineSarifSeverity(base: Severity, securitySeverity: unknown): Severity {
  if (typeof securitySeverity !== "string") return base;
  const score = Number(securitySeverity);
  if (Number.isNaN(score)) return base;
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score > 0) return "low";
  return "info";
}

function sarifLevelToSeverity(level: unknown): Severity {
  const v = typeof level === "string" ? level.toLowerCase() : "";
  if (v === "error") return "high";
  if (v === "warning") return "medium";
  if (v === "note") return "low";
  return "info"; // "none" / absent
}

/** Parse `findings.sarif` (SARIF 2.1.0). Normalized cross-engine layer / file-line backfill source. */
export function parseStrixSarif(text: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new StrixParseError(`findings.sarif is not valid JSON: ${(err as Error).message}`);
  }
  const doc = parsed as { runs?: unknown };
  if (!doc || !Array.isArray(doc.runs)) {
    throw new StrixParseError("findings.sarif is not a valid SARIF document (missing runs[])");
  }

  const findings: Finding[] = [];
  for (const run of doc.runs as Array<{ results?: unknown }>) {
    const results = Array.isArray(run.results) ? (run.results as SarifResult[]) : [];
    for (const result of results) {
      const messageText = String(result.message?.text ?? "");
      const ruleId = result.ruleId ? String(result.ruleId) : slugify(messageText);

      let baseSeverity = sarifLevelToSeverity(result.level);
      baseSeverity = refineSarifSeverity(baseSeverity, result.properties?.["security-severity"]);

      const physLoc = result.locations?.[0]?.physicalLocation;
      const uri = physLoc?.artifactLocation?.uri;
      const file = typeof uri === "string" ? normalizeSarifUri(uri) : undefined;
      const line = typeof physLoc?.region?.startLine === "number" ? physLoc.region.startLine : undefined;
      const endLine = typeof physLoc?.region?.endLine === "number" ? physLoc.region.endLine : undefined;

      const cweProp = result.properties?.cwe;
      const cwe = cweProp ? String(cweProp) : undefined;
      const category = ruleId || cwe || "unknown";

      const fp = fingerprint({ engine: STRIX, ruleId, file: file ?? "", category });

      findings.push({
        id: randomUUID(),
        engine: STRIX,
        engineFindingId: undefined,
        ruleId,
        title: messageText,
        description: messageText,
        severity: baseSeverity,
        category,
        cwe,
        file,
        line,
        endLine,
        evidence: undefined,
        fingerprint: fp,
        status: "new",
        discoveredAt: new Date().toISOString(),
        raw: result,
      });
    }
  }
  return findings;
}

/**
 * Reconcile the two Strix output files: `vulnerabilities.json` is primary; `findings.sarif` backfills
 * file/line on json findings that lack them (matched by ruleId, falling back to title). Never
 * duplicates entries. If jsonFindings is empty but sarifFindings is not, falls back to sarifFindings
 * (better a normalized-only view than nothing).
 */
export function reconcileStrixFindings(jsonFindings: Finding[], sarifFindings: Finding[]): Finding[] {
  if (jsonFindings.length === 0 && sarifFindings.length > 0) {
    return sarifFindings;
  }
  if (sarifFindings.length === 0) {
    return jsonFindings;
  }

  const byRuleId = new Map<string, Finding>();
  const byTitle = new Map<string, Finding>();
  for (const sf of sarifFindings) {
    if (!byRuleId.has(sf.ruleId)) byRuleId.set(sf.ruleId, sf);
    const titleKey = sf.title.toLowerCase();
    if (!byTitle.has(titleKey)) byTitle.set(titleKey, sf);
  }

  return jsonFindings.map((jf) => {
    if (jf.file) return jf;
    const match = byRuleId.get(jf.ruleId) ?? byTitle.get(jf.title.toLowerCase());
    if (!match || !match.file) return jf;
    return { ...jf, file: match.file, line: match.line, endLine: match.endLine };
  });
}
