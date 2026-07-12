// tests/unit/solo.test.ts
import { describe, it, expect } from 'vitest';
import { buildSoloArgs } from '../../cli/solo.js';
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
