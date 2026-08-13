// tests/unit/catalog-params.test.ts
//
// essaim#79 — `quality-audit` déclarait un param `categories` qu'aucune section
// n'interpolait. La valeur passait la validation de schéma puis disparaissait à
// l'assemblage : un preset qui surchargeait les catégories produisait un prompt
// byte-identical au preset générique, et le `--dry-run` ne montrait rien.
//
// Ces tests exercent le catalogue bundlé par le vrai assembleur : ils échouent
// si quelqu'un retire une interpolation, et ils échoueraient aussi si on
// « corrigeait » le bug en supprimant simplement le param.
import { describe, it, expect } from "vitest";
import { runPipeline } from "@swoofer/promptweave";
import { getBundledRoot } from "../../cli/bce-resolver.js";

function promptFor(
  behavior: string,
  params: Record<string, unknown> = {},
): string {
  const result = runPipeline(
    { name: "test", behaviors: [behavior], add: [], remove: [], params: {} },
    getBundledRoot(),
    { [behavior]: params },
  );
  return result.output.prompt;
}

describe("quality-audit — categories (#79)", () => {
  it("une valeur fournie atteint le prompt", () => {
    const prompt = promptFor("quality-audit", {
      categories: ["Ergonomie du CLI", "Budget de tours"],
    });

    expect(prompt).toContain("Ergonomie du CLI");
    expect(prompt).toContain("Budget de tours");
  });

  it("sans valeur, les six catégories par défaut restent en place", () => {
    const prompt = promptFor("quality-audit");

    for (const defaut of [
      "Structure",
      "Conventions",
      "Complexité",
      "Dette technique",
      "Tests",
      "Documentation",
    ]) {
      expect(prompt).toContain(defaut);
    }
  });

  it("une valeur fournie remplace les défauts au lieu de s'y ajouter", () => {
    // Sinon l'agent auditerait huit catégories dont six qu'on ne lui a pas demandées.
    const prompt = promptFor("quality-audit", { categories: ["Ergonomie du CLI"] });

    expect(prompt).not.toContain("Dette technique");
  });

  it("le prompt diffère de celui par défaut — le repro exact de l'issue", () => {
    // L'issue se manifestait comme deux prompts rigoureusement identiques.
    expect(promptFor("quality-audit", { categories: ["Ergonomie du CLI"] })).not.toBe(
      promptFor("quality-audit"),
    );
  });
});

describe("bug-hunting — bug_categories", () => {
  it("une valeur fournie atteint le prompt", () => {
    const prompt = promptFor("bug-hunting", {
      bug_categories: ["Fuites de descripteurs de fichiers"],
    });

    expect(prompt).toContain("Fuites de descripteurs de fichiers");
  });

  it("sans valeur, les catégories par défaut restent en place", () => {
    const prompt = promptFor("bug-hunting");

    expect(prompt).toContain("Edge cases manquants");
    expect(prompt).toContain("Problèmes de concurrence");
  });
});

describe("test-writing — test_framework et test_dir", () => {
  it("le framework fourni atteint le prompt", () => {
    expect(promptFor("test-writing", { test_framework: "vitest" })).toContain("vitest");
  });

  it("le répertoire fourni atteint le prompt", () => {
    expect(promptFor("test-writing", { test_dir: "tests/unit" })).toContain("tests/unit");
  });

  it("sans valeur, la consigne générique reste — aucun placeholder vide", () => {
    const prompt = promptFor("test-writing");

    expect(prompt).toContain("framework de test existant");
    expect(prompt).not.toMatch(/\{\{|\}\}/);
  });
});

describe("discovery-synth — projet", () => {
  it("le nom du prototype fourni atteint le prompt", () => {
    const prompt = promptFor("discovery-synth", {
      transcript: "tmp/transcript.md",
      projet: "commandes-boulangerie",
    });

    expect(prompt).toContain("commandes-boulangerie");
  });
});
