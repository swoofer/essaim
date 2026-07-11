import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadTemplates } from "../../src/template-loader.js";
import { listTemplates } from "../../src/orchestrator/template-engine.js";

describe("template-loader", () => {
  it("charge les 14 templates stock depuis le catalogue", () => {
    const t = loadTemplates();
    expect(Object.keys(t).length).toBeGreaterThanOrEqual(14);
    expect(t.raid.agents[0].preset).toBe("raid");
    expect(t.maitre.agents.map((a) => a.preset)).toEqual(["maitre-lead", "maitre-worker"]);
  });

  it("rejette un template sans champ requis", () => {
    const proj = join(tmpdir(), `essaim-tpl-bad-${process.pid}`);
    mkdirSync(join(proj, ".essaim", "templates"), { recursive: true });
    writeFileSync(join(proj, ".essaim", "templates", "bad.yaml"), "name: Bad\n");
    expect(() => loadTemplates(proj)).toThrow(/missing required field/);
    rmSync(proj, { recursive: true, force: true });
  });

  it("les templates projet écrasent le catalogue", () => {
    const proj = join(tmpdir(), `essaim-tpl-ovr-${process.pid}`);
    mkdirSync(join(proj, ".essaim", "templates"), { recursive: true });
    const raid = { ...loadTemplates().raid, timeout_minutes: 99 };
    writeFileSync(join(proj, ".essaim", "templates", "raid.yaml"), JSON.stringify(raid));
    expect(loadTemplates(proj).raid.timeout_minutes).toBe(99);
    rmSync(proj, { recursive: true, force: true });
  });

  it("un template projet-only (id absent du catalogue) apparaît dans loadTemplates/listTemplates avec projectPath, absent sans", () => {
    const proj = join(tmpdir(), `essaim-tpl-new-${process.pid}`);
    mkdirSync(join(proj, ".essaim", "templates"), { recursive: true });
    const custom = {
      name: "Custom Proof",
      description: "Project-only template used to prove pre-flight resolution",
      phase: 1,
      workspace: "worktree",
      stagger: { mode: "fixed", delay: [0, 0] },
      timeout_minutes: 10,
      metrics: ["files_changed"],
      compare_mode: false,
      agents: [
        { idPrefix: "custom", namePrefix: "Custom", preset: "raid", profile: "codeur", count: 1 },
      ],
    };
    writeFileSync(join(proj, ".essaim", "templates", "custom-proof.yaml"), JSON.stringify(custom));

    expect(loadTemplates(proj)["custom-proof"]).toBeDefined();
    expect(loadTemplates()["custom-proof"]).toBeUndefined();

    expect(listTemplates(proj).some((t) => t.id === "custom-proof")).toBe(true);
    expect(listTemplates().some((t) => t.id === "custom-proof")).toBe(false);

    rmSync(proj, { recursive: true, force: true });
  });

  it("mekova-implement wires lead + workers", () => {
    const t = loadTemplates();
    expect(t["mekova-implement"].agents.map((a) => a.preset)).toEqual([
      "mekova-implement-lead",
      "mekova-implement-worker",
    ]);
    expect(t["mekova-implement"].agents[1].count).toBe("dynamic");
  });
});
