import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const preset = () => parseYaml(readFileSync(join(__dirname, "..", "..", "presets", "sentinelle.yaml"), "utf8"));

describe("sentinelle preset", () => {
  it("is a codeur preset that includes security-fix + safety behaviors and NO discover/review phase", () => {
    const p = preset();
    expect(p.name).toBe("sentinelle");
    expect(p.profile).toBe("codeur");
    expect(p.behaviors).toContain("security-fix");
    expect(p.behaviors).toContain("security-untrusted-findings");
    expect(p.behaviors).toContain("worktree-isolation");
    expect(p.behaviors).not.toContain("phase-discover"); // adapter is the discovery source
    expect(p.behaviors).not.toContain("phase-review"); // v1: nothing to cross-engine-dedup
  });
  it("supplies the execute_mission param to security-fix", () => {
    const p = preset();
    expect(p.params["security-fix"].execute_mission).toBeTruthy();
    expect(p.params["security-fix"].effort).toBe("high");
  });
});
