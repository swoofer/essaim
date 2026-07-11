// src/template-loader.ts
// Loads swarm templates from YAML files (bundled catalog + project overrides).
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse } from "yaml";
import { getTemplatesDir } from "../cli/bce-resolver.js";

// Template definitions map template IDs to BCE presets + orchestration config.
export interface TemplateDefinition {
  name: string;
  description: string;
  phase: number;
  workspace: 'worktree' | 'shared';
  stagger: { mode: 'fixed' | 'random' | 'sequential'; delay?: [number, number] };
  timeout_minutes: number;
  metrics: string[];
  compare_mode: boolean;
  // Each agent role in this template
  agents: Array<{
    idPrefix: string;
    namePrefix: string;
    preset: string;
    profile: 'codeur' | 'communicant';
    role?: string;
    launch_delay?: number;
    // count semantics:
    //   number    — exactly N agents
    //   'dynamic' — derive N from context.modules.length (capped 2..4)
    //   'per-module' — one agent per entry in context.modules; combine with
    //                  perModuleParam to give each its own value
    count?: number | 'dynamic' | 'per-module';
    params?: Record<string, Record<string, unknown>>;
    // perModuleParam (only with count: 'per-module'): for each agent i,
    // inject context.modules[i] as params[behavior][key]. The agent's
    // idPrefix is also suffixed with the module name (e.g. migrator-shared)
    // so the dashboard shows which slice each agent owns.
    perModuleParam?: { behavior: string; key: string };
    // perModuleRegisterOwnOnly (only with count: 'per-module'): if true,
    // register the agent's coordinator `modules` as just [its own module]
    // instead of the full project list. Use this when each agent should
    // primarily attract consultations on its own slice; cross-slice
    // collaboration still works because announce_work can target multiple
    // modules. Defaults to false (= full module list, broad collaboration).
    perModuleRegisterOwnOnly?: boolean;
  }>;
}

const REQUIRED = [
  "name", "description", "phase", "workspace", "stagger",
  "timeout_minutes", "metrics", "compare_mode", "agents",
] as const;

function loadDir(dir: string, out: Record<string, TemplateDefinition>): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const doc = parse(readFileSync(join(dir, f), "utf-8")) as Record<string, unknown>;
    for (const k of REQUIRED) {
      if (doc[k] === undefined) throw new Error(`template ${f}: missing required field "${k}"`);
    }
    if (!Array.isArray(doc.agents) || doc.agents.length === 0) {
      throw new Error(`template ${f}: "agents" must be a non-empty array`);
    }
    out[basename(f).replace(/\.ya?ml$/, "")] = doc as unknown as TemplateDefinition;
  }
}

/**
 * Load swarm templates: bundled catalog (templates/) merged with the target
 * project's .essaim/templates/ — project entries override catalog ones.
 * No cache: called once per run, and tests need fresh reads.
 */
export function loadTemplates(projectPath?: string): Record<string, TemplateDefinition> {
  const out: Record<string, TemplateDefinition> = {};
  loadDir(getTemplatesDir(), out);
  if (projectPath) loadDir(join(projectPath, ".essaim", "templates"), out);
  return out;
}
