// tests/unit/minors.test.ts — minors différés du pilote
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { uniqueReportBase } from '../../src/orchestrator/reporter.js';
import { loadTemplates } from '../../src/template-loader.js';
import { runPipeline } from '@swoofer/promptweave';
import type { Agent } from '@swoofer/promptweave/types';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'essaim-minors-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('uniqueReportBase — collision de timestamp', () => {
  it('rend le préfixe tel quel quand rien n\'existe', () => {
    expect(uniqueReportBase(dir, 'report-123', ['.md'])).toBe('report-123');
  });

  it('ne réutilise pas un nom déjà pris — deux rapports dans la même milliseconde s\'écrasaient', () => {
    writeFileSync(join(dir, 'report-123.md'), 'premier');
    expect(uniqueReportBase(dir, 'report-123', ['.md'])).toBe('report-123-2');
  });

  it('exige que TOUTES les extensions soient libres (le rapport écrit .json ET .md)', () => {
    writeFileSync(join(dir, 'report-123.json'), '{}');
    // .md est libre, mais .json est pris : le couple doit basculer ensemble,
    // sinon le .md d'un run cohabite avec le .json d'un autre.
    expect(uniqueReportBase(dir, 'report-123', ['.json', '.md'])).toBe('report-123-2');
  });
});

describe('template-loader — validation de la shape des agents', () => {
  function writeTemplate(body: string): string {
    const tdir = join(dir, '.essaim', 'templates');
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'bancal.yaml'), body);
    return dir;
  }

  const HEADER = `name: Bancal
description: template de test
phase: 1
workspace: shared
stagger: { mode: fixed, delay: [0, 0] }
timeout_minutes: 5
metrics: []
compare_mode: false
agents:
`;

  it('accepte un agent bien formé', () => {
    const p = writeTemplate(HEADER + `  - idPrefix: a
    namePrefix: A
    preset: raid
    profile: codeur
`);
    expect(loadTemplates(p).bancal).toBeDefined();
  });

  it('rejette un agent sans preset, en nommant le template et l\'index', () => {
    const p = writeTemplate(HEADER + `  - idPrefix: a
    namePrefix: A
    profile: codeur
`);
    expect(() => loadTemplates(p)).toThrow(/bancal\.yaml: agents\[0\].*preset/s);
  });

  it('rejette un profile hors des deux valeurs admises', () => {
    const p = writeTemplate(HEADER + `  - idPrefix: a
    namePrefix: A
    preset: raid
    profile: architecte
`);
    expect(() => loadTemplates(p)).toThrow(/profile.*codeur.*communicant/s);
  });

  it('rejette un count invalide', () => {
    const p = writeTemplate(HEADER + `  - idPrefix: a
    namePrefix: A
    preset: raid
    profile: codeur
    count: beaucoup
`);
    expect(() => loadTemplates(p)).toThrow(/count/);
  });
});

describe('proto-scaffold — mock_spec est réellement transmis à l\'agent', () => {
  const BCE_DIR = resolve(import.meta.dirname, '../..');

  it('le mock_spec extrait par le skill atterrit dans le prompt (il était déclaré puis jeté)', () => {
    const agent: Agent = { name: 'test', preset: 'mekova-proto-scaffold', add: [], remove: [], params: {} };
    const result = runPipeline(agent, BCE_DIR, {
      'proto-scaffold': { mock_spec: 'Commande: id, client, pains[], heure_retrait' },
    });
    expect(result.output.prompt).toContain('heure_retrait');
  });
});
