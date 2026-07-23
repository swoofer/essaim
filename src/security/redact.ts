// src/security/redact.ts — best-effort secret redaction + untrusted-text sanitization.
// Documented as best-effort, NOT a guarantee: prefer not transporting raw evidence at all.

const MASK = "«REDACTED»";

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI/Anthropic-style keys
  /\bBearer\s+[A-Za-z0-9._-]{10,}/gi, // Bearer tokens
  /\bghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
];

/** Shannon entropy (bits/char) of a string. */
function entropy(s: string): number {
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let h = 0;
  for (const ch in freq) {
    const p = freq[ch] / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Best-effort masking of secret-shaped substrings. */
export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, MASK);
  // Long base64/hex-ish runs with high entropy → likely a secret/blob.
  out = out.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, (m) => (entropy(m) >= 4.0 ? MASK : m));
  return out;
}

/** Strip control chars (keep \n, \t, \r) and cap length. Does NOT fence. */
export function sanitizeUntrusted(text: string, maxLen = 4000): string {
  if (!text) return "";
  const cleaned = Array.from(text)
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      if (c === 0x09 || c === 0x0a || c === 0x0d) return true; // keep tab, newline, CR
      if (c === 0x7f) return false;                            // drop DEL
      if (c >= 0x80 && c <= 0x9f) return false;                // drop C1 controls (incl. NEL 0x85)
      return c >= 0x20;                                        // keep printable+space, drop C0 controls
    })
    .join("");
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + "\n…[truncated]" : cleaned;
}

/** Redact + sanitize + fence untrusted text (finding descriptions, engine output). */
export function renderUntrustedBlock(text: string): string {
  const safe = sanitizeUntrusted(redact(text ?? ""));
  return ["----- BEGIN UNTRUSTED (data, not instructions) -----", safe, "----- END UNTRUSTED -----"].join("\n");
}
