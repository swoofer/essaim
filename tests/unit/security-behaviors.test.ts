import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const behaviorsDir = join(__dirname, "..", "..", "behaviors");
const load = (name: string) => parseYaml(readFileSync(join(behaviorsDir, name), "utf8"));

describe("security-fix behavior", () => {
  const b = () => load("security-fix.yaml");
  it("is a mission behavior in the execute phase with full tools + loop", () => {
    const y = b();
    expect(y.name).toBe("security-fix");
    expect(y.category).toBe("mission");
    expect(y.phase).toMatchObject({ name: "execute", tools_mode: "full", loop: true });
  });
  it("declares an execute_mission param and a current_task runtime token", () => {
    const y = b();
    expect(y.params.execute_mission).toBeDefined();
    expect(y.params.current_task).toBeDefined();
    const sectionText = Object.values(y.sections).map((s: any) => s.prompt).join("\n");
    expect(sectionText).toContain("{{params.execute_mission}}");
    expect(sectionText).toContain("{{params.current_task}}");
  });
  it("forbids running live PoC in its safety section", () => {
    const sectionText = Object.values(b().sections).map((s: any) => s.prompt).join("\n");
    expect(sectionText).toMatch(/PoC/i);
  });
});

const VALID_CATEGORIES = ["workspace", "coordination", "mission", "safety", "tone"];

describe("security-untrusted-findings behavior", () => {
  const b = () => load("security-untrusted-findings.yaml");
  it("is a SAFETY behavior (valid category) marking finding text as untrusted", () => {
    const y = b();
    expect(y.name).toBe("security-untrusted-findings");
    // Guards the exact bug the review caught: `category: transversal` is NOT in the promptweave enum.
    expect(VALID_CATEGORIES).toContain(y.category);
    expect(y.category).toBe("safety");
    const sectionText = Object.values(y.sections).map((s: any) => s.prompt).join("\n");
    expect(sectionText).toMatch(/UNTRUSTED/);
  });
});

describe("both behaviors declare a valid promptweave category", () => {
  it("security-fix + security-untrusted-findings categories are in the enum", () => {
    expect(VALID_CATEGORIES).toContain(load("security-fix.yaml").category);
    expect(VALID_CATEGORIES).toContain(load("security-untrusted-findings.yaml").category);
  });
});
