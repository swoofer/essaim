// src/types.ts
import type { ChildProcess } from "child_process";

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
  setup?: string;
  during_run?: string;
  teardown?: string;
  metrics: string[];
  compare_mode?: boolean;
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
}

export interface CoordinatorMetrics {
  agents_count: number;
  duration_total_ms: number;
  threads_opened: number;
  threads_resolved_consensus: number;
  threads_auto_resolved: number;
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


