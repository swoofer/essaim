// src/types.ts
import type { ChildProcess } from "child_process";
import type { MiniProjectSecurity, SecurityRunLedger } from "../security/types.js";
import type { TurnDetail, ExitReason } from "../agent-loop/agent-loop.js";

export interface AgentConfig {
  id: string;
  name: string;
  role?: string;
  prompt: string;
  profile: "codeur" | "communicant";
  tools?: string[];
  model?: string;
  modules?: string[];      // modules this agent works on (for coordination)
  read_only?: boolean;
  launch_delay?: number; // Seconds to wait before launching (overrides stagger for group launching)
  // BCE pipeline outputs — required for coordinated runs, populated by buildProjectFromBce
  hooks: Record<string, string>; // lifecycle → assembled shell script
  envVars: Record<string, string>;
  mcpTools: string[];
  phases?: Array<{
    name: string;
    prompt: string;
    toolsMode: "read_only" | "full" | "none";
    loop: boolean;
    effort?: string;
  }>;
}

export interface MiniProject {
  id: string;
  name: string;
  description: string;
  phase: 1 | 2 | 3;
  agents: AgentConfig[];
  workspace: {
    type: "worktree" | "shared" | "none";
    base?: string;
    baseRef?: string; // git ref (tag, branch, sha) for the worktree snapshot — defaults to HEAD
  };
  stagger: {
    mode: "fixed" | "random" | "sequential";
    // Pour "fixed" et "random": délai entre chaque lancement [min, max] en secondes
    // Pour "sequential": ignoré — chaque agent attend la fin du précédent
    delay?: [number, number];
  };
  timeout_minutes?: number;
  use_legacy_mode?: boolean; // Opt-out: fall back to claude -p one-shot instead of agent-loop
  // Caps how many agents are launched (and running) at once during fan-out,
  // independent of stagger config. Defaults to 8. Composes with stagger: a
  // sequential/staggered project already launches at most one (or a delayed
  // trickle of) agents at a time and never hits this ceiling; it only bounds
  // configs where stagger.mode is "fixed"/"random" with delay omitted, which
  // otherwise launches every agent in project.agents back-to-back with no wait.
  max_concurrency?: number;
  setup?: string;
  during_run?: string;
  teardown?: string;
  metrics: string[];
  compare_mode?: boolean;
  security?: MiniProjectSecurity; // set by `essaim security`; gates the orchestrator security steps
}

export interface AgentProcess {
  config: AgentConfig;
  process: ChildProcess;
  workspacePath: string;
}

export interface WorkspaceResult {
  type: "worktree" | "shared" | "none";
  basePath: string;
  paths: Map<string, string>; // agent_id → workspace path
  baseSha?: string; // commit the worktrees branch off — diff baseline (#29)
  // agent_id → nom de branche. Source UNIQUE du nom : il était reconstruit à
  // l'identique sur 4 sites (workspace.ts × 2, orchestrator.ts × 2), ce qui
  // laissait le nettoyage libre de diverger de la création. Vide sauf pour
  // type === "worktree".
  branches: Map<string, string>;
}

export interface CoordinatorMetrics {
  agents_count: number;
  duration_total_ms: number;
  threads_opened: number;
  threads_resolved_consensus: number;
  threads_auto_resolved: number;
  // Threads opened for which the coordinator never emitted a thread_resolved of
  // type consensus or auto_resolved: poisoned (repeated unclaims — a table
  // UPDATE with no SSE event), resolved by timeout, max_rounds, or simply
  // abandoned. This is the only place in the report where these threads still
  // show up.
  threads_without_consensus: number;
  messages_exchanged: number;
  conflicts_by_layer: Record<string, number>;
  introspections_triggered: number;
  introspections_concerned: number;
  avg_resolution_time_ms: number;
  hot_files: string[];
}

export interface RunResult {
  project_id: string;
  project_name: string;
  mode: "with_coordinator" | "without_coordinator";
  duration_ms: number;
  coordinator_metrics: CoordinatorMetrics;
  agent_results: AgentResult[];
  custom_metrics: Record<string, unknown>;
  worktrees?: { agent_id: string; path: string; branch: string }[];
  security?: SecurityRunLedger; // present only for security runs; rendered by the reporter
}

export interface AgentResult {
  agent_id: string;
  agent_name: string;
  exit_code: number;
  diff: string;
  // False when the workspace is shared: every agent edits the same tree, so a
  // per-agent diff is not attributable. Reported as N/A rather than a fake 0/1.
  diff_measured?: boolean;
  compilation_ok?: boolean;
  stdout_length: number;
  // Token + cost diagnostics (populated from AgentLoopResult when available)
  turns_count?: number;
  total_cost_usd?: number;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  cost_by_phase?: Record<string, number>;
  cost_by_model?: Record<string, number>;
  // Per-turn detail: the only place tokens are attributable to a PHASE.
  // cost_by_phase holds dollars only, and those are all 0 under an OAuth
  // subscription — the phase breakdown it feeds is structurally empty.
  turn_details?: TurnDetail[];
  // Why the loop stopped. exit_code alone cannot tell "died before spending
  // anything" from "spent, then died".
  exit_reason?: ExitReason;
}

export interface ProjectContext {
  path: string;
  language: string;
  source_dirs: string[];
  test_dirs: string[];
  test_command: string;
  source_files: string[];
  has_git: boolean;
  is_clean: boolean;
  modules: string[];
  applicable_templates: string[];
}


