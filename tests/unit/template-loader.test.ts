import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadTemplates } from "../../src/template-loader.js";

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
});
