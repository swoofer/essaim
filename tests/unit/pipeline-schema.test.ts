import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadPipeline } from "../../src/pipeline/schema.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "essaim-pipeline-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

describe("loadPipeline — parsing & validation", () => {
  it("parses a valid pipeline", () => {
    const p = write(
      "pipeline.yaml",
      `name: decouverte
steps:
  - name: analyse
    template: mekova-decouverte
    project: ../specs
    set:
      discovery-synth.projet: commandes
    timeout_minutes: 20
  - name: proto
    template: mekova-prototype
    project: ../code
    modules: [a, b]
`,
    );
    const def = loadPipeline(p);
    expect(def.name).toBe("decouverte");
    expect(def.steps).toHaveLength(2);
    expect(def.steps[0]!.name).toBe("analyse");
    expect(def.steps[0]!.template).toBe("mekova-decouverte");
    expect(def.steps[0]!.project).toBe("../specs");
    expect(def.steps[0]!.set).toEqual({ "discovery-synth.projet": "commandes" });
    expect(def.steps[0]!.timeout_minutes).toBe(20);
    expect(def.steps[1]!.modules).toEqual(["a", "b"]);
  });

  it("throws when name is missing", () => {
    const p = write("p.yaml", `steps:\n  - name: a\n    template: t\n    project: .\n`);
    expect(() => loadPipeline(p)).toThrow(/name/i);
  });

  it("throws when steps is missing", () => {
    const p = write("p.yaml", `name: x\n`);
    expect(() => loadPipeline(p)).toThrow(/steps/i);
  });

  it("throws when steps is empty", () => {
    const p = write("p.yaml", `name: x\nsteps: []\n`);
    expect(() => loadPipeline(p)).toThrow(/steps/i);
  });

  it("throws when a step is missing name", () => {
    const p = write("p.yaml", `name: x\nsteps:\n  - template: t\n    project: .\n`);
    expect(() => loadPipeline(p)).toThrow(/name/i);
  });

  it("throws when a step is missing template", () => {
    const p = write("p.yaml", `name: x\nsteps:\n  - name: s\n    project: .\n`);
    expect(() => loadPipeline(p)).toThrow(/template/i);
  });

  it("throws when a step is missing project", () => {
    const p = write("p.yaml", `name: x\nsteps:\n  - name: s\n    template: t\n`);
    expect(() => loadPipeline(p)).toThrow(/project/i);
  });

  it("parses modules_file one id per line, trimmed, empties skipped", () => {
    writeFileSync(join(dir, "mods.txt"), "  a \n\n b\n\n\nc  \n", "utf-8");
    const p = write(
      "p.yaml",
      `name: x\nsteps:\n  - name: s\n    template: t\n    project: .\n    modules_file: mods.txt\n`,
    );
    const def = loadPipeline(p);
    expect(def.steps[0]!.modules).toEqual(["a", "b", "c"]);
  });

  it("resolves modules_file relative to the pipeline file's dir", () => {
    writeFileSync(join(dir, "mods.txt"), "x\ny\n", "utf-8");
    const p = write(
      "p.yaml",
      `name: x\nsteps:\n  - name: s\n    template: t\n    project: .\n    modules_file: mods.txt\n`,
    );
    const def = loadPipeline(p);
    expect(def.steps[0]!.modules).toEqual(["x", "y"]);
  });

  it("throws when both modules and modules_file are set", () => {
    writeFileSync(join(dir, "mods.txt"), "a\n", "utf-8");
    const p = write(
      "p.yaml",
      `name: x\nsteps:\n  - name: s\n    template: t\n    project: .\n    modules: [a]\n    modules_file: mods.txt\n`,
    );
    expect(() => loadPipeline(p)).toThrow(/modules/i);
  });

  it("keeps set_file entries as file paths", () => {
    const p = write(
      "p.yaml",
      `name: x\nsteps:\n  - name: s\n    template: t\n    project: .\n    set_file:\n      user-brief.brief: tmp/brief.txt\n`,
    );
    const def = loadPipeline(p);
    expect(def.steps[0]!.set_file).toEqual({ "user-brief.brief": "tmp/brief.txt" });
  });

  it("parses hooks before/after", () => {
    const p = write(
      "p.yaml",
      `name: x\nsteps:\n  - name: s\n    template: t\n    project: .\n    hooks:\n      before: ["echo hi"]\n      after: ["npm run build"]\n`,
    );
    const def = loadPipeline(p);
    expect(def.steps[0]!.hooks).toEqual({ before: ["echo hi"], after: ["npm run build"] });
  });
});
