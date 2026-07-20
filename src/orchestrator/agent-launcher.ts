// src/agent-launcher.ts
import { spawn, ChildProcess } from "child_process";
import type { AgentConfig } from "./types.js";
import { runAgentLoop, type AgentLoopConfig, type AgentLoopResult } from "../agent-loop/agent-loop.js";

const MCP_COORDINATOR_PREFIX = "mcp__coordinator__";

// Fallback allowlist when the agent has no BCE-assembled tools (e.g. legacy
// callers or manual agents). Prefer agent.mcpTools from the BCE pipeline.
const DEFAULT_MCP_TOOLS = [
  "register_agent",
  "list_agents",
  "heartbeat",
  "announce_work",
  "post_to_thread",
  "propose_resolution",
  "approve_resolution",
  "contest_resolution",
  "close_thread",
  "cancel_thread",
  "get_thread",
  "get_thread_updates",
  "list_threads",
  "log_action_summary",
  "hot_files",
  "get_session_files",
  "check_file_conflict",
  "set_dependency_map",
  "get_blast_radius",
  "get_module_info",
  "coordinator_status",
  "wait_for_message",
  "get_queued_messages",
  "mqtt_publish",
  "agent_activity",
];

const CODE_TOOLS = ["Edit", "Read", "Write", "Bash", "Glob", "Grep"];
const READ_ONLY_TOOLS = ["Read", "Bash", "Glob", "Grep"];

function prefixMcpTools(names: string[]): string[] {
  return names.map((n) => (n.startsWith(MCP_COORDINATOR_PREFIX) ? n : `${MCP_COORDINATOR_PREFIX}${n}`));
}

export function buildAllowedTools(agent: AgentConfig): string {
  // Precedence: manual agent.tools override > BCE-assembled agent.mcpTools > default fallback
  const bareMcpTools = agent.tools
    ?? (agent.mcpTools && agent.mcpTools.length > 0 ? agent.mcpTools : DEFAULT_MCP_TOOLS);
  const mcpTools = prefixMcpTools(bareMcpTools);
  const codeTools = agent.read_only ? READ_ONLY_TOOLS : CODE_TOOLS;
  return [...mcpTools, ...codeTools].join(",");
}

export function launchAgent(
  agent: AgentConfig,
  workspacePath: string,
  coordinatorUrl: string,
  mcpConfigPath: string | null,
  coordinatorPrompt?: string
): ChildProcess {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    COORDINATOR_URL: coordinatorUrl,
    COORDINATOR_AGENT_ID: agent.id,
    COORDINATOR_AGENT_NAME: agent.name,
  };
  if (agent.model) env.ANTHROPIC_MODEL = agent.model;

  const promptParts = [agent.prompt];
  if (coordinatorPrompt) promptParts.push(coordinatorPrompt);
  const fullPrompt = promptParts.join("\n\n");

  const allowedTools = buildAllowedTools(agent);
  const args = ["-p", fullPrompt, "--allowedTools", allowedTools];
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }

  return spawn("claude", args, {
    cwd: workspacePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ── Agent Loop mode ───────────────────────────────────────────────────
// Replaces claude -p one-shot with a programmatic agent loop that
// guarantees coordination protocol execution via code, receives MQTT
// messages in real-time, and uses the LLM only for decisions.

/**
 * Derive the MQTT WebSocket URL from the coordinator HTTP URL.
 * http://localhost:3100 → ws://localhost:3100/mqtt
 */
export function mqttWsUrl(coordinatorUrl: string): string {
  const u = new URL(coordinatorUrl);
  const protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // Preserve any path prefix (coordinator served under a sub-path behind an
  // ingress); strip a trailing slash so we don't emit `//mqtt`.
  const base = u.pathname.replace(/\/+$/, "");
  return `${protocol}//${u.host}${base}/mqtt`;
}

/**
 * Build the allowed tools list for agent-loop mode.
 * Excludes coordination tools that the code handles directly:
 * announce_work, propose_resolution, approve_resolution, contest_resolution.
 * The LLM keeps read-only MCP tools (get_thread, list_agents, etc.) and code tools.
 */
function buildAgentLoopAllowedTools(agent: AgentConfig): string[] {
  const coordinationOnlyTools = new Set([
    "register_agent",
    "announce_work",
    "propose_resolution",
    "approve_resolution",
    "contest_resolution",
    "close_thread",
    "cancel_thread",
    "wait_for_message",
    "get_queued_messages",
    "mqtt_publish",
  ]);
  const bareMcpTools = agent.tools
    ?? (agent.mcpTools && agent.mcpTools.length > 0 ? agent.mcpTools : DEFAULT_MCP_TOOLS);
  const filtered = bareMcpTools.filter((t) => !coordinationOnlyTools.has(t));
  const mcpTools = prefixMcpTools(filtered);
  const codeTools = agent.read_only ? READ_ONLY_TOOLS : CODE_TOOLS;
  return [...mcpTools, ...codeTools];
}

export interface LaunchAgentLoopOptions {
  // Wall-clock deadline (absolute ms epoch). The agent-loop stops at the next
  // safe checkpoint when reached and kills any running claude child.
  deadlineMs?: number;
  // Fires when the orchestrator needs the agent to stop (e.g. global timeout).
  abortSignal?: AbortSignal;
  // Max Anthropic quota utilization % before the agent stops claiming new
  // work-stealing tasks. Typically matches the orchestrator's pre-flight
  // threshold so the agent mirrors the raid-level policy.
  maxQuotaPct?: number;
}

export async function launchAgentLoop(
  agent: AgentConfig,
  workspacePath: string,
  coordinatorUrl: string,
  mcpConfigPath: string | null,
  coordinatorPrompt?: string,
  opts: LaunchAgentLoopOptions = {},
): Promise<AgentLoopResult> {
  const promptParts = [agent.prompt];
  if (coordinatorPrompt) promptParts.push(coordinatorPrompt);
  const fullPrompt = promptParts.join("\n\n");

  const config: AgentLoopConfig = {
    agentId: agent.id,
    agentName: agent.name,
    modules: agent.modules || [],
    coordinatorUrl,
    mqttUrl: mqttWsUrl(coordinatorUrl),
    workspacePath,
    mcpConfigPath: mcpConfigPath || "",
    prompt: fullPrompt,
    allowedTools: buildAgentLoopAllowedTools(agent),
    model: agent.model,
    phases: agent.phases,
    maxTurns: 50,
    // Re-run discover/review up to 3 times if the work pool empties while the
    // agent still has turn budget — helps raids keep finding new issues.
    maxDiscoverCycles: 3,
    // Bound cache-write growth — each execute task gets a fresh session
    // instead of accumulating every prior file read in one giant --resume.
    // Cost: each task re-caches the system prompt (Anthropic deduplicates it
    // via the prompt cache, so cheap in practice).
    freshSessionPerTask: true,
    dangerouslySkipPermissions: true,
    deadlineMs: opts.deadlineMs,
    abortSignal: opts.abortSignal,
    maxQuotaPct: opts.maxQuotaPct,
    env: {
      COORDINATOR_URL: coordinatorUrl,
      COORDINATOR_AGENT_ID: agent.id,
      COORDINATOR_AGENT_NAME: agent.name,
    },
  };

  return runAgentLoop(config);
}

export function waitForProcess(child: ChildProcess): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code: code || 0 }));
  });
}

export function randomDelay(min: number, max: number): Promise<void> {
  const ms = (min + Math.random() * (max - min)) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fixedDelay(min: number, max: number): Promise<void> {
  const ms = ((min + max) / 2) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}


