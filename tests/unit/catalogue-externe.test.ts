// tests/unit/catalogue-externe.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, delimiter } from 'path';
import { tmpdir } from 'os';
import { getCatalogRoots, getBundledRoot } from '../../cli/bce-resolver.js';
import { buildProject, listTemplates } from '../../src/orchestrator/template-engine.js';
import type { ProjectContext } from '../../src/orchestrator/types.js';

const made: string[] = [];
afterEach(() => {
  for (const p of made) rmSync(p, { recursive: true, force: true });
  made.length = 0;
  delete process.env.ESSAIM_CATALOG;
});
beforeEach(() => { delete process.env.ESSAIM_CATALOG; });

function tmpCatalog(suffix: string): string {
  const root = join(tmpdir(), `essaim-cat-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`);
  for (const d of ['behaviors', 'presets', 'compositions', 'templates']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  made.push(root);
  return root;
}

const CONTEXT: ProjectContext = {
  path: '.', language: 'typescript', test_command: 'npm test',
  source_dirs: ['src'], test_dirs: ['tests'], source_files: [],
  has_git: true, is_clean: true, modules: ['core'], applicable_templates: [],
};

// #32 du plan catalogue-externe — avant ça, un template projet-local pouvait
// RECOMBINER les presets bundlés, mais dès qu'il référençait un preset maison :
// « Preset not found in registry ». Toute organisation voulant son propre preset
// devait donc patcher le repo essaim — c'est exactement pour ça que des artefacts
// métier avaient fini par y vivre. Ils sont partis dans un catalogue externe ;
// essaim ne ship plus que du générique.

describe('getCatalogRoots', () => {
  it('sans rien, c\'est le catalogue bundlé seul (non-régression)', () => {
    expect(getCatalogRoots()).toEqual([getBundledRoot()]);
  });

  it('ESSAIM_CATALOG ajoute des racines, séparées par le délimiteur de la plateforme', () => {
    // JAMAIS ':' en dur : ça couperait "C:\..." en deux sous Windows.
    const a = tmpCatalog('a');
    const b = tmpCatalog('b');
    process.env.ESSAIM_CATALOG = [a, b].join(delimiter);

    expect(getCatalogRoots()).toEqual([getBundledRoot(), a, b]);
  });

  it('--catalog l\'emporte sur ESSAIM_CATALOG — l\'explicite bat l\'ambiant', () => {
    const env = tmpCatalog('env');
    const flag = tmpCatalog('flag');
    process.env.ESSAIM_CATALOG = env;

    // Dernier gagne : le flag doit arriver APRÈS l'env.
    expect(getCatalogRoots({ catalogs: [flag] })).toEqual([getBundledRoot(), env, flag]);
  });

  it('le catalogue projet-local (.essaim/) gagne sur tout — c\'est le plus local', () => {
    const flag = tmpCatalog('flag');
    const proj = tmpCatalog('proj');
    const local = join(proj, '.essaim');
    mkdirSync(join(local, 'presets'), { recursive: true });

    const roots = getCatalogRoots({ catalogs: [flag], projectPath: proj });
    expect(roots[roots.length - 1]).toBe(local);
  });

  it('un projet sans .essaim/ n\'ajoute rien', () => {
    const proj = tmpCatalog('proj');
    expect(getCatalogRoots({ projectPath: proj })).toEqual([getBundledRoot()]);
  });

  it('un --catalog inexistant ÉCHOUE, avec le chemin dans le message', () => {
    // Une faute de frappe ne doit jamais dégénérer en no-op silencieux : le
    // catalogue serait simplement ignoré et l'erreur ressortirait deux écrans plus
    // loin en « Unknown template ».
    const bidon = join(tmpdir(), 'catalogue-qui-nexiste-pas-xyz');
    expect(() => getCatalogRoots({ catalogs: [bidon] })).toThrow(/catalogue-qui-nexiste-pas-xyz/);
  });

  it('deux résolutions successives avec des catalogues différents ne se contaminent pas', () => {
    // Le cache module-level ne doit mettre en cache QUE la racine bundlée. Sinon le
    // 2e step d'un pipeline (ou le 2e test d'un fichier) réutilise le catalogue du 1er.
    const a = tmpCatalog('a');
    const b = tmpCatalog('b');

    expect(getCatalogRoots({ catalogs: [a] })).toEqual([getBundledRoot(), a]);
    expect(getCatalogRoots({ catalogs: [b] })).toEqual([getBundledRoot(), b]);
  });
});

describe('catalogue externe — bout en bout', () => {
  it('template externe → preset externe → behavior BUNDLÉ : le cas qui échoue aujourd\'hui', () => {
    const cat = tmpCatalog('maison');

    // Un preset maison qui réutilise un behavior du catalogue bundlé.
    writeFileSync(join(cat, 'presets', 'mon-preset.yaml'), [
      'name: mon-preset',
      'description: "preset maison"',
      'profile: codeur',
      'behaviors:',
      '  - project-context', // bundlé
      '  - mon-behavior',    // maison
    ].join('\n'));

    writeFileSync(join(cat, 'behaviors', 'mon-behavior.yaml'), [
      'name: mon-behavior',
      'description: "behavior maison"',
      'sections:',
      '  "030-mission":',
      '    prompt: "MISSION MAISON"',
    ].join('\n'));

    writeFileSync(join(cat, 'templates', 'mon-template.yaml'), [
      'name: Mon Template',
      'description: "template maison"',
      'phase: 1',
      'workspace: shared',
      'stagger: { mode: fixed, delay: [0, 0] }',
      'timeout_minutes: 5',
      'metrics: []',
      'compare_mode: false',
      'agents:',
      '  - idPrefix: maison',
      '    namePrefix: Maison',
      '    preset: mon-preset',
      '    profile: codeur',
      '    count: 1',
    ].join('\n'));

    const project = buildProject('mon-template', CONTEXT, { catalogs: [cat] });

    expect(project.agents).toHaveLength(1);
    expect(project.agents[0].prompt).toContain('MISSION MAISON'); // behavior maison
    expect(project.agents[0].prompt).toContain('Contexte du projet'); // behavior bundlé
  });

  it('un template externe apparaît dans listTemplates', () => {
    const cat = tmpCatalog('liste');
    writeFileSync(join(cat, 'templates', 'visible.yaml'), [
      'name: Visible', 'description: "d"', 'phase: 1', 'workspace: shared',
      'stagger: { mode: fixed, delay: [0, 0] }', 'timeout_minutes: 5',
      'metrics: []', 'compare_mode: false',
      'agents:',
      '  - { idPrefix: a, namePrefix: A, preset: raid, profile: codeur, count: 1 }',
    ].join('\n'));

    const ids = listTemplates(undefined, { catalogs: [cat] }).map((t) => t.id);
    expect(ids).toContain('visible');
    // Sans le catalogue, il n'existe pas.
    expect(listTemplates().map((t) => t.id)).not.toContain('visible');
  });

  it('un preset externe peut ÉCRASER un preset bundlé (dernier gagne)', () => {
    const cat = tmpCatalog('override');
    writeFileSync(join(cat, 'behaviors', 'project-context.yaml'), [
      'name: project-context',
      'description: "surcharge maison"',
      'sections:',
      '  "000-ctx":',
      '    prompt: "CONTEXTE SURCHARGE"',
    ].join('\n'));

    writeFileSync(join(cat, 'templates', 'o.yaml'), [
      'name: O', 'description: "d"', 'phase: 1', 'workspace: shared',
      'stagger: { mode: fixed, delay: [0, 0] }', 'timeout_minutes: 5',
      'metrics: []', 'compare_mode: false',
      'agents:',
      '  - { idPrefix: a, namePrefix: A, preset: raid, profile: codeur, count: 1 }',
    ].join('\n'));

    const project = buildProject('o', CONTEXT, { catalogs: [cat] });
    expect(project.agents[0].prompt).toContain('CONTEXTE SURCHARGE');
  });
});
