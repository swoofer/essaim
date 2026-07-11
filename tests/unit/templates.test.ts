// tests/unit/templates.test.ts
// Legacy template factory tests removed — BCE is the sole prompt source.
// Coverage for template generation is handled by bce-*.test.ts and template-engine.test.ts.
import { describe, it, expect } from "vitest";
import { buildProject, listTemplates } from "../../src/orchestrator/template-engine.js";
import type { ProjectContext } from "../../src/orchestrator/types.js";

const MOCK_CONTEXT: ProjectContext = {
  path: "/tmp/test-project",
  language: "typescript",
  source_dirs: ["src"],
  test_dirs: ["tests"],
  test_command: "npx vitest run",
  source_files: [
    "src/auth/middleware.ts",
    "src/auth/tokens.ts",
    "src/api/routes.ts",
    "src/api/handlers.ts",
    "src/db/connection.ts",
    "src/db/models.ts",
  ],
  has_git: true,
  is_clean: true,
  modules: ["src/auth", "src/api", "src/db"],
  applicable_templates: ["melee", "chaine", "carrefour", "maitre", "revue", "relais", "gardien"],
};

describe("listTemplates (via BCE)", () => {
  it("returns at least one template", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThan(0);
  });

  it("each template has id, name, description", () => {
    for (const t of listTemplates()) {
      expect(t.id).toBeTruthy();
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });
});

// Templates whose required params are genuine per-run user input (no preset-time value possible)
const SMOKE_SET_PARAMS: Record<string, Record<string, Record<string, unknown>>> = {
  "mekova-decouverte": {
    "discovery-specialist": { transcript: "notes/rencontres/test.md" },
    "discovery-synth": { transcript: "notes/rencontres/test.md", projet: "test" },
  },
};

describe("buildProject (via BCE)", () => {
  it("throws on unknown template", () => {
    expect(() => buildProject("nonexistent-legacy-template", MOCK_CONTEXT)).toThrow();
  });

  it("builds a valid MiniProject for each registered template", () => {
    for (const t of listTemplates()) {
      const project = buildProject(t.id, MOCK_CONTEXT, { setParams: SMOKE_SET_PARAMS[t.id] });
      expect(project.id).toBeTruthy();
      expect(project.agents.length).toBeGreaterThan(0);
      for (const agent of project.agents) {
        expect(agent.id).toBeTruthy();
        expect(agent.prompt).toBeTruthy();
      }
    }
  });
});

