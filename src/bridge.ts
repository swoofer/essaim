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

// Template definitions map template IDs to BCE presets + orchestration config
interface TemplateDefinition {
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
    count?: number | 'dynamic'; // 'dynamic' = based on modules/files
    params?: Record<string, Record<string, unknown>>;
  }>;
}

const TEMPLATE_DEFS: Record<string, TemplateDefinition> = {
  raid: {
    name: 'Le Raid',
    description: 'Agents chassent les bugs et edge cases manquants',
    phase: 2,
    workspace: 'worktree',
    stagger: { mode: 'random', delay: [5, 10] },
    timeout_minutes: 20,
    metrics: ['bugs_found', 'tests_added'],
    compare_mode: false,
    agents: [{
      idPrefix: 'agent-chasseur', namePrefix: 'Chasseur', preset: 'raid',
      profile: 'codeur', count: 'dynamic',
    }],
  },
  melee: {
    name: 'La Melee',
    description: 'N agents ecrivent des tests en parallele',
    phase: 1,
    workspace: 'worktree',
    stagger: { mode: 'random', delay: [5, 15] },
    timeout_minutes: 20,
    metrics: ['tests_written', 'tests_passing'],
    compare_mode: true,
    agents: [{
      idPrefix: 'agent', namePrefix: 'Agent', preset: 'melee',
      profile: 'codeur', count: 'dynamic',
    }],
  },
  swarm: {
    name: "L'Essaim",
    description: 'N agents refactorisent en parallele',
    phase: 2,
    workspace: 'worktree',
    stagger: { mode: 'random', delay: [3, 8] },
    timeout_minutes: 20,
    metrics: ['files_refactored', 'tests_passing'],
    compare_mode: false,
    agents: [{
      idPrefix: 'agent-refacteur', namePrefix: 'Refacteur', preset: 'swarm',
      profile: 'codeur', count: 'dynamic',
    }],
  },
  revue: {
    name: 'La Revue',
    description: 'N auteurs + N reviewers en croisement',
    phase: 2,
    workspace: 'worktree',
    stagger: { mode: 'random', delay: [5, 10] },
    timeout_minutes: 20,
    metrics: ['review_comments', 'approvals'],
    compare_mode: false,
    agents: [
      { idPrefix: 'auteur', namePrefix: 'Auteur', preset: 'revue-author', profile: 'codeur', count: 'dynamic' },
      { idPrefix: 'reviewer', namePrefix: 'Reviewer', preset: 'revue-reviewer', profile: 'communicant', count: 'dynamic', launch_delay: 120 },
    ],
  },
  maitre: {
    name: 'Le Maitre',
    description: '1 lead distribue aux workers',
    phase: 2,
    workspace: 'worktree',
    stagger: { mode: 'random', delay: [8, 12] },
    timeout_minutes: 20,
    metrics: ['worker_idle_time', 'task_distribution_quality'],
    compare_mode: false,
    agents: [
      { idPrefix: 'tech-lead', namePrefix: 'Tech Lead', preset: 'maitre-lead', profile: 'communicant', count: 1, launch_delay: 0 },
      { idPrefix: 'worker', namePrefix: 'Worker', preset: 'maitre-worker', profile: 'codeur', count: 'dynamic', launch_delay: 10 },
    ],
  },
  gardien: {
    name: 'Le Gardien',
    description: '1 agent analyse la qualite du projet',
    phase: 1,
    workspace: 'shared',
    stagger: { mode: 'fixed', delay: [0, 0] },
    timeout_minutes: 10,
    metrics: ['issues_found', 'categories_scanned'],
    compare_mode: false,
    agents: [{
      idPrefix: 'agent-gardien', namePrefix: 'Le Gardien', preset: 'gardien',
      profile: 'communicant', count: 1,
    }],
  },
  relais: {
    name: 'Le Relais',
    description: '3 coureurs se relaient sequentiellement',
    phase: 2,
    workspace: 'worktree',
    stagger: { mode: 'sequential' },
    timeout_minutes: 25,
    metrics: ['improvements_per_runner', 'tests_passing'],
    compare_mode: false,
    agents: [
      { idPrefix: 'agent-coureur-1', namePrefix: 'Coureur 1', preset: 'relais-1', profile: 'codeur', count: 1 },
      { idPrefix: 'agent-coureur-2', namePrefix: 'Coureur 2', preset: 'relais-2', profile: 'codeur', count: 1 },
      { idPrefix: 'agent-coureur-3', namePrefix: 'Coureur 3', preset: 'relais-3', profile: 'codeur', count: 1 },
    ],
  },
  chaine: {
    name: 'La Chaine',
    description: 'Pipeline sequentiel: implementer, reviewer, tester',
    phase: 2,
    workspace: 'worktree',
    stagger: { mode: 'sequential' },
    timeout_minutes: 25,
    metrics: ['pipeline_stages_completed', 'tests_passing'],
    compare_mode: false,
    agents: [
      { idPrefix: 'agent-implementeur', namePrefix: 'Implementeur', preset: 'chaine-implement', profile: 'codeur', count: 1 },
      { idPrefix: 'agent-reviewer', namePrefix: 'Reviewer', preset: 'chaine-review', profile: 'communicant', count: 1, launch_delay: 5 },
      { idPrefix: 'agent-testeur', namePrefix: 'Testeur', preset: 'chaine-test', profile: 'codeur', count: 1, launch_delay: 10 },
    ],
  },
  debat: {
    name: 'Le Debat',
    description: '3 agents debattent une approche de refactor',
    phase: 3,
    workspace: 'shared',
    stagger: { mode: 'fixed', delay: [0, 0] },
    timeout_minutes: 15,
    metrics: ['rounds_to_consensus', 'contestations'],
    compare_mode: false,
    agents: [
      { idPrefix: 'agent-separation', namePrefix: 'Agent Separation', preset: 'debat', profile: 'communicant', count: 1, params: { 'debate-position': { position: 'Tu favorises le decoupage par responsabilite (un fichier par concern). Argumente la lisibilite et testabilite.' } } },
      { idPrefix: 'agent-strategy', namePrefix: 'Agent Strategy', preset: 'debat', profile: 'communicant', count: 1, params: { 'debate-position': { position: 'Tu favorises le pattern Strategy (interface + implementations). Argumente la configurabilite.' } } },
      { idPrefix: 'agent-minimal', namePrefix: 'Agent Minimal', preset: 'debat', profile: 'communicant', count: 1, params: { 'debate-position': { position: 'Tu favorises le refactor minimal (extraire seulement les helpers). Argumente que le risque depasse le benefice.' } } },
    ],
  },
  babel: {
    name: 'Babel',
    description: 'Traducteur + reviseur traduisent la documentation',
    phase: 1,
    workspace: 'worktree',
    stagger: { mode: 'sequential' },
    timeout_minutes: 15,
    metrics: ['files_translated', 'review_issues'],
    compare_mode: false,
    agents: [
      { idPrefix: 'agent-traducteur', namePrefix: 'Traducteur', preset: 'babel-translator', profile: 'communicant', count: 1 },
      { idPrefix: 'agent-reviseur', namePrefix: 'Reviseur', preset: 'babel-reviewer', profile: 'communicant', count: 1 },
    ],
  },
  arene: {
    name: "L'Arene",
    description: 'Jeu de trivia sur la base de code',
    phase: 1,
    workspace: 'shared',
    stagger: { mode: 'fixed', delay: [0, 0] },
    timeout_minutes: 10,
    metrics: ['questions_asked', 'correct_answers'],
    compare_mode: false,
    agents: [
      { idPrefix: 'agent-quizmaster', namePrefix: 'Quizmaster', preset: 'arene-quizmaster', profile: 'communicant', count: 1 },
      { idPrefix: 'agent-joueur-a', namePrefix: 'Joueur A', preset: 'arene-player', profile: 'communicant', count: 1, params: { 'quiz-player': { player_name: 'Joueur A', focus_area: 'structure du projet' } } },
      { idPrefix: 'agent-joueur-b', namePrefix: 'Joueur B', preset: 'arene-player', profile: 'communicant', count: 1, params: { 'quiz-player': { player_name: 'Joueur B', focus_area: 'patterns et architecture' } } },
    ],
  },
  carrefour: {
    name: 'Le Carrefour',
    description: 'Agents croisent leurs intentions sur les memes fichiers',
    phase: 3,
    workspace: 'worktree',
    stagger: { mode: 'random', delay: [3, 8] },
    timeout_minutes: 15,
    metrics: ['conflicts_detected', 'conflicts_resolved', 'consultations_opened'],
    compare_mode: false,
    agents: [{
      idPrefix: 'agent', namePrefix: 'Agent', preset: 'carrefour',
      profile: 'codeur', count: 'dynamic',
    }],
  },
  phare: {
    name: 'Le Phare',
    description: '4 auditeurs spécialisés en parallèle + 1 réconciliateur — audit multi-angles',
    phase: 2,
    workspace: 'shared',
    stagger: { mode: 'fixed', delay: [0, 0] },
    timeout_minutes: 30,
    metrics: ['specialists_completed', 'reconciliations', 'disagreements_flagged'],
    compare_mode: false,
    agents: [
      { idPrefix: 'inventaire', namePrefix: 'Inventaire', preset: 'phare-inventaire', profile: 'communicant', count: 1, launch_delay: 0 },
      { idPrefix: 'edges', namePrefix: 'Edges', preset: 'phare-edges', profile: 'communicant', count: 1, launch_delay: 0 },
      { idPrefix: 'deps', namePrefix: 'Deps', preset: 'phare-deps', profile: 'communicant', count: 1, launch_delay: 0 },
      { idPrefix: 'risques', namePrefix: 'Risques', preset: 'phare-risques', profile: 'communicant', count: 1, launch_delay: 0 },
      { idPrefix: 'synth', namePrefix: 'Reconciliateur', preset: 'phare-synth', profile: 'communicant', count: 1, launch_delay: 60 },
    ],
  },
};

