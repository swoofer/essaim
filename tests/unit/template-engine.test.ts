import { describe, it, expect } from "vitest";
import { buildProject, listTemplates } from "../../src/orchestrator/template-engine.js";
import type { ProjectContext } from "../../src/orchestrator/types.js";

const mockContext: ProjectContext = {
  path: "/home/user/my-app",
  language: "typescript",
  source_dirs: ["src"],
  test_dirs: ["tests"],
  test_command: "npx vitest run",
  source_files: ["src/auth.ts", "src/users.ts", "src/api.ts"],
  has_git: true,
  is_clean: true,
  modules: ["auth", "users", "api"],
  applicable_templates: ["melee", "debat", "maitre"],
};

describe("buildProject", () => {
  it("builds melee template with project context", () => {
    const project = buildProject("melee", mockContext);
    expect(project.id).toContain("melee");
    expect(project.agents.length).toBeGreaterThan(0);
    expect(project.workspace.base).toBe("/home/user/my-app");
    // BCE injects modules rather than individual file paths
    expect(project.agents[0].prompt).toContain("auth");
  });

  it("throws on unknown template", () => {
    expect(() => buildProject("nonexistent", mockContext)).toThrow();
  });

  it("adapts agent count to project size", () => {
    const small = { ...mockContext, source_files: ["src/a.ts"] };
    const large = { ...mockContext, source_files: Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`) };
    const pSmall = buildProject("melee", small);
    const pLarge = buildProject("melee", large);
    expect(pSmall.agents.length).toBeLessThanOrEqual(pLarge.agents.length);
  });

  it("per-module accepte une liste --modules explicite sans dossiers existants (greenfield)", () => {
    // bridge.ts fait l'expansion depuis context.modules SANS scan disque —
    // ce test est un VERROU de non-régression (comportement déjà correct).
    const ctx = { ...mockContext, modules: ["ecran-a", "ecran-b"] };
    const project = buildProject("migrate-phase2", ctx);
    const migrators = project.agents.filter((a) => a.id.startsWith("migrator"));
    expect(migrators.map((a) => a.id)).toEqual(["migrator-ecran-a", "migrator-ecran-b"]);
  });
});

describe("listTemplates", () => {
  it("returns all available templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    expect(templates.some(t => t.id === "melee")).toBe(true);
  });
});

