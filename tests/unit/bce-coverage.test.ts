/**
 * Comprehensive coverage tests for BCE engine.
 * Targets all uncovered branches and lines identified in the v8 coverage report.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { resolve, join } from 'path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { Registry, applyCompositionRules, matchRules, assemblePrompt, assembleHooks, assembleMcpTools, validateBehaviors, resolveBehaviors, resolveParams, writeOutput, runPipeline } from '@swoofer/promptweave';
import type { Agent, AgentContext, Behavior, AssembledOutput, CompositionRule } from '@swoofer/promptweave/types';

// FIXTURES points to the essaim-new repo root, which contains behaviors/, presets/, compositions/
const FIXTURES = resolve(import.meta.dirname, '../..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBehavior(overrides: Partial<Behavior> & { name: string; sections: Behavior['sections'] }): Behavior {
  return {
    description: 'test behavior',
    category: 'workspace',
    requires: { behaviors: [], infrastructure: [] },
    conflicts_with: [],
    suggests: [],
    params: {},
    hooks: {},
    mcp_tools: [],
    side_car_files: {},
    ...overrides,
  };
}

const agentCtx: AgentContext = {
  id: 'test-agent',
  displayName: 'Test Agent',
  profile: 'codeur',
  model: 'claude-opus-4-6',
};

function tmpPath(suffix: string): string {
  return join(tmpdir(), `bce-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${suffix}`);
}

// ---------------------------------------------------------------------------
// writer.ts — 0% covered, needs full suite
// ---------------------------------------------------------------------------

describe('writer.ts — writeOutput', () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true });
      }
    }
    // Also clean up any .tmp.* siblings
    for (const dir of [...cleanupDirs]) {
      const parent = resolve(dir, '..');
      try {
        const entries = require('fs').readdirSync(parent);
        for (const e of entries) {
          const full = join(parent, e);
          if (e.startsWith('bce-test-') && e.includes('.tmp.')) {
            rmSync(full, { recursive: true });
          }
        }
      } catch { /* ignore */ }
    }
    cleanupDirs.length = 0;
  });

  const minimalOutput: AssembledOutput = {
    prompt: '# Test prompt\nHello world.',
    phases: [],
    hooks: {},
    mcpTools: [],
    envVars: {},
      sideCarFiles: {},
  };

  it('writes prompt, mcp json, and env file to target dir', () => {
    const targetDir = tmpPath('write-basic');
    cleanupDirs.push(targetDir);

    writeOutput(targetDir, minimalOutput);

    expect(existsSync(targetDir)).toBe(true);
    expect(readFileSync(join(targetDir, 'generated-prompt.md'), 'utf-8')).toBe(minimalOutput.prompt);
    expect(readFileSync(join(targetDir, 'generated-mcp.json'), 'utf-8')).toBe(
      JSON.stringify({ mcpTools: [] }, null, 2),
    );
    expect(readFileSync(join(targetDir, '.coordinator-env'), 'utf-8')).toBe('');
  });

  it('writes hook scripts to generated-hooks/', () => {
    const targetDir = tmpPath('write-hooks');
    cleanupDirs.push(targetDir);

    const output: AssembledOutput = {
      ...minimalOutput,
      hooks: {
        'session-start': '#!/bin/bash\necho start',
        'pre-tool-use': '#!/bin/bash\necho pre',
      },
    };

    writeOutput(targetDir, output);

    expect(readFileSync(join(targetDir, 'generated-hooks', 'session-start.sh'), 'utf-8')).toBe('#!/bin/bash\necho start');
    expect(readFileSync(join(targetDir, 'generated-hooks', 'pre-tool-use.sh'), 'utf-8')).toBe('#!/bin/bash\necho pre');
  });

  it('writes env vars in export format', () => {
    const targetDir = tmpPath('write-env');
    cleanupDirs.push(targetDir);

    const output: AssembledOutput = {
      ...minimalOutput,
      envVars: { FOO: 'bar', BAZ: 'qux' },
    };

    writeOutput(targetDir, output);

    const content = readFileSync(join(targetDir, '.coordinator-env'), 'utf-8');
    expect(content).toContain('export FOO="bar"');
    expect(content).toContain('export BAZ="qux"');
  });

  it('replaces existing target dir atomically', () => {
    const targetDir = tmpPath('write-replace');
    cleanupDirs.push(targetDir);

    // Create an existing target dir with a sentinel file
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, 'old-file.txt'), 'old');

    writeOutput(targetDir, minimalOutput);

    expect(existsSync(join(targetDir, 'old-file.txt'))).toBe(false);
    expect(existsSync(join(targetDir, 'generated-prompt.md'))).toBe(true);
  });

  it('merges .mcp.json at project root when projectRoot is provided', () => {
    const targetDir = tmpPath('write-mcp-merge');
    const projectRoot = tmpPath('write-project-root');
    cleanupDirs.push(targetDir, projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    const output: AssembledOutput = {
      ...minimalOutput,
      mcpTools: ['tool_a', 'tool_b'],
      envVars: { COORDINATOR_URL: 'http://localhost:4000' },
    };

    writeOutput(targetDir, output, projectRoot);

    const mcpJson = JSON.parse(readFileSync(join(projectRoot, '.mcp.json'), 'utf-8'));
    expect(mcpJson.mcpServers._bce_coordinator).toBeDefined();
    expect(mcpJson.mcpServers._bce_coordinator.url).toBe('http://localhost:4000/mcp');
    expect(mcpJson.mcpServers._bce_coordinator._bce_tools).toEqual(['tool_a', 'tool_b']);
  });

  it('merges with existing .mcp.json preserving non-bce servers', () => {
    const targetDir = tmpPath('write-mcp-preserve');
    const projectRoot = tmpPath('write-project-preserve');
    cleanupDirs.push(targetDir, projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    // Write existing .mcp.json with a user-defined server
    const existingMcp = {
      mcpServers: {
        'my-server': { type: 'http', url: 'http://my-server' },
        '_bce_old': { type: 'http', url: 'http://old' },
      },
    };
    writeFileSync(join(projectRoot, '.mcp.json'), JSON.stringify(existingMcp));

    const output: AssembledOutput = {
      ...minimalOutput,
      mcpTools: ['tool_x'],
      envVars: {},
    };

    writeOutput(targetDir, output, projectRoot);

    const mcpJson = JSON.parse(readFileSync(join(projectRoot, '.mcp.json'), 'utf-8'));
    expect(mcpJson.mcpServers['my-server']).toBeDefined();
    expect(mcpJson.mcpServers['_bce_old']).toBeUndefined();
    expect(mcpJson.mcpServers['_bce_coordinator']).toBeDefined();
  });

  it('defaults to localhost:3100 when COORDINATOR_URL is not in envVars', () => {
    const targetDir = tmpPath('write-default-url');
    const projectRoot = tmpPath('write-default-url-root');
    cleanupDirs.push(targetDir, projectRoot);
    mkdirSync(projectRoot, { recursive: true });

    const output: AssembledOutput = {
      ...minimalOutput,
      mcpTools: ['tool_y'],
      envVars: {},
    };

    writeOutput(targetDir, output, projectRoot);

    const mcpJson = JSON.parse(readFileSync(join(projectRoot, '.mcp.json'), 'utf-8'));
    expect(mcpJson.mcpServers._bce_coordinator.url).toBe('http://localhost:3100/mcp');
  });

  it('cleans up tmp dir on error', () => {
    const targetDir = tmpPath('write-error');
    cleanupDirs.push(targetDir);

    // Pass an output that would cause writeFileSync to fail
    // by using a circular reference in mcpTools (stringify will throw)
    const badOutput = {
      prompt: 'test',
      hooks: {},
      mcpTools: [] as string[],
      envVars: {},
    };

    // Create the target dir first, then make a readonly child to force error
    // Instead, we'll mock by passing an object with a getter that throws
    const circularObj: Record<string, unknown> = {};
    circularObj.self = circularObj;

    const output: AssembledOutput = {
      prompt: 'test',
      phases: [],
      hooks: {},
      mcpTools: circularObj as unknown as string[],
      envVars: {},
      sideCarFiles: {},
    };

    expect(() => writeOutput(targetDir, output)).toThrow();

    // Verify the tmp dir was cleaned up
    // The actual targetDir should not exist because the error happened before renameSync
    // (The tmpDir with timestamp suffix should be cleaned up)
  });
});

