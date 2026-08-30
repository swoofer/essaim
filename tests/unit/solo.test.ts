// tests/unit/solo.test.ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { buildSoloArgs, launchSolo, type SoloLaunchDeps } from '../../cli/solo.js';
import { buildSolo } from '../../src/bridge.js';

const CONTEXT = { language: 'typescript', test_command: 'npm test', modules: ['core'] };

// Régression #34 — `essaim solo gardien` produisait son audit dans stdout mais
// n'écrivait jamais AUDIT.md : `claude -p` était lancé SANS --allowedTools, donc
// le Write butait sur un prompt de permission que le mode headless ne peut pas
// approuver. Le mode `run` passait bien un allowlist ; solo, non.
describe('solo — allowlist d\'outils en headless (#34)', () => {
  it('passe --allowedTools à claude -p', () => {
    const args = buildSoloArgs('prompt', [], null);
    expect(args).toContain('--allowedTools');
  });

  it('autorise explicitement Write — sans quoi l\'artefact est perdu en headless', () => {
    const args = buildSoloArgs('prompt', [], null);
    const allowed = args[args.indexOf('--allowedTools') + 1];
    for (const tool of ['Write', 'Edit', 'Read', 'Bash', 'Glob', 'Grep']) {
      expect(allowed.split(',')).toContain(tool);
    }
  });

  it('préfixe les outils MCP assemblés par le pipeline', () => {
    const args = buildSoloArgs('prompt', ['list_threads'], null);
    const allowed = args[args.indexOf('--allowedTools') + 1];
    expect(allowed.split(',')).toContain('mcp__coordinator__list_threads');
  });

  it('sans coordinator, n\'invente pas d\'outils MCP', () => {
    const args = buildSoloArgs('prompt', [], null);
    const allowed = args[args.indexOf('--allowedTools') + 1];
    expect(allowed).not.toContain('mcp__coordinator__');
  });

  it('ne passe --mcp-config que si un .mcp.json existe', () => {
    expect(buildSoloArgs('p', [], null)).not.toContain('--mcp-config');
    const args = buildSoloArgs('p', [], '/tmp/.mcp.json');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/.mcp.json');
  });

  it('garde le prompt en premier argument de -p', () => {
    const args = buildSoloArgs('mon-prompt', [], null);
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('mon-prompt');
  });
});

// #150 — claude absent ⇒ une ligne d'erreur, 0 octet de prompt sur stdout.
describe('launchSolo — échec propre quand claude est absent (#150)', () => {
  function harness(over: Partial<SoloLaunchDeps> = {}) {
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => {};
    const errs: string[] = [];
    const exits: number[] = [];
    let spawnedBin = '';
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const deps: SoloLaunchDeps = {
      spawn: (bin: string) => { spawnedBin = bin; return child as never; },
      resolveClaudeBin: () => 'claude',
      exit: (c: number) => { exits.push(c); },
      onSignal: () => {}, // ne pollue pas process en test
      ...over,
    };
    return { child, errs, exits, get spawnedBin() { return spawnedBin; }, deps, restore: () => { errSpy.mockRestore(); outSpy.mockRestore(); }, outSpy };
  }

  it("child 'error' (ENOENT) → une ligne actionnable sur stderr, exit 1, 0 octet sur stdout", () => {
    const h = harness();
    launchSolo(['-p', 'PROMPT_SECRET'], '/tmp', 15, h.deps);
    h.child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    expect(h.exits).toEqual([1]);
    expect(h.errs.some((e) => /CLAUDE_BIN|Installez Claude Code/.test(e))).toBe(true);
    expect(h.errs.some((e) => e.includes('PROMPT_SECRET'))).toBe(false); // jamais le prompt
    expect(h.outSpy).not.toHaveBeenCalled(); // 0 octet sur stdout
    h.restore();
  });

  it('spawn qui throw (EINVAL synchrone) → même échec propre, exit 1, pas de stdout', () => {
    const h = harness({
      spawn: () => { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }); },
    });
    launchSolo(['-p', 'x'], '/tmp', 15, h.deps);
    expect(h.exits).toEqual([1]);
    expect(h.errs.some((e) => /Installez Claude Code/.test(e))).toBe(true);
    expect(h.outSpy).not.toHaveBeenCalled();
    h.restore();
  });

  it('honore le binaire de resolveClaudeBin (CLAUDE_BIN)', () => {
    const h = harness({ resolveClaudeBin: () => '/custom/claude.exe' });
    launchSolo(['-p', 'x'], '/tmp', 15, h.deps);
    expect(h.spawnedBin).toBe('/custom/claude.exe');
    h.child.emit('exit', 0);
    expect(h.exits).toEqual([0]);
    h.restore();
  });

  it("propage le code de sortie de l'agent", () => {
    const h = harness();
    launchSolo(['-p', 'x'], '/tmp', 15, h.deps);
    h.child.emit('exit', 3);
    expect(h.exits).toEqual([3]);
    h.restore();
  });
});

describe('buildSolo — expose les outils, pas seulement le prompt (#34)', () => {
  it('retourne le prompt ET les mcpTools assemblés', () => {
    const solo = buildSolo('gardien', CONTEXT);
    expect(solo.prompt.length).toBeGreaterThan(0);
    expect(Array.isArray(solo.mcpTools)).toBe(true);
  });

  it('gardien (read-only-mode + audit-output) garde Write : il DOIT écrire son AUDIT.md', () => {
    const solo = buildSolo('gardien', CONTEXT);
    const args = buildSoloArgs(solo.prompt, solo.mcpTools, null);
    const allowed = args[args.indexOf('--allowedTools') + 1];
    expect(allowed.split(',')).toContain('Write');
  });
});
