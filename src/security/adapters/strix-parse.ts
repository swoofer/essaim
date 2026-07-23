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

  const findings: Finding[] = [];
  for (const item of parsed) {
    try {
      findings.push(mapVulnerabilityItem(item));
    } catch (err) {
      // One malformed element must not discard the rest of a real capture.
      // eslint-disable-next-line no-console
      console.warn("security: skipping unparseable vulnerabilities.json element", (err as Error).message);
    }
  }
  return findings;
}

function mapVulnerabilityItem(item: unknown): Finding {
  if (item == null || typeof item !== "object") {
    throw new StrixParseError("vulnerabilities.json element is not an object");
  }
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

  // Compose from description + impact + technical_analysis (design §38); redaction stays
  // downstream at ingest, not here.
  const description = [r.description, r.impact, r.technical_analysis]
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .join("\n\n");

  return {
    id: randomUUID(),
    engine: STRIX,
    engineFindingId: String(r.id),
    ruleId,
    title: String(r.title ?? "Untitled"),
    description,
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
    const results = Array.isArray(run.results) ? (run.results as unknown[]) : [];
    for (const result of results) {
      try {
        findings.push(mapSarifResult(result));
      } catch (err) {
        // One malformed element must not discard the rest of a real capture.
        // eslint-disable-next-line no-console
        console.warn("security: skipping unparseable findings.sarif result", (err as Error).message);
      }
    }
  }
  return findings;
}

function mapSarifResult(result: unknown): Finding {
  if (result == null || typeof result !== "object") {
    throw new StrixParseError("findings.sarif result is not an object");
  }
  const res = result as SarifResult;
  const messageText = String(res.message?.text ?? "");
  const ruleId = res.ruleId ? String(res.ruleId) : slugify(messageText);

  let baseSeverity = sarifLevelToSeverity(res.level);
  baseSeverity = refineSarifSeverity(baseSeverity, res.properties?.["security-severity"]);

  const physLoc = res.locations?.[0]?.physicalLocation;
  const uri = physLoc?.artifactLocation?.uri;
  const file = typeof uri === "string" ? normalizeSarifUri(uri) : undefined;
  const line = typeof physLoc?.region?.startLine === "number" ? physLoc.region.startLine : undefined;
  const endLine = typeof physLoc?.region?.endLine === "number" ? physLoc.region.endLine : undefined;

  const cweProp = res.properties?.cwe;
  const cwe = cweProp ? String(cweProp) : undefined;
  const category = ruleId || cwe || "unknown";

  const fp = fingerprint({ engine: STRIX, ruleId, file: file ?? "", category });

  return {
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
    raw: res,
  };
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

  // Index SARIF findings by ruleId and by title, preserving order, for a 1:1 consume: each SARIF
  // finding backfills at most one json finding (two json findings sharing a ruleId must NOT both
  // draw from the same sarif entry, which would collide their recomputed fingerprints).
  const byRuleId = new Map<string, number[]>();
  const byTitle = new Map<string, number[]>();
  sarifFindings.forEach((sf, i) => {
    const ruleList = byRuleId.get(sf.ruleId) ?? [];
    ruleList.push(i);
    byRuleId.set(sf.ruleId, ruleList);
    const titleKey = sf.title.toLowerCase();
    const titleList = byTitle.get(titleKey) ?? [];
    titleList.push(i);
    byTitle.set(titleKey, titleList);
  });

  const used = new Set<number>();
  const pickUnused = (indices: number[] | undefined): number | undefined => indices?.find((i) => !used.has(i));

  return jsonFindings.map((jf) => {
    if (jf.file) return jf;
    const idx = pickUnused(byRuleId.get(jf.ruleId)) ?? pickUnused(byTitle.get(jf.title.toLowerCase()));
    if (idx === undefined) return jf;
    const match = sarifFindings[idx];
    if (!match.file) return jf;
    used.add(idx);
    // Recompute — never reuse the parse-time fingerprint, which was hashed from the (absent) file.
    const fp = fingerprint({ engine: STRIX, ruleId: jf.ruleId, file: match.file ?? "", category: jf.category });
    return { ...jf, file: match.file, line: match.line, endLine: match.endLine, fingerprint: fp };
  });
}