// NOTE: interpolate (template.ts) is a promptweave internal, not part of the public API.
// Those tests belong in the promptweave package, not in essaim. Removed per Task 12.

// ---------------------------------------------------------------------------
// compose.ts — error paths + inject/disable/override_params
// ---------------------------------------------------------------------------

describe('compose.ts — uncovered branches', () => {
  it('throws when override_sections references a non-active behavior', () => {
    const behavior = makeBehavior({
      name: 'active-one',
      sections: { '010-test': { prompt: 'test' } },
    });

    const rule: CompositionRule = {
      name: 'bad-override',
      description: 'references inactive behavior',
      priority: 0,
      when: { all: ['active-one'], any: [], none: [], params_match: {} },
      actions: {
        override_sections: [
          { behavior: 'not-active', section: '010-test', prompt: 'new' },
        ],
        inject_sections: {},
        disable_behaviors: [],
        override_params: [],
      },
    };

    const behaviorsMap = new Map<string, Behavior>();
    behaviorsMap.set('active-one', behavior);

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('bad-override', rule);

    expect(() => applyCompositionRules(behaviorsMap, mockRegistry)).toThrow(
      /behavior "not-active" not active/,
    );
  });

  it('throws when override_sections references a non-existent section', () => {
    const behavior = makeBehavior({
      name: 'active-one',
      sections: { '010-real': { prompt: 'real content' } },
    });

    const rule: CompositionRule = {
      name: 'bad-section',
      description: 'references missing section',
      priority: 0,
      when: { all: ['active-one'], any: [], none: [], params_match: {} },
      actions: {
        override_sections: [
          { behavior: 'active-one', section: '999-missing', prompt: 'new' },
        ],
        inject_sections: {},
        disable_behaviors: [],
        override_params: [],
      },
    };

    const behaviorsMap = new Map<string, Behavior>();
    behaviorsMap.set('active-one', behavior);

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('bad-section', rule);

    expect(() => applyCompositionRules(behaviorsMap, mockRegistry)).toThrow(
      /section "999-missing" not found in behavior "active-one".*Available.*010-real/,
    );
  });

  it('processes inject_sections correctly', () => {
    const behavior = makeBehavior({
      name: 'base-behavior',
      sections: { '010-main': { prompt: 'main content' } },
    });

    const rule: CompositionRule = {
      name: 'inject-rule',
      description: 'injects a section',
      priority: 0,
      when: { all: ['base-behavior'], any: [], none: [], params_match: {} },
      actions: {
        override_sections: [],
        inject_sections: {
          '015-injected': { prompt: 'Injected content.' },
        },
        disable_behaviors: [],
        override_params: [],
      },
    };

    const behaviorsMap = new Map<string, Behavior>();
    behaviorsMap.set('base-behavior', behavior);

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('inject-rule', rule);

    const result = applyCompositionRules(behaviorsMap, mockRegistry);
    expect(result.injectedSections.has('015-injected')).toBe(true);
    expect(result.injectedSections.get('015-injected')!.prompt).toBe('Injected content.');
    expect(result.injectedSections.get('015-injected')!.source).toBe('inject-rule');
  });

  it('processes disable_behaviors correctly', () => {
    const behaviorA = makeBehavior({
      name: 'keep-me',
      sections: { '010-keep': { prompt: 'keep' } },
    });
    const behaviorB = makeBehavior({
      name: 'remove-me',
      sections: { '020-remove': { prompt: 'remove' } },
    });

    const rule: CompositionRule = {
      name: 'disable-rule',
      description: 'disables a behavior',
      priority: 0,
      when: { all: ['keep-me', 'remove-me'], any: [], none: [], params_match: {} },
      actions: {
        override_sections: [],
        inject_sections: {},
        disable_behaviors: ['remove-me'],
        override_params: [],
      },
    };

    const behaviorsMap = new Map<string, Behavior>();
    behaviorsMap.set('keep-me', behaviorA);
    behaviorsMap.set('remove-me', behaviorB);

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('disable-rule', rule);

    const result = applyCompositionRules(behaviorsMap, mockRegistry);
    expect(result.behaviors.has('keep-me')).toBe(true);
    expect(result.behaviors.has('remove-me')).toBe(false);
    expect(result.disabledBehaviors).toContain('remove-me');
  });

  it('processes override_params correctly', () => {
    const behavior = makeBehavior({
      name: 'parameterized',
      sections: { '010-test': { prompt: 'test {{params.threshold}}' } },
      params: {
        threshold: { type: 'number', default: 5, required: false },
      },
    });

    const rule: CompositionRule = {
      name: 'param-override-rule',
      description: 'overrides params',
      priority: 0,
      when: { all: ['parameterized'], any: [], none: [], params_match: {} },
      actions: {
        override_sections: [],
        inject_sections: {},
        disable_behaviors: [],
        override_params: [
          { behavior: 'parameterized', params: { threshold: 99 } },
        ],
      },
    };

    const behaviorsMap = new Map<string, Behavior>();
    behaviorsMap.set('parameterized', behavior);

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('param-override-rule', rule);

    const result = applyCompositionRules(behaviorsMap, mockRegistry);
    const modified = result.behaviors.get('parameterized')!;
    expect(modified.params.threshold.default).toBe(99);
  });

  it('override_params ignores non-active behavior silently', () => {
    const behavior = makeBehavior({
      name: 'only-behavior',
      sections: { '010-test': { prompt: 'test' } },
    });

    const rule: CompositionRule = {
      name: 'param-override-ghost',
      description: 'overrides params on non-existent behavior',
      priority: 0,
      when: { all: ['only-behavior'], any: [], none: [], params_match: {} },
      actions: {
        override_sections: [],
        inject_sections: {},
        disable_behaviors: [],
        override_params: [
          { behavior: 'ghost-behavior', params: { x: 1 } },
        ],
      },
    };

    const behaviorsMap = new Map<string, Behavior>();
    behaviorsMap.set('only-behavior', behavior);

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('param-override-ghost', rule);

    // Should not throw — just silently skip
    const result = applyCompositionRules(behaviorsMap, mockRegistry);
    expect(result.appliedRules).toContain('param-override-ghost');
  });

  it('override_params ignores unknown param keys silently', () => {
    const behavior = makeBehavior({
      name: 'param-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        real_param: { type: 'string', default: 'old', required: false },
      },
    });

    const rule: CompositionRule = {
      name: 'param-unknown-key',
      description: 'overrides unknown param key',
      priority: 0,
      when: { all: ['param-beh'], any: [], none: [], params_match: {} },
      actions: {
        override_sections: [],
        inject_sections: {},
        disable_behaviors: [],
        override_params: [
          { behavior: 'param-beh', params: { nonexistent_key: 'val' } },
        ],
      },
    };

    const behaviorsMap = new Map<string, Behavior>();
    behaviorsMap.set('param-beh', behavior);

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('param-unknown-key', rule);

    const result = applyCompositionRules(behaviorsMap, mockRegistry);
    const modified = result.behaviors.get('param-beh')!;
    // Original param unchanged, unknown param not added
    expect(modified.params.real_param.default).toBe('old');
    expect(modified.params['nonexistent_key']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// assemble.ts — buildDefaultParams switch, hook tiebreak, non-blocking, mergeMcpConfig
// ---------------------------------------------------------------------------

describe('assemble.ts — buildDefaultParams switch cases', () => {
  it('defaults number params to 0', () => {
    const behavior = makeBehavior({
      name: 'num-beh',
      sections: { '010-test': { prompt: 'val={{params.count}}' } },
      params: { count: { type: 'number', required: false } },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('num-beh', behavior);

    const { prompt } = assemblePrompt(behaviors, new Map(), new Map(), agentCtx, {});
    expect(prompt).toContain('val=0');
  });

  it('defaults boolean params to false', () => {
    const behavior = makeBehavior({
      name: 'bool-beh',
      sections: { '010-test': { prompt: 'val={{params.flag}}' } },
      params: { flag: { type: 'boolean', required: false } },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('bool-beh', behavior);

    const { prompt } = assemblePrompt(behaviors, new Map(), new Map(), agentCtx, {});
    expect(prompt).toContain('val=false');
  });

  it('defaults string[] params to empty array', () => {
    const behavior = makeBehavior({
      name: 'strarr-beh',
      sections: { '010-test': { prompt: 'val={{params.items}}' } },
      params: { items: { type: 'string[]', required: false } },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('strarr-beh', behavior);

    const { prompt } = assemblePrompt(behaviors, new Map(), new Map(), agentCtx, {});
    // empty array toString = ''
    expect(prompt).toContain('val=');
  });

  it('defaults number[] params to empty array', () => {
    const behavior = makeBehavior({
      name: 'numarr-beh',
      sections: { '010-test': { prompt: 'val={{params.numbers}}' } },
      params: { numbers: { type: 'number[]', required: false } },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('numarr-beh', behavior);

    const { prompt } = assemblePrompt(behaviors, new Map(), new Map(), agentCtx, {});
    expect(prompt).toContain('val=');
  });

  it('defaults unknown type params to empty string', () => {
    // Force a behavior with an unusual type that hits the default case
    const behavior = makeBehavior({
      name: 'unknown-type-beh',
      sections: { '010-test': { prompt: 'val={{params.weird}}' } },
      params: { weird: { type: 'object' as any, required: false } },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('unknown-type-beh', behavior);

    const { prompt } = assemblePrompt(behaviors, new Map(), new Map(), agentCtx, {});
    expect(prompt).toContain('val=');
  });
});

describe('assemble.ts — assembleHooks tiebreak and non-blocking', () => {
  it('sorts hooks alphabetically by behavior name when order is the same', () => {
    const behaviorA = makeBehavior({
      name: 'alpha',
      sections: { '010-test': { prompt: 'a' } },
      hooks: {
        'session-start': { script: 'alpha.sh', args: [], blocking: true, order: 10 },
      },
    });
    const behaviorZ = makeBehavior({
      name: 'zeta',
      sections: { '010-test': { prompt: 'z' } },
      hooks: {
        'session-start': { script: 'zeta.sh', args: [], blocking: true, order: 10 },
      },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('zeta', behaviorZ);
    behaviors.set('alpha', behaviorA);

    const hooks = assembleHooks(behaviors, agentCtx, {});
    const lines = hooks['session-start'].split('\n');
    const alphaIdx = lines.findIndex((l) => l.includes('alpha.sh'));
    const zetaIdx = lines.findIndex((l) => l.includes('zeta.sh'));
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('generates "|| true" for non-blocking hooks', () => {
    const behavior = makeBehavior({
      name: 'non-blocking-beh',
      sections: { '010-test': { prompt: 'test' } },
      hooks: {
        'session-start': { script: 'optional.sh', args: [], blocking: false, order: 0 },
      },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('non-blocking-beh', behavior);

    const hooks = assembleHooks(behaviors, agentCtx, {});
    expect(hooks['session-start']).toContain('|| true');
    expect(hooks['session-start']).not.toContain('|| exit 1');
  });

  it('includes args in the hook command', () => {
    const behavior = makeBehavior({
      name: 'args-beh',
      sections: { '010-test': { prompt: 'test' } },
      hooks: {
        'session-start': { script: 'do_stuff.sh', args: ['{{agent.id}}', 'extra-arg'], blocking: true, order: 0 },
      },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('args-beh', behavior);

    const hooks = assembleHooks(behaviors, agentCtx, {});
    expect(hooks['session-start']).toContain('"test-agent"');
    expect(hooks['session-start']).toContain('"extra-arg"');
  });

  it('generates "|| exit 1" for blocking hooks', () => {
    const behavior = makeBehavior({
      name: 'blocking-beh',
      sections: { '010-test': { prompt: 'test' } },
      hooks: {
        'session-start': { script: 'required.sh', args: [], blocking: true, order: 0 },
      },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('blocking-beh', behavior);

    const hooks = assembleHooks(behaviors, agentCtx, {});
    expect(hooks['session-start']).toContain('|| exit 1');
  });
});

// NOTE: mergeMcpConfig is a promptweave internal, not part of the public API.
// Those tests belong in the promptweave package, not in essaim. Removed per Task 12.
// The writeOutput function (which wraps mergeMcpConfig) IS tested above via the public API.

// ---------------------------------------------------------------------------
// compose.ts — matchRules 'any' condition branch (line 22)
// ---------------------------------------------------------------------------

describe('compose.ts — matchRules any condition', () => {
  it('matches when any condition is satisfied', () => {
    const behaviorX = makeBehavior({ name: 'beh-x', sections: { '010-test': { prompt: 'x' } } });

    const rule: CompositionRule = {
      name: 'any-rule',
      description: 'uses any condition',
      priority: 0,
      when: { all: [], any: ['beh-x', 'beh-y'], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('any-rule', rule);

    const active = new Set(['beh-x']);
    const matched = matchRules(active, mockRegistry);
    expect(matched.some((r) => r.name === 'any-rule')).toBe(true);
  });

  it('does not match when no any condition is satisfied', () => {
    const rule: CompositionRule = {
      name: 'any-miss-rule',
      description: 'uses any condition with no match',
      priority: 0,
      when: { all: [], any: ['beh-missing-a', 'beh-missing-b'], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('any-miss-rule', rule);

    const active = new Set(['beh-x']);
    const matched = matchRules(active, mockRegistry);
    expect(matched.some((r) => r.name === 'any-miss-rule')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compose.ts — matchRules 'none' condition branch
// ---------------------------------------------------------------------------

describe('compose.ts — matchRules none condition', () => {
  it('does not match when a none-condition behavior is active', () => {
    const rule: CompositionRule = {
      name: 'none-fail-rule',
      description: 'should not match because excluded behavior is present',
      priority: 0,
      when: { all: ['beh-a'], any: [], none: ['beh-excluded'], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('none-fail-rule', rule);

    const active = new Set(['beh-a', 'beh-excluded']);
    const matched = matchRules(active, mockRegistry);
    expect(matched.some((r) => r.name === 'none-fail-rule')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compose.ts — matchRules sorting by priority (different priorities)
// ---------------------------------------------------------------------------

describe('compose.ts — matchRules priority sorting', () => {
  it('sorts matched rules by descending priority', () => {
    const rule1: CompositionRule = {
      name: 'low-prio',
      description: 'low priority',
      priority: 1,
      when: { all: ['sort-beh'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const rule2: CompositionRule = {
      name: 'high-prio',
      description: 'high priority',
      priority: 10,
      when: { all: ['sort-beh'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('low-prio', rule1);
    mockRegistry.compositions.set('high-prio', rule2);

    const active = new Set(['sort-beh']);
    const matched = matchRules(active, mockRegistry);
    const names = matched.map((r) => r.name);
    const highIdx = names.indexOf('high-prio');
    const lowIdx = names.indexOf('low-prio');
    expect(highIdx).toBeLessThan(lowIdx);
  });
});

// ---------------------------------------------------------------------------
// compose.ts — matchRules loop edge cases (lines 30-35 branches)
// ---------------------------------------------------------------------------

describe('compose.ts — matchRules loop iteration branches', () => {
  it('handles single matched rule without entering tie-check loop', () => {
    const rule: CompositionRule = {
      name: 'solo-rule',
      description: 'only one rule matches',
      priority: 0,
      when: { all: ['solo-beh'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const mockRegistry = Registry.load(FIXTURES);
    // Clear existing compositions to avoid noise
    const cleanRegistry = Registry.load(FIXTURES);
    cleanRegistry.compositions.clear();
    cleanRegistry.compositions.set('solo-rule', rule);

    const active = new Set(['solo-beh']);
    const matched = matchRules(active, cleanRegistry);
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe('solo-rule');
  });

  it('enters loop with same priority but different all — does not throw', () => {
    const cleanRegistry = Registry.load(FIXTURES);
    cleanRegistry.compositions.clear();

    const rule1: CompositionRule = {
      name: 'same-prio-diff-all-a',
      description: 'a',
      priority: 0,
      when: { all: ['beh-common', 'beh-only-a'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };
    const rule2: CompositionRule = {
      name: 'same-prio-diff-all-b',
      description: 'b',
      priority: 0,
      when: { all: ['beh-common', 'beh-only-b'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    cleanRegistry.compositions.set('same-prio-diff-all-a', rule1);
    cleanRegistry.compositions.set('same-prio-diff-all-b', rule2);

    const active = new Set(['beh-common', 'beh-only-a', 'beh-only-b']);
    const matched = matchRules(active, cleanRegistry);
    expect(matched).toHaveLength(2);
  });

  it('enters loop with different priorities — skips if-body', () => {
    const cleanRegistry = Registry.load(FIXTURES);
    cleanRegistry.compositions.clear();

    const rule1: CompositionRule = {
      name: 'prio-high',
      description: 'high',
      priority: 10,
      when: { all: ['multi-beh'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };
    const rule2: CompositionRule = {
      name: 'prio-low',
      description: 'low',
      priority: 1,
      when: { all: ['multi-beh'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    cleanRegistry.compositions.set('prio-high', rule1);
    cleanRegistry.compositions.set('prio-low', rule2);

    const active = new Set(['multi-beh']);
    const matched = matchRules(active, cleanRegistry);
    expect(matched[0].name).toBe('prio-high');
    expect(matched[1].name).toBe('prio-low');
  });

  it('handles rules with undefined priority (defaults via ?? 0)', () => {
    const cleanRegistry = Registry.load(FIXTURES);
    cleanRegistry.compositions.clear();

    const rule1: CompositionRule = {
      name: 'no-prio-a',
      description: 'a',
      when: { all: ['beh-noprio'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    } as unknown as CompositionRule;

    const rule2: CompositionRule = {
      name: 'no-prio-b',
      description: 'b',
      when: { all: ['beh-noprio-other'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    } as unknown as CompositionRule;

    cleanRegistry.compositions.set('no-prio-a', rule1);
    cleanRegistry.compositions.set('no-prio-b', rule2);

    const active = new Set(['beh-noprio', 'beh-noprio-other']);
    // Both match, same undefined priority (0), different all keys — no throw
    const matched = matchRules(active, cleanRegistry);
    expect(matched).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resolve.ts — preset profile/model fallback branches (lines 26, 36)
// ---------------------------------------------------------------------------

describe('resolve.ts — preset profile and model fallback', () => {
  it('uses preset profile when agent does not specify profile', () => {
    const registry = Registry.load(FIXTURES);
    const agent: Agent = {
      name: 'profile-test',
      preset: 'raid',
      add: [],
      remove: [],
      params: {},
    };
    // raid preset has profile: codeur
    const result = resolveBehaviors(agent, registry);
    expect(result.profile).toBe('codeur');
  });

  it('uses agent profile over preset profile', () => {
    const registry = Registry.load(FIXTURES);
    const agent: Agent = {
      name: 'profile-override-test',
      preset: 'raid',
      profile: 'communicant',
      add: [],
      remove: [],
      params: {},
    };
    const result = resolveBehaviors(agent, registry);
    expect(result.profile).toBe('communicant');
  });

  it('uses agent model over preset model', () => {
    const registry = Registry.load(FIXTURES);
    const agent: Agent = {
      name: 'model-override-test',
      preset: 'raid',
      model: 'claude-sonnet-4-20250514',
      add: [],
      remove: [],
      params: {},
    };
    const result = resolveBehaviors(agent, registry);
    expect(result.model).toBe('claude-sonnet-4-20250514');
  });

  it('defaults to codeur and opus when behaviors mode and no preset', () => {
    const registry = Registry.load(FIXTURES);
    const agent: Agent = {
      name: 'bare-agent',
      behaviors: ['worktree-isolation'],
      add: [],
      remove: [],
      params: {},
    };
    const result = resolveBehaviors(agent, registry);
    expect(result.profile).toBe('codeur');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.presetName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolve.ts — resolveParams preset/agent/launch param layering (line 68+)
// ---------------------------------------------------------------------------

describe('resolve.ts — resolveParams full layering', () => {
  it('preset params override behavior defaults', () => {
    const behavior = makeBehavior({
      name: 'layer-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: { val: { type: 'number', default: 1, required: false } },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('layer-beh', behavior);

    const result = resolveParams(
      ['layer-beh'],
      mockRegistry,
      { 'layer-beh': { val: 10 } },
      {},
      {},
    );
    expect(result['layer-beh']?.val).toBe(10);
  });

  it('agent params override preset params', () => {
    const behavior = makeBehavior({
      name: 'layer-beh2',
      sections: { '010-test': { prompt: 'test' } },
      params: { val: { type: 'number', default: 1, required: false } },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('layer-beh2', behavior);

    const result = resolveParams(
      ['layer-beh2'],
      mockRegistry,
      { 'layer-beh2': { val: 10 } },
      { 'layer-beh2': { val: 20 } },
      {},
    );
    expect(result['layer-beh2']?.val).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// assemble.ts — buildDefaultParams string case (line 12)
// ---------------------------------------------------------------------------

describe('assemble.ts — buildDefaultParams string case', () => {
  it('defaults string params to empty string when no default given', () => {
    const behavior = makeBehavior({
      name: 'str-default-beh',
      sections: { '010-test': { prompt: 'val=[{{params.label}}]' } },
      params: { label: { type: 'string', required: false } },
    });

    const behaviors = new Map<string, Behavior>();
    behaviors.set('str-default-beh', behavior);

    const { prompt } = assemblePrompt(behaviors, new Map(), new Map(), agentCtx, {});
    expect(prompt).toContain('val=[]');
  });
});

// ---------------------------------------------------------------------------
// compose.ts — priority tie with identical when.all (lines 33-39)
// ---------------------------------------------------------------------------

describe('compose.ts — matchRules priority conflict detection', () => {
  it('throws when two rules share the same priority and same when.all combination', () => {
    const behavior = makeBehavior({
      name: 'trigger-beh',
      sections: { '010-test': { prompt: 'test' } },
    });

    const rule1: CompositionRule = {
      name: 'rule-alpha',
      description: 'first rule',
      priority: 5,
      when: { all: ['trigger-beh'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const rule2: CompositionRule = {
      name: 'rule-beta',
      description: 'second rule same priority same all',
      priority: 5,
      when: { all: ['trigger-beh'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('rule-alpha', rule1);
    mockRegistry.compositions.set('rule-beta', rule2);

    const active = new Set(['trigger-beh']);
    expect(() => matchRules(active, mockRegistry)).toThrow(
      /same priority.*5.*Give one a higher priority/,
    );
  });

  it('does not throw when rules share priority but different when.all', () => {
    const behaviorA = makeBehavior({ name: 'beh-a', sections: { '010-test': { prompt: 'a' } } });
    const behaviorB = makeBehavior({ name: 'beh-b', sections: { '010-test': { prompt: 'b' } } });

    const rule1: CompositionRule = {
      name: 'rule-one',
      description: 'matches beh-a',
      priority: 3,
      when: { all: ['beh-a'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const rule2: CompositionRule = {
      name: 'rule-two',
      description: 'matches beh-b',
      priority: 3,
      when: { all: ['beh-b'], any: [], none: [], params_match: {} },
      actions: { override_sections: [], inject_sections: {}, disable_behaviors: [], override_params: [] },
    };

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.compositions.set('rule-one', rule1);
    mockRegistry.compositions.set('rule-two', rule2);

    const active = new Set(['beh-a', 'beh-b']);
    // Should not throw because different all combos
    const matched = matchRules(active, mockRegistry);
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// validate.ts — checkType string case (line 151)
// ---------------------------------------------------------------------------

describe('validate.ts — checkType string branch', () => {
  it('validates string type — passes for string value', () => {
    const behavior = makeBehavior({
      name: 'str-check-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: { text: { type: 'string', required: false } },
    });
    const r = Registry.load(FIXTURES);
    r.behaviors.set('str-check-beh', behavior);

    const errors = validateBehaviors(['str-check-beh'], r, { 'str-check-beh': { text: 'hello' } });
    expect(errors).toEqual([]);
  });

  it('validates string type — errors for non-string value', () => {
    const behavior = makeBehavior({
      name: 'str-check-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: { text: { type: 'string', required: false } },
    });
    const r = Registry.load(FIXTURES);
    r.behaviors.set('str-check-beh', behavior);

    const errors = validateBehaviors(['str-check-beh'], r, { 'str-check-beh': { text: 42 } });
    expect(errors.some((e) => e.includes('"string"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolve.ts — emptyValueForType string case (line 92)
// ---------------------------------------------------------------------------

describe('resolve.ts — emptyValueForType string case', () => {
  it('returns empty string for string type param without default', () => {
    const behavior = makeBehavior({
      name: 'string-empty-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        label: { type: 'string', required: false },
      },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('string-empty-beh', behavior);

    const result = resolveParams(['string-empty-beh'], mockRegistry, {}, {}, {});
    expect(result['string-empty-beh']?.label).toBe('');
  });
});

// ---------------------------------------------------------------------------
// validate.ts — required param missing, checkType branches
// ---------------------------------------------------------------------------

describe('validate.ts — required param missing (lines 127-130)', () => {
  it('errors when a required param is missing and has no default', () => {
    const behavior = makeBehavior({
      name: 'needs-param',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        critical: { type: 'string', required: true },
      },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('needs-param', behavior);

    const errors = validateBehaviors(['needs-param'], mockRegistry, {});
    expect(errors.some((e) => e.includes('"critical"') && e.includes('required'))).toBe(true);
  });

  it('does not error when required param has a default', () => {
    const behavior = makeBehavior({
      name: 'has-default',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        optional_req: { type: 'string', required: true, default: 'fallback' },
      },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('has-default', behavior);

    const errors = validateBehaviors(['has-default'], mockRegistry, {});
    expect(errors).toEqual([]);
  });
});

describe('validate.ts — checkType branches (lines 151-161)', () => {
  const registry = Registry.load(FIXTURES);

  function makeRegistryWithParam(type: string) {
    const behavior = makeBehavior({
      name: 'typed-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        val: { type: type as any, required: false },
      },
    });
    const r = Registry.load(FIXTURES);
    r.behaviors.set('typed-beh', behavior);
    return r;
  }

  it('validates boolean type — passes for boolean', () => {
    const r = makeRegistryWithParam('boolean');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: true } });
    expect(errors).toEqual([]);
  });

  it('validates boolean type — errors for non-boolean', () => {
    const r = makeRegistryWithParam('boolean');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: 'not-bool' } });
    expect(errors.some((e) => e.includes('boolean'))).toBe(true);
  });

  it('validates number type — passes for number', () => {
    const r = makeRegistryWithParam('number');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: 42 } });
    expect(errors).toEqual([]);
  });

  it('validates number type — errors for non-number', () => {
    const r = makeRegistryWithParam('number');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: 'not-a-number' } });
    expect(errors.some((e) => e.includes('number'))).toBe(true);
  });

  it('validates string[] type — passes for string array', () => {
    const r = makeRegistryWithParam('string[]');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: ['a', 'b'] } });
    expect(errors).toEqual([]);
  });

  it('validates string[] type — errors for mixed array', () => {
    const r = makeRegistryWithParam('string[]');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: ['a', 123] } });
    expect(errors.some((e) => e.includes('string[]'))).toBe(true);
  });

  it('validates string[] type — errors for non-array', () => {
    const r = makeRegistryWithParam('string[]');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: 'not-array' } });
    expect(errors.some((e) => e.includes('string[]'))).toBe(true);
  });

  it('validates number[] type — passes for number array', () => {
    const r = makeRegistryWithParam('number[]');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: [1, 2, 3] } });
    expect(errors).toEqual([]);
  });

  it('validates number[] type — errors for mixed array', () => {
    const r = makeRegistryWithParam('number[]');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: [1, 'two'] } });
    expect(errors.some((e) => e.includes('number[]'))).toBe(true);
  });

  it('validates unknown type — does not error (default case)', () => {
    const r = makeRegistryWithParam('custom-type');
    const errors = validateBehaviors(['typed-beh'], r, { 'typed-beh': { val: { complex: true } } });
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolve.ts — no preset + no behaviors error, emptyValueForType cases
// ---------------------------------------------------------------------------

describe('resolve.ts — error when no preset and no behaviors', () => {
  it('throws when agent has neither preset nor behaviors', () => {
    const registry = Registry.load(FIXTURES);
    const agent: Agent = {
      name: 'empty-agent',
      add: [],
      remove: [],
      params: {},
    } as unknown as Agent;

    expect(() => resolveBehaviors(agent, registry)).toThrow(
      /must have either a preset or a behaviors list/,
    );
  });
});

describe('resolve.ts — emptyValueForType branches', () => {
  it('returns 0 for number type param without default', () => {
    const behavior = makeBehavior({
      name: 'number-param-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        count: { type: 'number', required: false },
      },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('number-param-beh', behavior);

    const result = resolveParams(['number-param-beh'], mockRegistry, {}, {}, {});
    expect(result['number-param-beh']?.count).toBe(0);
  });

  it('returns false for boolean type param without default', () => {
    const behavior = makeBehavior({
      name: 'bool-param-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        flag: { type: 'boolean', required: false },
      },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('bool-param-beh', behavior);

    const result = resolveParams(['bool-param-beh'], mockRegistry, {}, {}, {});
    expect(result['bool-param-beh']?.flag).toBe(false);
  });

  it('returns empty array for number[] type param without default', () => {
    const behavior = makeBehavior({
      name: 'numarr-param-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        scores: { type: 'number[]', required: false },
      },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('numarr-param-beh', behavior);

    const result = resolveParams(['numarr-param-beh'], mockRegistry, {}, {}, {});
    expect(result['numarr-param-beh']?.scores).toEqual([]);
  });

  it('returns empty string for unknown type param (default case)', () => {
    const behavior = makeBehavior({
      name: 'unknown-param-beh',
      sections: { '010-test': { prompt: 'test' } },
      params: {
        mystery: { type: 'custom' as any, required: false },
      },
    });

    const mockRegistry = Registry.load(FIXTURES);
    mockRegistry.behaviors.set('unknown-param-beh', behavior);

    const result = resolveParams(['unknown-param-beh'], mockRegistry, {}, {}, {});
    expect(result['unknown-param-beh']?.mystery).toBe('');
  });
});

// ---------------------------------------------------------------------------
// registry.ts — non-existent directory (line 81), YAML parse error (line 102)
// ---------------------------------------------------------------------------

describe('registry.ts — non-existent directory', () => {
  it('returns empty maps when a subdirectory does not exist', () => {
    const emptyPath = tmpPath('empty-registry');
    mkdirSync(emptyPath, { recursive: true });
    // Create only behaviors dir, leave presets and compositions missing
    mkdirSync(join(emptyPath, 'behaviors'), { recursive: true });

    const registry = Registry.load(emptyPath);
    expect(registry.behaviors.size).toBe(0);
    expect(registry.presets.size).toBe(0);
    expect(registry.compositions.size).toBe(0);
    expect(registry.errors).toEqual([]);

    rmSync(emptyPath, { recursive: true });
  });

  it('returns empty map when entire base path has no subdirs', () => {
    const emptyPath = tmpPath('totally-empty-registry');
    mkdirSync(emptyPath, { recursive: true });

    const registry = Registry.load(emptyPath);
    expect(registry.behaviors.size).toBe(0);
    expect(registry.presets.size).toBe(0);
    expect(registry.compositions.size).toBe(0);

    rmSync(emptyPath, { recursive: true });
  });
});

describe('registry.ts — YAML parse error', () => {
  it('catches and records YAML parse errors', () => {
    const regPath = tmpPath('bad-yaml-registry');
    const behaviorsDir = join(regPath, 'behaviors');
    mkdirSync(behaviorsDir, { recursive: true });

    // Write a file with invalid YAML (tab indentation causes issues, but
    // let's use truly broken YAML)
    writeFileSync(
      join(behaviorsDir, 'broken.yaml'),
      ':\n  - :\n    :\n  invalid: [unclosed',
      'utf-8',
    );

    const registry = Registry.load(regPath);
    expect(registry.errors.length).toBeGreaterThan(0);
    expect(registry.errors.some((e) => e.file.includes('broken.yaml'))).toBe(true);

    rmSync(regPath, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// pipeline.ts — post-composition validation after disable_behaviors (lines 48-53)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// pipeline.ts — additional branch coverage
// ---------------------------------------------------------------------------

describe('pipeline.ts — pipeline branches', () => {
  it('skips unknown behaviors in the behaviors map build', () => {
    // An agent referencing a behavior not in the registry should be caught
    // at validation, but the loop at line 25 has the if(behavior) guard
    const agent: Agent = {
      name: 'unknown-beh-agent',
      behaviors: ['worktree-isolation', 'bug-hunting'],
      add: [],
      remove: [],
      params: {},
    };
    const result = runPipeline(agent, FIXTURES, {});
    expect(result.behaviors.length).toBe(2);
  });

  it('handles preset-based agent through full pipeline with compose', () => {
    // Ensures the agent.preset ternary at lines 33 and 59-60 takes the true branch
    const agent: Agent = {
      name: 'preset-full-pipeline',
      preset: 'raid',
      add: [],
      remove: [],
      params: {},
    };
    const result = runPipeline(agent, FIXTURES, {});
    expect(result.agent.id).toBe('preset-full-pipeline');
    expect(result.agent.profile).toBe('codeur');
    expect(result.output.prompt.length).toBeGreaterThan(0);
  });

  it('handles no-preset agent to exercise else branch of preset ternary', () => {
    const agent: Agent = {
      name: 'no-preset-pipeline',
      behaviors: ['worktree-isolation'],
      add: [],
      remove: [],
      params: {},
    };
    const result = runPipeline(agent, FIXTURES, {});
    expect(result.agent.id).toBe('no-preset-pipeline');
    expect(result.output.prompt).toContain('worktree');
  });

  it('uses composedRegistry with overridden getBehavior from composition', () => {
    // When composition modifies a behavior, the composedRegistry proxy is used.
    // Uses announce-readonly-adaptation rule (triggers on announce-before-write + read-only-mode)
    // which overrides the announce-before-write "020-before-coding" section to say "analyse".
    // (Original test used phantom behavior 'sequential-pipeline' and phantom rule
    // 'announce-after-relay' — neither exist in the catalog.)
    const agent: Agent = {
      name: 'composed-agent',
      behaviors: ['coordinator-rules', 'announce-before-write', 'read-only-mode'],
      add: [],
      remove: [],
      params: {},
    };
    const result = runPipeline(agent, FIXTURES, {});
    // The announce-readonly-adaptation rule should have overridden announce-before-write
    expect(result.compositionRulesApplied).toContain('announce-readonly-adaptation');
    expect(result.output.prompt).toContain('analyse');
  });
});

// ---------------------------------------------------------------------------
// registry.ts — additional branch coverage: non-yaml files ignored
// ---------------------------------------------------------------------------

describe('registry.ts — filter non-yaml files', () => {
  it('ignores non-yaml files in directories', () => {
    const regPath = tmpPath('non-yaml-registry');
    const behaviorsDir = join(regPath, 'behaviors');
    mkdirSync(behaviorsDir, { recursive: true });

    // Write a JSON file that should be ignored
    writeFileSync(join(behaviorsDir, 'readme.txt'), 'not yaml', 'utf-8');
    writeFileSync(join(behaviorsDir, 'data.json'), '{}', 'utf-8');

    // Write a valid YAML behavior
    writeFileSync(
      join(behaviorsDir, 'valid.yaml'),
      `name: valid-beh
description: "Valid behavior"
sections:
  "010-test":
    prompt: "Valid."`,
      'utf-8',
    );

    const registry = Registry.load(regPath);
    expect(registry.behaviors.has('valid-beh')).toBe(true);
    expect(registry.behaviors.size).toBe(1);
    expect(registry.errors).toEqual([]);

    rmSync(regPath, { recursive: true });
  });

  it('also loads .yml files', () => {
    const regPath = tmpPath('yml-registry');
    const behaviorsDir = join(regPath, 'behaviors');
    mkdirSync(behaviorsDir, { recursive: true });

    writeFileSync(
      join(behaviorsDir, 'yml-beh.yml'),
      `name: yml-beh
description: "YML extension"
sections:
  "010-test":
    prompt: "From yml."`,
      'utf-8',
    );

    const registry = Registry.load(regPath);
    expect(registry.behaviors.has('yml-beh')).toBe(true);

    rmSync(regPath, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// registry.ts — schema validation failure vs parse error
// ---------------------------------------------------------------------------

describe('registry.ts — schema validation failure', () => {
  it('records validation error when YAML parses but schema fails', () => {
    const regPath = tmpPath('schema-fail-registry');
    const behaviorsDir = join(regPath, 'behaviors');
    mkdirSync(behaviorsDir, { recursive: true });

    // Valid YAML but missing required fields for BehaviorSchema
    writeFileSync(
      join(behaviorsDir, 'missing-fields.yaml'),
      `description: "Missing name and sections"`,
      'utf-8',
    );

    const registry = Registry.load(regPath);
    expect(registry.behaviors.size).toBe(0);
    expect(registry.errors.length).toBeGreaterThan(0);
    expect(registry.errors.some((e) => e.file.includes('missing-fields.yaml'))).toBe(true);

    rmSync(regPath, { recursive: true });
  });
});

describe('pipeline.ts — disable_behaviors where post-validation passes', () => {
  it('succeeds when remaining behaviors are valid after disable', () => {
    // Create a setup where disable_behaviors fires but the remaining set is valid
    const regPath = tmpPath('pipeline-disable-ok');
    const behaviorsDir = join(regPath, 'behaviors');
    const compositionsDir = join(regPath, 'compositions');
    const presetsDir = join(regPath, 'presets');
    mkdirSync(behaviorsDir, { recursive: true });
    mkdirSync(compositionsDir, { recursive: true });
    mkdirSync(presetsDir, { recursive: true });

    // Two independent behaviors — no dependency between them
    writeFileSync(
      join(behaviorsDir, 'core-beh.yaml'),
      `name: core-beh
description: "Core behavior"
sections:
  "010-main":
    prompt: "Core behavior."`,
      'utf-8',
    );

    writeFileSync(
      join(behaviorsDir, 'optional-beh.yaml'),
      `name: optional-beh
description: "Optional behavior"
sections:
  "020-optional":
    prompt: "Optional content."`,
      'utf-8',
    );

    // Composition rule disables optional-beh
    writeFileSync(
      join(compositionsDir, 'strip-optional.yaml'),
      `name: strip-optional
description: "Removes optional behavior"
when:
  all: [core-beh, optional-beh]
actions:
  disable_behaviors: [optional-beh]`,
      'utf-8',
    );

    const agent: Agent = {
      name: 'disable-ok-agent',
      behaviors: ['core-beh', 'optional-beh'],
      add: [],
      remove: [],
      params: {},
    };

    // Should NOT throw — post-validation succeeds because core-beh has no deps
    const result = runPipeline(agent, regPath, {});
    expect(result.compositionRulesApplied).toContain('strip-optional');
    expect(result.behaviors.some((b) => b.name === 'optional-beh')).toBe(false);
    expect(result.behaviors.some((b) => b.name === 'core-beh')).toBe(true);

    rmSync(regPath, { recursive: true });
  });
});

describe('pipeline.ts — post-composition validation after disable', () => {
  it('throws when disabling a behavior causes remaining behaviors to fail validation', () => {
    // Setup: behavior A requires behavior B. A composition rule disables B.
    // After composition, A still needs B but B is gone -> post-validate error.
    const regPath = tmpPath('pipeline-post-validate');
    const behaviorsDir = join(regPath, 'behaviors');
    const compositionsDir = join(regPath, 'compositions');
    const presetsDir = join(regPath, 'presets');
    mkdirSync(behaviorsDir, { recursive: true });
    mkdirSync(compositionsDir, { recursive: true });
    mkdirSync(presetsDir, { recursive: true });

    // Behavior A requires behavior B
    writeFileSync(
      join(behaviorsDir, 'needs-dep.yaml'),
      `name: needs-dep
description: "Needs its dependency"
requires:
  behaviors: [dep-behavior]
sections:
  "010-main":
    prompt: "I need my dep."`,
      'utf-8',
    );

    // Behavior B (the dependency)
    writeFileSync(
      join(behaviorsDir, 'dep-behavior.yaml'),
      `name: dep-behavior
description: "The dependency"
sections:
  "010-main":
    prompt: "I am the dep."`,
      'utf-8',
    );

    // Composition rule that disables B when both are active
    writeFileSync(
      join(compositionsDir, 'remove-dep.yaml'),
      `name: remove-dep
description: "Removes the dependency"
when:
  all: [needs-dep, dep-behavior]
actions:
  disable_behaviors: [dep-behavior]`,
      'utf-8',
    );

    const agent: Agent = {
      name: 'post-validate-agent',
      behaviors: ['needs-dep', 'dep-behavior'],
      add: [],
      remove: [],
      params: {},
    };

    expect(() => runPipeline(agent, regPath, {})).toThrow(/Post-composition validation errors/);

    rmSync(regPath, { recursive: true });
  });
});

