// src/template-loader.ts
// Loads swarm templates from YAML files (bundled catalog + project overrides).
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, basename } from "path";
import { parse } from "yaml";
import { getTemplatesDirs, type CatalogOptions } from "../cli/bce-resolver.js";

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
    // Validate each agent HERE, where we still know the file and the index.
    // Left unchecked, a template with a typo'd agent fails much later and much
    // further away — a missing `preset` surfaces as an opaque registry lookup
    // error, with nothing pointing back at the template that caused it.
    doc.agents.forEach((agent: unknown, i: number) => {
      const where = `template ${f}: agents[${i}]`;
      if (typeof agent !== "object" || agent === null) {
        throw new Error(`${where} must be an object`);
      }
      const a = agent as Record<string, unknown>;
      for (const key of ["idPrefix", "namePrefix", "preset", "profile"]) {
        if (typeof a[key] !== "string" || !a[key]) {
          throw new Error(`${where}: missing or invalid "${key}" (expected a non-empty string)`);
        }
      }
      if (a.profile !== "codeur" && a.profile !== "communicant") {
        throw new Error(`${where}: "profile" must be "codeur" or "communicant", got "${String(a.profile)}"`);
      }
      if (
        a.count !== undefined &&
        typeof a.count !== "number" &&
        a.count !== "dynamic" &&
        a.count !== "per-module"
      ) {
        throw new Error(`${where}: "count" must be a number, "dynamic" or "per-module", got "${String(a.count)}"`);
      }
    });
    out[basename(f).replace(/\.ya?ml$/, "")] = doc as unknown as TemplateDefinition;
  }
}

/**
 * Load swarm templates: bundled catalog (templates/) merged with the target
 * project's .essaim/templates/ — project entries override catalog ones.
 * No cache: called once per run, and tests need fresh reads.
 */
export function loadTemplates(
  projectPath?: string,
  opts: CatalogOptions = {},
): Record<string, TemplateDefinition> {
  const out: Record<string, TemplateDefinition> = {};
  // Precedence order — the last root wins, and `.essaim/templates/` of the target
  // project is already the last root when projectPath is given.
  for (const dir of getTemplatesDirs({ ...opts, projectPath })) {
    loadDir(dir, out);
  }
  return out;
}
