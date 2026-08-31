import { describe, it, expect } from "vitest";
import { buildProjectFromBce, buildSoloPrompt } from "../../src/bridge.js";

const mockContext = {
  path: "/tmp/test",
  language: "typescript",
  test_command: "npx vitest run",
  modules: ["src", "tests"],
  source_files: ["src/index.ts"],
};

describe("buildProjectFromBce --agents", () => {
  it("uses default count without agentCount", () => {
    const project = buildProjectFromBce("raid", mockContext);
    expect(project.agents.length).toBe(2); // dynamic defaults to max(2, min(modules.length, 4))
  });

  it("uses agentCount for dynamic roles", () => {
    const project = buildProjectFromBce("raid", mockContext, { agentCount: 5 });
    expect(project.agents.length).toBe(5);
  });

  it("ignores agentCount for fixed-count templates", () => {
    const origWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const project = buildProjectFromBce("gardien", mockContext, { agentCount: 5 });
      expect(project.agents.length).toBe(1); // gardien is always 1
      expect(warnings.some((w) => w.includes("fixed agent count"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});

describe("buildProjectFromBce --set", () => {
  it("passes setParams to pipeline", () => {
    // This should not throw — setParams are merged into launchParams
    const project = buildProjectFromBce("gardien", mockContext, {
      setParams: { "project-context": { language: "python" } },
    });
    expect(project.agents.length).toBe(1);
  });
});

describe("buildProjectFromBce errors", () => {
  it("throws on unknown template", () => {
    expect(() => buildProjectFromBce("nonexistent", mockContext)).toThrow(
      "Unknown BCE template",
    );
  });
});

describe("buildSoloPrompt", () => {
  it("returns a non-empty prompt string", () => {
    const prompt = buildSoloPrompt("raid", {
      language: "typescript",
      test_command: "npx vitest run",
      modules: ["src"],
    });
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("throws on unknown template", () => {
    expect(() =>
      buildSoloPrompt("nonexistent", {
        language: "typescript",
        test_command: "npm test",
        modules: [],
      }),
    ).toThrow("Unknown BCE template");
  });

  it("merges setParams into pipeline", () => {
    // Should not throw
    const prompt = buildSoloPrompt(
      "gardien",
      { language: "python", test_command: "pytest", modules: [] },
      { "project-context": { language: "python" } },
    );
    expect(prompt.length).toBeGreaterThan(0);
  });
});


describe("scope paramétrique sur source_dirs/test_dirs (#156)", () => {
  const goContext = {
    path: "/tmp/go", language: "go", test_command: "go test ./...",
    modules: ["pkg", "cmd"], source_files: ["pkg/x.go"],
    source_dirs: ["pkg", "cmd"], test_dirs: ["test"],
  };

  for (const preset of ["raid", "swarm", "melee"]) {
    it(`${preset} contre un dépôt non-TS : 0 littéral essaim, répertoires réels présents`, () => {
      const project = buildProjectFromBce(preset, goContext);
      const allText = project.agents
        .flatMap((a) => [a.prompt, ...(a.phases ?? []).map((p) => p.prompt)])
        .join("\n");
      for (const lit of ["tests/sandbox", "bce/", "dashboard/", "server/", "client/"]) {
        expect(allText, `${preset} contient encore le littéral essaim ${lit}`).not.toContain(lit);
      }
      // le contexte porte les répertoires RÉELS du dépôt cible
      expect(allText).toContain("pkg");
    });
  }
});
