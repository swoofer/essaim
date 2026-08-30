// tests/unit/minors.test.ts — minors différés du pilote
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { uniqueReportBase, tscCompilationStatus, collectAgentResults, countDiffLines, writeReport } from '../../src/orchestrator/reporter.js';
import type { WorkspaceResult, RunResult, AgentResult } from '../../src/orchestrator/types.js';

// #152 — colonne Compilation TRI-ÉTAT, fondée sur le code de sortie de tsc et non
// sur includes("error") (qui rendait un faux OK quand tsc était injoignable).
describe('tscCompilationStatus (#152)', () => {
  it('tsc rend 0 -> true (OK)', () => {
    expect(tscCompilationStatus('/ws', () => ({ code: 0, output: '' }))).toBe(true);
  });

  it('tsc tourne et échoue (error TSxxxx) -> false (FAIL)', () => {
    const output = 'src/a.ts(12,3): error TS2322: Type string is not assignable to number.';
    expect(tscCompilationStatus('/ws', () => ({ code: 1, output }))).toBe(false);
  });

  it("tsc INJOIGNABLE (npx introuvable, code 127, aucun diagnostic tsc) -> undefined, JAMAIS true (acceptance #152)", () => {
    const r = tscCompilationStatus('/ws', () => ({ code: 127, output: 'npx: command not found' }));
    expect(r).toBeUndefined();
    expect(r).not.toBe(true); // le faux OK est banni
  });

  it('spawn impossible (code null) -> undefined (non vérifié)', () => {
    expect(tscCompilationStatus('/ws', () => ({ code: null, output: '' }))).toBeUndefined();
  });
});
import { loadTemplates } from '../../src/template-loader.js';

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

// #160 — `npx tsc --noEmit` seulement sur dépôt TS. Un dépôt Go/Python n'a rien à
// typer : tsc n'y prouve rien et coûte ~10 s/agent. Compteur : dépôt Go ⇒ N/A,
// et tsc n'est JAMAIS lancé.
describe('collectAgentResults — tsc seulement sur dépôt TS (#160)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function workspaceOf(wsPath: string): WorkspaceResult {
    // `shared` (pas `worktree`) pour éviter tout `git diff` : on isole la porte tsc.
    return { type: 'shared', basePath: wsPath, paths: new Map([['a1', wsPath]]), branches: new Map() };
  }

  it('dépôt NON-TS (pas de tsconfig) ⇒ compilation N/A et tsc JAMAIS lancé', () => {
    dir = mkdtempSync(join(tmpdir(), 'nots-'));
    const run = vi.fn(() => ({ code: 0 as number | null, output: '' }));
    const results = collectAgentResults(workspaceOf(dir), run);
    expect(run).not.toHaveBeenCalled();                 // LE compteur : pas de tsc sur un dépôt Go
    expect(results[0].compilation_ok).toBeUndefined();  // colonne N/A, pas OK/FAIL
  });

  it('dépôt TS (tsconfig présent) ⇒ tsc lancé, statut honoré', () => {
    dir = mkdtempSync(join(tmpdir(), 'ts-'));
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    const run = vi.fn(() => ({ code: 0 as number | null, output: '' }));
    const results = collectAgentResults(workspaceOf(dir), run);
    expect(run).toHaveBeenCalledWith(dir);
    expect(results[0].compilation_ok).toBe(true);
  });
});

// #165 — rapport honnête : le diff compte les fichiers NON SUIVIS (agent qui écrit
// sans commiter ⇒ diff ≠ 0), les hot files sont NOMMÉS, et la section morte
// « Métriques spécifiques » (custom_metrics câblé à {}) est retirée.
function runResult(over: Partial<RunResult['coordinator_metrics']> = {}, agents: AgentResult[] = []): RunResult {
  return {
    project_id: 'p', project_name: 'proj', mode: 'with_coordinator', duration_ms: 1000,
    coordinator_metrics: {
      agents_count: agents.length, duration_total_ms: 1000, threads_opened: 0,
      threads_resolved_consensus: 0, threads_auto_resolved: 0, threads_without_consensus: 0,
      messages_exchanged: 0, conflicts_by_layer: {}, introspections_triggered: 0,
      introspections_concerned: 0, avg_resolution_time_ms: 0, hot_files: [], ...over,
    },
    agent_results: agents, custom_metrics: {},
  };
}

describe('reporter honnête (#165)', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('hot files NOMMÉS, pas seulement comptés', () => {
    dir = mkdtempSync(join(tmpdir(), 'rep165-'));
    const md = readFileSync(writeReport([runResult({ hot_files: ['src/a.ts', 'src/b.ts'] })], dir), 'utf8');
    expect(md).toContain('src/a.ts, src/b.ts');       // les NOMS
    expect(md).not.toContain('| Hot files | 2 |');    // plus le simple compte
  });

  it('la section morte « Métriques spécifiques » (custom_metrics {}) a disparu', () => {
    dir = mkdtempSync(join(tmpdir(), 'rep165b-'));
    const md = readFileSync(writeReport([runResult()], dir), 'utf8');
    expect(md).not.toContain('Métriques spécifiques');
  });

  it('un fichier NEUF non commité compte dans le diff (agent qui écrit sans commiter ⇒ diff ≠ 0)', () => {
    dir = mkdtempSync(join(tmpdir(), 'rep165diff-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(dir, 'base.ts'), 'export const a = 1;\n');
    git('add', '-A'); git('commit', '-qm', 'base');
    const baseSha = git('rev-parse', 'HEAD').stdout.trim();
    // l'agent écrit un NOUVEAU fichier sans `git add` ni commit
    writeFileSync(join(dir, 'newfile.ts'), 'export const b = 2;\nexport const c = 3;\n');

    const workspace: WorkspaceResult = {
      type: 'worktree', basePath: dir, baseSha,
      paths: new Map([['a1', dir]]), branches: new Map(),
    };
    const results = collectAgentResults(workspace);
    expect(countDiffLines(results[0].diff)).toBeGreaterThan(0); // LE compteur : diff ≠ 0
    expect(results[0].diff).toContain('newfile.ts');            // et le fichier est nommé
  });
});
