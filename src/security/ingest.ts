// src/security/ingest.ts — turn normalized Findings into coordinator threads via the EXISTING
// /api/announce. Redaction + sanitization happen HERE (the single mandatory chokepoint).
import { basename } from "node:path";
import type { Finding } from "./types.js";
import { toSubjectSeverity } from "./finding.js";
import { sanitizeUntrusted, renderUntrustedBlock, redact } from "./redact.js";
import { authHeaders } from "../coordinator-auth.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

export interface AnnouncePayload {
  agent_id: string;
  subject: string;
  plan: string;
  target_files: string[];
  target_modules: string[];
  target_symbols: string[];
  keep_open: true;
}

export interface IngestResult {
  posted: { threadId: string; finding: Finding }[];
  failed: number;
}

/** Sanitize an engine-derived metadata field (file path, category, cwe, ...) — untrusted, not fenced.
 *  Unlike `sanitizeUntrusted` (which deliberately keeps \n/\t/\r for fenced blocks), these fields land
 *  UNFENCED in single-line plan/subject/target_* fields — so CR/LF/TAB are collapsed to a single space
 *  to prevent a newline from injecting fake lines above the "BEGIN UNTRUSTED" fence. */
function safeMeta(value: unknown, maxLen: number): string {
  const s = sanitizeUntrusted(String(value ?? ""), maxLen);
  // Collapse every newline-class codepoint to a single space: TAB(0x09), LF(0x0A), CR(0x0D),
  // NEL(0x85), LINE SEPARATOR(0x2028), PARAGRAPH SEPARATOR(0x2029). Pure numeric codepoint
  // comparisons only -- no literal separator characters, no backslash-u escapes in source.
  const NEWLINE_CLASS = new Set([0x09, 0x0a, 0x0d, 0x85, 0x2028, 0x2029]);
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += NEWLINE_CLASS.has(c) ? " " : ch;
  }
  return out.replace(/ +/g, " ");
}

/** Sanitize + format an engine-derived file:line location. `line` is coerced defensively. */
function safeLocation(f: Finding): string {
  if (!f.file) return "";
  const file = safeMeta(f.file, 200);
  const line = typeof f.line === "number" && Number.isFinite(f.line) ? `:${f.line}` : "";
  return `${file}${line}`;
}

/** Redacted + sanitized context for the fixer. Raw PoC never included — only a fenced summary + fingerprint. */
export function renderPlan(f: Finding): string {
  const safeCwe = f.cwe ? safeMeta(f.cwe, 40) : "";
  const safeCategory = safeMeta(f.category, 80);
  const loc = safeLocation(f);
  const lines = [
    `Severity: ${f.severity}${safeCwe ? ` (${safeCwe})` : ""}`,
    `Category: ${safeCategory}`,
    loc ? `Location: ${loc}` : "",
    "",
    "Description:",
    renderUntrustedBlock(f.description),
    f.remediation ? `\nRemediation hint:\n${renderUntrustedBlock(f.remediation)}` : "",
    f.evidence ? `\nEvidence (redacted):\n${renderUntrustedBlock(f.evidence)}` : "",
    "",
    `[fingerprint:${f.fingerprint}]`,
  ];
  return lines.filter((l) => l !== "").join("\n");
}

export function findingToAnnounce(f: Finding, agentId: string): AnnouncePayload {
  const loc = safeLocation(f);
  const safeTitle = safeMeta(redact(f.title), 160);
  const subject = `${toSubjectSeverity(f.severity)}: ${safeTitle}${loc ? ` (${loc})` : ""}`.slice(0, 200);
  return {
    agent_id: agentId,
    subject,
    plan: renderPlan(f),
    target_files: f.file ? [safeMeta(f.file, 400)] : [],
    target_modules: [],
    target_symbols: f.symbol ? [safeMeta(f.symbol, 200)] : [],
    keep_open: true,
  };
}

export function syntheticAuthorId(projectPath: string): string {
  return `security-scanner@${basename(projectPath)}`;
}

async function coordPost(url: string, body: unknown): Promise<Record<string, unknown>> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`coordinator ${url} -> ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/** Register the poster-only synthetic author (needed for the composite-PK FK on announce). */
export async function registerSyntheticAuthor(coordinatorUrl: string, agentId: string): Promise<void> {
  await coordPost(`${coordinatorUrl}/api/register`, { agent_id: agentId, name: agentId, modules: [] });
}

export async function ingestFindings(coordinatorUrl: string, agentId: string, findings: Finding[]): Promise<IngestResult> {
  const posted: { threadId: string; finding: Finding }[] = [];
  let failed = 0;
  for (const f of findings) {
    try {
      const data = await coordPost(`${coordinatorUrl}/api/announce`, findingToAnnounce(f, agentId));
      posted.push({ threadId: String(data.thread_id ?? ""), finding: f });
    } catch (err) {
      failed++;
      log.error("security: failed to ingest finding", { fingerprint: f.fingerprint, err: (err as Error).message });
    }
  }
  return { posted, failed };
}
