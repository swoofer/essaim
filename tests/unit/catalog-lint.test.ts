// tests/unit/catalog-lint.test.ts
//
// Garde-fou de catalogue : un behavior ne doit pas déclarer un param qu'aucun
// canal d'assemblage ne peut lire.
//
// Complémentaire du warning runtime de promptweave, qui ne parle que si un
// appelant pose effectivement une valeur. Un param que personne ne règle reste
// mort en silence pour toujours — c'est exactement comme ça que
// `quality-audit.categories` a pourri jusqu'à #79.
//
// La règle vient de findUnusedParams plutôt que d'être réécrite ici : les canaux
// (sections, args de hooks, side_car_files, knobs de phase, compositions) sont
// une propriété de l'assembleur, et les dupliquer, c'est les voir diverger.
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Registry, findUnusedParams } from "@swoofer/promptweave";
import { getBundledRoot } from "../../cli/bce-resolver.js";

describe("catalogue bundlé — params orphelins", () => {
  const registry = Registry.load(getBundledRoot());

  it("charge réellement le catalogue", () => {
    // Sans ça, l'assertion suivante passerait à vide si la résolution de racine
    // cassait : un garde-fou qui ne regarde rien est pire que pas de garde-fou.
    expect(registry.behaviors.size).toBeGreaterThan(20);
  });

  it("aucun behavior ne déclare un param que rien ne peut lire", () => {
    const orphelins = findUnusedParams(registry.behaviors, registry.compositions.values());

    expect(
      orphelins.map((o) => `${o.behavior}.${o.param}`),
      "Interpole ce param, ou retire sa déclaration. Une valeur fournie pour un " +
        "param qu'aucune section, hook, side_car_file, knob de phase ou composition " +
        "ne lit est validée par le schéma puis jetée sans un mot.",
    ).toEqual([]);
  });
});

describe("le lint détecte vraiment un orphelin", () => {
  it("signale un param déclaré et jamais interpolé", () => {
    // Preuve que le test ci-dessus est vert parce que le catalogue est sain, et
    // non parce que le lint ne trouve jamais rien.
    const root = join(tmpdir(), `essaim-lint-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, "behaviors"), { recursive: true });
    writeFileSync(
      join(root, "behaviors", "temoin.yaml"),
      [
        "name: temoin",
        'description: "déclare un param que sa section ignore"',
        "params:",
        "  jete:",
        '    type: string',
        "    required: false",
        "sections:",
        '  "030-mission":',
        '    prompt: "texte statique"',
      ].join("\n"),
    );

    try {
      const temoin = Registry.load(root);
      expect(findUnusedParams(temoin.behaviors, temoin.compositions.values())).toEqual([
        { behavior: "temoin", param: "jete" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
