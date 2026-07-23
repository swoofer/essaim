import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveEngineSecrets } from "../../src/security/secrets.js";

describe("resolveEngineSecrets", () => {
  it("returns {} when no file is given", () => {
    expect(resolveEngineSecrets(undefined)).toEqual({});
  });

  it("returns {} when the file does not exist", () => {
    expect(resolveEngineSecrets(join(tmpdir(), "does-not-exist-essaim-secrets.env"))).toEqual({});
  });

  it("parses KEY=VALUE lines, ignoring comments and blanks", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-"));
    const f = join(dir, "secrets.env");
    writeFileSync(f, "# comment\nLLM_API_KEY=sk-abc123\n\nSTRIX_LLM=anthropic/claude\n");
    expect(resolveEngineSecrets(f)).toEqual({ LLM_API_KEY: "sk-abc123", STRIX_LLM: "anthropic/claude" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("ignores malformed lines (no '=' or leading '=')", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-"));
    const f = join(dir, "secrets.env");
    writeFileSync(f, "NOEQUALS\n=leadingeq\nOK=value\n");
    expect(resolveEngineSecrets(f)).toEqual({ OK: "value" });
    rmSync(dir, { recursive: true, force: true });
  });
});