const AGENT_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];

export function buildProjectFromBce(
  templateId: string,
  context: { path: string; language: string; test_command: string; modules: string[]; source_files: string[] },
  options?: { agentCount?: number; setParams?: Record<string, Record<string, unknown>> },
): BceMiniProject {
  const def = TEMPLATE_DEFS[templateId];
  if (!def) {
    const available = Object.keys(TEMPLATE_DEFS).join(', ');
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
    const count =
      agentDef.count === "dynamic"
        ? (options?.agentCount ?? Math.max(2, Math.min(context.modules.length || 2, 4)))
        : (agentDef.count ?? 1);

    for (let i = 0; i < count; i++) {
      const suffix = count > 1 ? `-${i + 1}` : '';
      const nameSuffix = count > 1 ? ` ${AGENT_NAMES[i] || (i + 1)}` : '';
      const agentId = `${agentDef.idPrefix}${suffix}`;
      const agentName = `${agentDef.namePrefix}${nameSuffix}`;

      // Build launch params from context
      const launchParams: Record<string, Record<string, unknown>> = {
        "project-context": {
          language: context.language,
          test_command: context.test_command,
          modules: context.modules,
        },
        ...(agentDef.params ?? {}),
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

      agents.push({
        id: agentId,
        name: agentName,
        prompt: result.output.prompt,
        profile: agentDef.profile,
        role: agentDef.idPrefix,
        // Pre-register modules so consultation matching picks this agent as a
        // respondent. Without this, announce_work computes expected_respondents
        // = [] for every thread → propose_resolution waits for absent voters
        // → threads only close via the timeout sweeper. Default to the full
        // project module list (every specialist is relevant to every other
        // specialist's announces). Per-agent overrides could be added later
        // via agentDef.modules if a template needs narrower scoping.
        modules: context.modules,
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
  return Object.entries(TEMPLATE_DEFS).map(([id, def]) => ({
    id, name: def.name, description: def.description,
  }));
}

export function buildSoloPrompt(
  templateId: string,
  context: { language: string; test_command: string; modules: string[] },
  setParams?: Record<string, Record<string, unknown>>,
): string {
  const def = TEMPLATE_DEFS[templateId];
  if (!def) {
    const available = Object.keys(TEMPLATE_DEFS).join(", ");
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

