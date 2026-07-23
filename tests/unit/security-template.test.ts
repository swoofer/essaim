import { describe, it, expect } from "vitest";
import { buildProject, listTemplates } from "../../src/orchestrator/template-engine.js";
import type { ProjectContext } from "../../src/orchestrator/types.js";

const CTX: ProjectContext = {
  path: "/tmp/p", language: "typescript", source_dirs: ["src"], test_dirs: ["tests"],
  test_command: "npx vitest run", source_files: ["src/a.ts"], has_git: true, is_clean: true,
  modules: ["src"], applicable_templates: [],
};

describe("sentinelle template", () => {
  it("is registered and resolvable via BCE (validates preset + behaviors end-to-end)", () => {
    expect(listTemplates().map((t) => t.id)).toContain("sentinelle");
  });

  it("buildProject assembles agents with a security-fix execute phase", () => {
    const project = buildProject("sentinelle", CTX);
    expect(project.agents.length).toBeGreaterThan(0);
    const exec = project.agents[0].phases?.find((p) => p.name === "execute");
    expect(exec).toBeDefined();
    expect(exec!.prompt).toContain("Correctif de sécurité"); // from security-fix section 030
  });
});
