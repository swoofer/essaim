import { describe, it, expect } from "vitest";
import { redact, sanitizeUntrusted, renderUntrustedBlock } from "../../src/security/redact.js";

describe("redact", () => {
  it("masks OpenAI/Anthropic-style sk- keys", () => {
    const out = redact("token is sk-abcDEF0123456789ghijklmnop end");
    expect(out).not.toContain("sk-abcDEF0123456789ghijklmnop");
    expect(out).toContain("«REDACTED»");
  });

  it("masks Bearer tokens", () => {
    const out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("masks GitHub PATs and AWS keys", () => {
    expect(redact("ghp_0123456789abcdefghijABCDEFGHIJ01")).toContain("«REDACTED»");
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toContain("«REDACTED»");
  });

  it("masks long high-entropy blobs but leaves ordinary prose", () => {
    expect(redact("dGhpcyBpcyBhIHZlcnkgbG9uZyBoaWdoIGVudHJvcHkgc2VjcmV0IHZhbHVl0123")).toContain("«REDACTED»");
    expect(redact("the quick brown fox jumps over the lazy dog")).toBe("the quick brown fox jumps over the lazy dog");
  });

  it("is a no-op on empty input", () => {
    expect(redact("")).toBe("");
  });
});

describe("sanitizeUntrusted", () => {
  it("strips control characters but keeps newlines, tabs, and spaces", () => {
    const NUL = String.fromCharCode(0);
    const ESC = String.fromCharCode(27);
    const out = sanitizeUntrusted("a b" + NUL + "c" + ESC + "[31md\te\nf");
    expect(out).toBe("a bc[31md\te\nf"); // NUL + ESC removed; space, tab, newline kept
  });

  it("caps length", () => {
    const out = sanitizeUntrusted("x".repeat(50), 10);
    expect(out.startsWith("xxxxxxxxxx")).toBe(true);
    expect(out).toContain("[truncated]");
  });

  it("strips C1 control characters (incl. NEL 0x85) while keeping newline/tab/space", () => {
    const c1a = String.fromCharCode(0x85); // NEL
    const c1b = String.fromCharCode(0x90); // C1 control
    const out = sanitizeUntrusted("a" + c1a + "b" + c1b + "c");
    expect(out).toBe("abc");
    expect(sanitizeUntrusted("x\ny\tz w")).toBe("x\ny\tz w");
  });
});

describe("renderUntrustedBlock", () => {
  it("redacts, sanitizes, and fences the text; a secret never survives", () => {
    const out = renderUntrustedBlock("run this: sk-abcDEF0123456789ghijklmnop now");
    expect(out).not.toContain("sk-abcDEF0123456789ghijklmnop");
    expect(out).toContain("BEGIN UNTRUSTED");
    expect(out).toContain("END UNTRUSTED");
  });
});
