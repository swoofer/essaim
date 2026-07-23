import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupSecurity } from "../../src/security/setup.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secsetup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("setupSecurity", () => {
  it("scaffolds security.yaml (affirmed:false) and .security-env if absent", () => {
    setupSecurity(dir);
    const cfg = readFileSync(join(dir, ".essaim", "security.yaml"), "utf8");
    expect(cfg).toContain("affirmed: false");
    expect(existsSync(join(dir, ".security-env"))).toBe(true);
  });

  it("patches .gitignore: ignores security.yaml/.security-env/reports but KEEPS baseline.json", () => {
    setupSecurity(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain(".essaim/security.yaml");
    expect(gi).toContain(".security-env");
    expect(gi).toContain("reports/security/");
    expect(gi).toContain(".essaim/security/*"); // /* (contents), so the negation below actually works
    expect(gi).toContain("!.essaim/security/baseline.json"); // baseline stays committed
  });

  it("is idempotent — does not duplicate .gitignore lines or overwrite an existing config", () => {
    writeFileSync(join(dir, ".essaim") + ".placeholder", ""); // ensure clean start
    setupSecurity(dir);
    const cfgBefore = readFileSync(join(dir, ".essaim", "security.yaml"), "utf8");
    setupSecurity(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi.split(".security-env").length - 1).toBe(1); // appears once
    expect(readFileSync(join(dir, ".essaim", "security.yaml"), "utf8")).toBe(cfgBefore); // untouched
  });
});
