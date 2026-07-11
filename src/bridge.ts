// bce/engine/bridge.ts
import { resolve } from 'path';
import { runPipeline } from '@swoofer/promptweave';
import type { PipelineResult } from '@swoofer/promptweave';

// Import the orchestrator types for MiniProject compatibility
// We define a minimal interface here to avoid circular deps
interface BceMiniProject {
  id: string;
  name: string;
  description: string;
  phase: number;
  agents: Array<{
    id: string;
    name: string;
    prompt: string;
    profile: 'codeur' | 'communicant';
    role?: string;
    read_only?: boolean;
    modules?: string[]; // forwarded to coordinator registration (respondent matching)
    launch_delay?: number;
    // BCE-assembled outputs — consumed by orchestrator to write .claude/ files
    hooks: Record<string, string>;
    envVars: Record<string, string>;
    mcpTools: string[];
    phases?: Array<{
      name: string;
      prompt: string;
      toolsMode: 'read_only' | 'full' | 'none';
      loop: boolean;
      effort?: string;
    }>;
  }>;
  workspace: { type: 'worktree' | 'shared' | 'none'; base: string };
  stagger: { mode: 'fixed' | 'random' | 'sequential'; delay?: [number, number] };
  timeout_minutes: number;
  metrics: string[];
  compare_mode: boolean;
}

import { getCatalogRoot } from "../cli/bce-resolver.js";
import { loadTemplates } from "./template-loader.js";

const AGENT_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];

export function buildProjectFromBce(
  templateId: string,
  context: { path: string; language: string; test_command: string; modules: string[]; source_files: string[] },
  options?: { agentCount?: number; setParams?: Record<string, Record<string, unknown>> },
  projectPath?: string,
): BceMiniProject {
  const templates = loadTemplates(projectPath);
  const def = templates[templateId];
  if (!def) {
    const available = Object.keys(templates).join(', ');
    throw new Error(`Unknown BCE template: "${templateId}". Available: ${available}`);
  }

  if (options?.agentCount !== undefined) {
    const hasDynamic = def.agents.some((a) => a.count === "dynamic");
    if (!hasDynamic) {
      console.warn(
        `Warning: Template '${templateId}' has fixed agent count, --agents ignored`,
      );
    }
  }

  const agents: BceMiniProject['agents'] = [];

  for (const agentDef of def.agents) {
    let count: number;
    if (agentDef.count === "dynamic") {
      count = options?.agentCount ?? Math.max(2, Math.min(context.modules.length || 2, 4));
    } else if (agentDef.count === "per-module") {
      if (context.modules.length === 0) {
        throw new Error(
          `Template '${templateId}' uses count: 'per-module' but context.modules is empty. ` +
          `Provide modules via the project scanner or override via the run config.`,
        );
      }
      count = context.modules.length;
    } else {
      count = agentDef.count ?? 1;
    }

    for (let i = 0; i < count; i++) {
      // 'per-module' uses the module name as suffix (visible on the dashboard),
      // others use the numeric / phonetic suffix as before.
      const moduleForAgent = agentDef.count === "per-module" ? context.modules[i]! : null;
      const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();
      const suffix = moduleForAgent !== null
        ? `-${slug(moduleForAgent)}`
        : (count > 1 ? `-${i + 1}` : '');
      const nameSuffix = moduleForAgent !== null
        ? ` ${moduleForAgent}`
        : (count > 1 ? ` ${AGENT_NAMES[i] || (i + 1)}` : '');
      const agentId = `${agentDef.idPrefix}${suffix}`;
      const agentName = `${agentDef.namePrefix}${nameSuffix}`;

      // Inject the per-module behavior param (e.g. migrate-slice.target_slice = "auth")
      // from agentDef.perModuleParam. Merged into the agent's params so the
      // behavior template can reference {{params.target_slice}}.
      const perModuleParams: Record<string, Record<string, unknown>> = {};
      if (agentDef.perModuleParam && moduleForAgent !== null) {
        perModuleParams[agentDef.perModuleParam.behavior] = {
          ...(agentDef.params?.[agentDef.perModuleParam.behavior] ?? {}),
          [agentDef.perModuleParam.key]: moduleForAgent,
        };
      }

      // Build launch params from context
      const launchParams: Record<string, Record<string, unknown>> = {
        "project-context": {
          language: context.language,
          test_command: context.test_command,
          modules: context.modules,
        },
        ...(agentDef.params ?? {}),
        ...perModuleParams,
        ...(options?.setParams ?? {}),
      };

      // Run BCE pipeline to get the full assembled output
      const agent = {
        name: agentId,
        displayName: agentName,
        preset: agentDef.preset,
        add: [],
        remove: [],
        params: {},
      };
      const result = runPipeline(agent, getCatalogRoot(), launchParams);

      // Modules registered with the coordinator for respondent matching.
      // Default = full project list (broad collaboration: every agent is a
      // respondent for every announce). Per-module templates can opt into
      // own-only registration (one slice per agent) so consultations route
      // to the slice owner.
      const registeredModules = (agentDef.count === "per-module" && agentDef.perModuleRegisterOwnOnly && moduleForAgent !== null)
        ? [moduleForAgent]
        : context.modules;

      agents.push({
        id: agentId,
        name: agentName,
        prompt: result.output.prompt,
        profile: agentDef.profile,
        role: agentDef.idPrefix,
        modules: registeredModules,
        launch_delay: agentDef.launch_delay,
        hooks: result.output.hooks,
        envVars: result.output.envVars,
        mcpTools: result.output.mcpTools,
        phases: result.output.phases,
      });
    }
  }

  return {
    id: templateId,
    name: def.name,
    description: def.description,
    phase: def.phase,
    agents,
    workspace: { type: def.workspace, base: context.path },
    stagger: def.stagger,
    timeout_minutes: def.timeout_minutes,
    metrics: def.metrics,
    compare_mode: def.compare_mode,
  };
}

export function listBceTemplates(): { id: string; name: string; description: string }[] {
  return Object.entries(loadTemplates()).map(([id, def]) => ({
    id, name: def.name, description: def.description,
  }));
}

export function buildSoloPrompt(
  templateId: string,
  context: { language: string; test_command: string; modules: string[] },
  setParams?: Record<string, Record<string, unknown>>,
  projectPath?: string,
): string {
  const templates = loadTemplates(projectPath);
  const def = templates[templateId];
  if (!def) {
    const available = Object.keys(templates).join(", ");
    throw new Error(
      `Unknown BCE template: "${templateId}". Available: ${available}`,
    );
  }

  const agentDef = def.agents[0];
  const launchParams: Record<string, Record<string, unknown>> = {
    "project-context": {
      language: context.language,
      test_command: context.test_command,
      modules: context.modules,
    },
    "coordinator-rules": { solo_mode: true },
    ...(agentDef.params ?? {}),
    ...(setParams ?? {}),
  };

  const agent = {
    name: "solo",
    preset: agentDef.preset,
    add: [] as string[],
    remove: [] as string[],
    params: {} as Record<string, Record<string, unknown>>,
  };
  const result = runPipeline(agent, getCatalogRoot(), launchParams);
  return result.output.prompt;
}

