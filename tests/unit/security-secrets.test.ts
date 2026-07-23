import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { resolveEngineSecrets, writeEnvFile, removeEnvFile } from "../../src/security/secrets.js";

const created: (string | undefined)[] = [];
afterEach(() => {
  for (const p of created) removeEnvFile(p);
  created.length = 0;
});

describe("resolveEngineSecrets", () => {
  it("returns {} when no file is given", () => {
    expect(resolveEngineSecrets(undefined)).toEqual({});
  });

  it("parses KEY=VALUE lines, ignoring comments and blanks", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-"));
    const f = join(dir, "secrets.env");
    writeFileSync(f, "# comment\nLLM_API_KEY=sk-abc123\n\nSTRIX_LLM=anthropic/claude\n");
    expect(resolveEngineSecrets(f)).toEqual({ LLM_API_KEY: "sk-abc123", STRIX_LLM: "anthropic/claude" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeEnvFile", () => {
  it("returns undefined for empty secrets", () => {
    expect(writeEnvFile({})).toBeUndefined();
  });

  it("writes KEY=VALUE lines to a temp file (0600 on POSIX)", () => {
    const p = writeEnvFile({ LLM_API_KEY: "sk-abc", STRIX_LLM: "anthropic/claude" });
    created.push(p);
    expect(p).toBeTruthy();
    expect(existsSync(p!)).toBe(true);
    const body = readFileSync(p!, "utf8");
    expect(body).toContain("LLM_API_KEY=sk-abc");
    expect(body).toContain("STRIX_LLM=anthropic/claude");
    if (platform() !== "win32") {
      expect(statSync(p!).mode & 0o777).toBe(0o600);
    }
  });
});

describe("removeEnvFile", () => {
  it("is a no-op on undefined and removes an existing file", () => {
    expect(() => removeEnvFile(undefined)).not.toThrow();
    const p = writeEnvFile({ K: "v" })!;
    removeEnvFile(p);
    expect(existsSync(p)).toBe(false);
  });

  it("also removes the per-scan parent temp dir (not just the file)", () => {
    const p = writeEnvFile({ K: "v" })!;
    const dir = dirname(p);
    expect(existsSync(dir)).toBe(true);
    removeEnvFile(p);
    expect(existsSync(dir)).toBe(false);
  });
});
