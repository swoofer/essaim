import { createClaudeStream, type ClaudeStreamClient, type AssistantResponse, type SendOptions, type TokenUsage, BudgetExceededError, AbortError } from "./claude-stream.js";
import { createMqttListener, type MqttListener, type MqttInterrupt, type InterruptType } from "./mqtt-listener.js";
import {
  createCoordinationProtocol,
  type CoordinationProtocol,
  type ProtocolAction,
  type WorkDescription,
  type AnnounceResult,
} from "./coordination-protocol.js";
import { parseDiscoveries, postDiscoveries, claimNextTask, completeTask, unclaimTask, parseReviewActions, fetchExistingThreads, processReviewActions } from "./work-stealing.js";
import { createLogger } from "../logger.js";
import { resolveEffort, upgradeEffort, parseSeverity, EFFORT_PROFILES, isThinkingLevel, type EffortLevel, type ConcreteEffortLevel, type ThinkingLevel } from "./effort.js";
import { authHeaders } from "../coordinator-auth.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface AgentLoopConfig {
  agentId: string;
  agentName: string;
  modules: string[];
  coordinatorUrl: string;
  mqttUrl: string;           // mqtt://localhost:1883 (TCP) or ws://localhost:3100/mqtt (WebSocket)
  workspacePath: string;
  mcpConfigPath: string;
  prompt: string;
  allowedTools?: string[];
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  dangerouslySkipPermissions?: boolean;
  // Max times the phased sequence (discover → review → execute) is re-run
  // when execute exits with an empty pool while real work was done.
  // Default 1 (no re-discover). Raise this for raids that need extra pool refills.
  maxDiscoverCycles?: number;
  // When true, each execute work-stealing task starts a fresh claude session.
  // Trades cache accumulation (each task losing the shared cache built by
  // discover/prior tasks) against bounded cache growth. Helps when the
  // per-agent cache-write volume is the main quota eater. Default false.
  freshSessionPerTask?: boolean;
  env?: Record<string, string>;
  // Wall-clock deadline (absolute ms epoch). When reached, the loop stops at the
  // next safe checkpoint (between phases / between work-stealing iterations) and
  // SIGKILLs any running claude child. Prevents zombie agents from surviving
  // orchestrator timeouts. Undefined = no deadline.
  deadlineMs?: number;
  // External abort. Firing this aborts the current claude send and breaks the
  // loop at the next checkpoint. Used by the orchestrator on timeout.
  abortSignal?: AbortSignal;
  // Max Anthropic quota utilization % before the work-stealing loop stops
  // claiming new tasks. Undefined = no quota guardrail at the agent level
  // (orchestrator pre-flight is the first line of defence). Default 95.
  maxQuotaPct?: number;
  phases?: Array<{
    name: string;
    prompt: string;
    toolsMode: "read_only" | "full" | "none";
    loop: boolean;
    maxTurns?: number;
    effort?: string;
    model?: string;
    thinking?: string;
  }>;
}

export type ExitReason =
  | "done"
  | "yielded"
  | "max_turns"
  | "budget_exceeded"
  | "process_died"
  | "deadline_exceeded"
  | "aborted"
  | "rate_limited"
  | "error";

export interface TurnDetail {
  turn: number;
  phase: string;                // "discover" | "review" | "execute" | "main" | "coordination"
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolCallCount: number;
  contentLength: number;
}

export interface AgentLoopResult {
  agentId: string;
  exitReason: ExitReason;
  summary: string;
  totalCostUsd: number;
  turnsCount: number;
  mqttMessagesProcessed: number;
  durationMs: number;
  // Per-turn token/cost accounting for diagnostics.
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  costByPhase: Record<string, number>;
  costByModel: Record<string, number>;
  turnDetails: TurnDetail[];
}

export interface AgentLoopLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const DEFAULT_MAX_TURNS = 50;
const RESPONSE_WAIT_MS = 30_000;
const APPROVAL_WAIT_MS = 20_000;

// The DONE marker is how an agent tells the loop it has finished. Detection has
// to tolerate how an LLM actually types it, not how the prompt spells it:
// essaim's prompts are all in French, and French typography puts a space before
// a colon ("DONE : résumé", often a non-breaking one). Models also emphasise the
// marker in markdown. A literal `includes("DONE:")` misses every one of those —
// the agent has delivered, nobody hears it say so, and the loop spins to its
// maxTurns cap before exiting non-zero (#31).
const DONE_PATTERN = /\bDONE\b[ \t  ]*[*_`]*[ \t  ]*:/i;

export function hasDoneMarker(content: string): boolean {
  return DONE_PATTERN.test(content);
}

/**
 * Text after the marker. The LAST marker wins: an agent routinely echoes its
 * instruction ("je terminerai par DONE: <résumé>") before doing the work, and
 * the first match would capture the echo instead of the real summary.
 */
export function extractDoneSummary(content: string, fallback: string): string {
  const scan = new RegExp(DONE_PATTERN.source, "gi");
  let last: RegExpExecArray | null = null;
  for (let m = scan.exec(content); m !== null; m = scan.exec(content)) {
    last = m;
  }
  if (!last) return fallback;
  return content.slice(last.index + last[0].length).replace(/^[*_`\s]+/, "").trim() || fallback;
}

// Interrupt types that are handled silently (state update only, no LLM call)
const SILENT_INTERRUPT_TYPES: Set<InterruptType> = new Set([
  "consultation_claimed",
  "consultation_completed",
  "consultation_resolved",
  "consultation_resolving",
  "agent_online",
  "agent_offline",
]);

// ── Per-phase tool restriction ─────────────────────────────────────────
// Tools mode drives which user-facing tools the agent can call during a phase.
// MCP tools (prefix "mcp__") pass through unconditionally since coordination
// depends on them. The session-level allowedTools (from the orchestrator) is
// the superset; we filter it down for stricter modes.
const READ_ONLY_USER_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "Bash",
]);

// Claude Code built-in tools that could be invoked even when not in
// --allowedTools. Used to build explicit --disallowedTools lists for modes
// that need hard blocks (since --dangerously-skip-permissions auto-approves
// every tool regardless of --allowedTools). Includes common user-facing and
// meta tools; MCP tools are never blocked.
const ALL_USER_TOOLS: readonly string[] = [
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "NotebookEdit", "WebFetch", "WebSearch",
  "Task", "Agent", "TodoWrite", "ExitPlanMode", "Skill", "ToolSearch",
];
const WRITE_USER_TOOLS: readonly string[] = ["Write", "Edit", "NotebookEdit"];
// Spawning sub-agents from inside a work-stealing task multiplies cost/latency:
// each Agent call is another Claude session running its own tool loop, invisible
// in the outer turn count. We always block it — the work-stealing task itself
// is already an agent, nested agents just explode the budget.
const NESTED_AGENT_TOOLS: readonly string[] = ["Task", "Agent"];

function toolsForMode(
  toolsMode: "read_only" | "full" | "none",
  sessionAllowedTools: string[] | undefined,
): string[] | undefined {
  if (toolsMode === "full") return sessionAllowedTools;
  if (!sessionAllowedTools) return undefined;
  const mcpTools = sessionAllowedTools.filter((t) => t.startsWith("mcp__"));
  if (toolsMode === "none") return mcpTools;
  // read_only: MCP + read-only user tools (intersected with the session allowlist)
  const readUserTools = sessionAllowedTools.filter((t) => READ_ONLY_USER_TOOLS.has(t));
  return [...mcpTools, ...readUserTools];
}

function disallowedForMode(
  toolsMode: "read_only" | "full" | "none",
): string[] {
  // Nested agents are blocked in every mode — see NESTED_AGENT_TOOLS comment.
  if (toolsMode === "full") return [...NESTED_AGENT_TOOLS];
  if (toolsMode === "none") return [...ALL_USER_TOOLS];
  // read_only: block write tools explicitly + nested agents
  return [...WRITE_USER_TOOLS, ...NESTED_AGENT_TOOLS];
}

// ── Prompt injections ──────────────────────────────────────────────────

const AGENT_LOOP_SYSTEM_SUFFIX = `
Tu travailles en mode agent-loop. Le système gère la coordination pour toi.

Règles :
- Fais UNE action par réponse (un Edit, un Read, un Bash...)
- N'appelle PAS announce_work, post_to_thread, propose_resolution — le système le fait
- Quand tu as fini le travail, dis "DONE: <résumé en une phrase>"
- Quand le système t'injecte un interrupt, réponds-y avant de continuer
`.trim();

function formatInterrupts(interrupts: MqttInterrupt[]): string {
  const lines = interrupts.map((i) => {
    const parts = [`[${i.type}]`];
    if (i.agentId) parts.push(`from ${i.agentId}`);
    if (i.threadId) parts.push(`thread=${i.threadId}`);
    if (i.subject) parts.push(`subject: ${i.subject}`);
    if (i.content) parts.push(i.content);
    return parts.join(" ");
  });
  return `[INTERRUPTION SYSTÈME] Les messages suivants viennent d'autres agents. Réponds-y brièvement avant de continuer ton travail. ${lines.join(" | ")}`;
}

function formatCoordinationContext(context: string, responses: string): string {
  return `[CONTEXTE COORDINATION] ${context} Réponses des autres agents: ${responses} Que fais-tu? Réponds par CONTINUE, YIELD, ou ADJUST suivi de ton nouveau plan.`;
}

// ── Coordinator REST helpers ───────────────────────────────────────────

async function coordinatorPost(
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Cannot reach coordinator at ${url} — is the server running? (${(err as Error).message})`);
  }
  if (!resp.ok) throw new Error(`Coordinator ${url} returned ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

async function announceViaRest(
  coordinatorUrl: string,
  agentId: string,
  work: WorkDescription,
): Promise<AnnounceResult> {
  // POST /api/announce — exists in serve-http.ts
  const data = await coordinatorPost(`${coordinatorUrl}/api/announce`, {
    agent_id: agentId,
    subject: work.subject,
    plan: work.plan,
    target_modules: work.targetModules,
    target_files: work.targetFiles,
    depends_on_files: work.dependsOnFiles,
    exports_affected: work.exportsAffected,
  });

  const threadId = (data.thread_id as string) || "";
  const status = (data.status as string) || "open";
  const impact = data.impact as Record<string, unknown[]> | undefined;
  const concerned = (impact?.concerned as Array<{ agent_id: string }>) || [];

  return {
    threadId,
    status: status === "resolved" ? "auto_resolved" : "open",
    expectedRespondents: concerned.map((c) => c.agent_id),
    context: JSON.stringify(data),
  };
}

async function postToThreadViaRest(
  coordinatorUrl: string,
  threadId: string,
  agentId: string,
  agentName: string,
  content: string,
): Promise<void> {
  await coordinatorPost(`${coordinatorUrl}/api/post-to-thread`, {
    thread_id: threadId,
    agent_id: agentId,
    agent_name: agentName,
    type: "context",
    content,
  });
}

async function proposeResolutionViaRest(
  coordinatorUrl: string,
  threadId: string,
  agentId: string,
  summary: string,
): Promise<void> {
  await coordinatorPost(`${coordinatorUrl}/api/propose-resolution`, {
    thread_id: threadId,
    agent_id: agentId,
    summary,
  });
}

async function approveResolutionViaRest(
  coordinatorUrl: string,
  threadId: string,
  agentId: string,
): Promise<void> {
  await coordinatorPost(`${coordinatorUrl}/api/approve-resolution`, {
    thread_id: threadId,
    agent_id: agentId,
  });
}

// ── Main loop ──────────────────────────────────────────────────────────

const defaultLogger: AgentLoopLogger = createLogger("agent-loop");

export async function runAgentLoop(
  config: AgentLoopConfig,
  logger: AgentLoopLogger = defaultLogger,
): Promise<AgentLoopResult> {
  const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
  const startTime = Date.now();
  let totalCost = 0;
  let turnsCount = 0;
  let mqttMessagesProcessed = 0;
  let exitReason: ExitReason = "done";
  let summary = "";
  // ── Token + cost diagnostics ──────────────────────────────────────────
  const totalTokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const costByPhase: Record<string, number> = {};
  const costByModel: Record<string, number> = {};
  const turnDetails: TurnDetail[] = [];
  let currentPhase = "coordination";  // updated as the loop transitions phases

  // ── ① INIT ──────────────────────────────────────────────────────────

  logger.info("Starting agent loop", { agentId: config.agentId, maxTurns });

  const claude: ClaudeStreamClient = createClaudeStream({
    workspacePath: config.workspacePath,
    mcpConfigPath: config.mcpConfigPath,
    allowedTools: config.allowedTools,
    model: config.model,
    appendSystemPrompt: AGENT_LOOP_SYSTEM_SUFFIX,
    maxBudgetUsd: config.maxBudgetUsd,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    abortSignal: config.abortSignal,
    env: {
      ...config.env,
      COORDINATOR_URL: config.coordinatorUrl,
      COORDINATOR_AGENT_ID: config.agentId,
      COORDINATOR_AGENT_NAME: config.agentName,
    },
  });

  // Separate lightweight session for interrupt responses (Fix 5: don't pollute main context).
  // Hardcoded to haiku (low effort) — interrupts are ack-level work and never need opus.
  const interruptClaude: ClaudeStreamClient = createClaudeStream({
    workspacePath: config.workspacePath,
    model: EFFORT_PROFILES.low.model,
    appendSystemPrompt: "Tu reçois des notifications d'autres agents. Réponds en 1-2 phrases max.",
    maxTurns: 1,
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    abortSignal: config.abortSignal,
    env: config.env,
  });

  // ── Termination gates (F1 + F2) ───────────────────────────────────────
  // checkTermination() returns an ExitReason if the loop must stop (deadline hit,
  // orchestrator aborted). Callers treat a truthy return as a hard break signal.
  function checkTermination(): ExitReason | null {
    if (config.abortSignal?.aborted) return "aborted";
    if (config.deadlineMs !== undefined && Date.now() >= config.deadlineMs) return "deadline_exceeded";
    return null;
  }

  function remainingBudgetMs(): number {
    if (config.deadlineMs === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, config.deadlineMs - Date.now());
  }

  // Pre-task quota guardrail: hits the coordinator's cached /api/quota endpoint
  // before each work-stealing claim. The coordinator caches with a 30s TTL so
  // this is cheap and doesn't hammer the Anthropic API. Returns a block reason
  // if five_hour or seven_day meets/exceeds the threshold. Returns null
  // (= proceed) on 503 / network error — matches the fail-open decision for
  // quota checks.
  const MAX_QUOTA_PCT = config.maxQuotaPct ?? 95;
  async function quotaBlocksNextTask(): Promise<string | null> {
    if (config.maxQuotaPct === undefined) return null;  // guardrail disabled
    try {
      const resp = await fetch(`${config.coordinatorUrl}/api/quota`, { headers: authHeaders() });
      if (resp.status === 503 || !resp.ok) return null;  // unknown = proceed
      const data = await resp.json() as {
        five_hour?: { utilization: number; minutesUntilReset: number };
        seven_day?: { utilization: number; minutesUntilReset: number };
      };
      const five = data.five_hour?.utilization ?? 0;
      const seven = data.seven_day?.utilization ?? 0;
      if (five >= MAX_QUOTA_PCT) {
        return `five_hour at ${five.toFixed(1)}% (≥ ${MAX_QUOTA_PCT}% max, resets in ${data.five_hour?.minutesUntilReset}min)`;
      }
      if (seven >= MAX_QUOTA_PCT) {
        return `seven_day at ${seven.toFixed(1)}% (≥ ${MAX_QUOTA_PCT}% max, resets in ${data.seven_day?.minutesUntilReset}min)`;
      }
      return null;
    } catch {
      return null;  // network / parse errors = fail-open
    }
  }

  // Track which threads this agent has claimed (for MQTT filtering)
  const claimedThreadIds = new Set<string>();

  const mqtt: MqttListener = createMqttListener({
    url: config.mqttUrl,
    agentId: config.agentId,
    agentModules: config.modules,
  });

  const protocol: CoordinationProtocol = createCoordinationProtocol(config.agentId);

  try {
    await mqtt.connect();
    logger.info("MQTT connected", { url: config.mqttUrl });
  } catch (err) {
    logger.warn("MQTT connection failed — running without push notifications", {
      error: (err as Error).message,
    });
  }

  // ── Helper: send to claude and track cost + tokens ────────────────

  function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  }

  async function postTokenUsageSse(detail: TurnDetail): Promise<void> {
    try {
      await fetch(`${config.coordinatorUrl}/api/token-usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          agent_id: config.agentId,
          agent_name: config.agentName,
          turn: detail.turn,
          phase: detail.phase,
          model: detail.model,
          cost_usd: detail.costUsd,
          duration_ms: detail.durationMs,
          input_tokens: detail.inputTokens,
          output_tokens: detail.outputTokens,
          cache_read_tokens: detail.cacheReadTokens,
          cache_creation_tokens: detail.cacheCreationTokens,
        }),
      });
    } catch {
      // Never block on telemetry — coordinator might be down
    }
  }

  async function send(content: string, opts?: SendOptions): Promise<AssistantResponse> {
    logger.info(`Sending to claude (${content.length} chars): ${content.slice(0, 80)}...`);
    const resp = await claude.send(content, opts);

    totalCost += resp.costUsd;
    turnsCount++;

    // Accumulate tokens
    const t: TokenUsage = resp.tokens ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    totalTokens.input += t.inputTokens;
    totalTokens.output += t.outputTokens;
    totalTokens.cacheRead += t.cacheReadTokens;
    totalTokens.cacheCreation += t.cacheCreationTokens;

    // Aggregate cost breakdowns
    costByPhase[currentPhase] = (costByPhase[currentPhase] || 0) + resp.costUsd;
    const model = opts?.model ?? config.model ?? "unknown";
    costByModel[model] = (costByModel[model] || 0) + resp.costUsd;

    // Cache hit ratio — % of input tokens served from cache (cheap)
    const totalInputAttempted = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
    const cacheHitPct = totalInputAttempted > 0
      ? Math.round((t.cacheReadTokens / totalInputAttempted) * 100)
      : 0;

    const detail: TurnDetail = {
      turn: turnsCount,
      phase: currentPhase,
      model,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      costUsd: resp.costUsd,
      durationMs: resp.durationMs,
      toolCallCount: resp.toolCalls.length,
      contentLength: resp.content.length,
    };
    turnDetails.push(detail);

    logger.info(
      `Turn ${turnsCount} [${currentPhase}] ${model.split("-")[1] ?? model}: ` +
      `in=${formatTokens(t.inputTokens)} out=${formatTokens(t.outputTokens)} ` +
      `cache-r=${formatTokens(t.cacheReadTokens)} cache-w=${formatTokens(t.cacheCreationTokens)} ` +
      `hit=${cacheHitPct}% cost=$${resp.costUsd.toFixed(4)} ` +
      `(${resp.durationMs}ms, ${resp.toolCalls.length} tools)`,
    );

    // Fire-and-forget telemetry to coordinator for live dashboard — never blocks
    void postTokenUsageSse(detail);

    return resp;
  }

  function phaseEffortProfile(phase: {
    toolsMode: "read_only" | "full" | "none";
    loop: boolean;
    effort?: string;
    model?: string;
    thinking?: string;
    maxTurns?: number;
  }): { level: ConcreteEffortLevel; model: string; thinking: ThinkingLevel; maxTurns: number } {
    const raw = (phase.effort ?? "auto") as EffortLevel;
    const level = resolveEffort(raw, { toolsMode: phase.toolsMode, loop: phase.loop });
    const profile = EFFORT_PROFILES[level];
    // Per-dimension override escape hatches — each phase param takes precedence over the profile default.
    // Empty-string model/thinking (YAML default) are treated as unset so they don't clobber the profile.
    const model = phase.model && phase.model !== "" ? phase.model : profile.model;
    const thinking: ThinkingLevel =
      phase.thinking && phase.thinking !== "" && isThinkingLevel(phase.thinking)
        ? phase.thinking
        : profile.thinking;
    // Treat 0 as "unset" — it's nonsensical as a turn budget and leaks from resolveParams defaults.
    const maxTurns = phase.maxTurns && phase.maxTurns > 0 ? phase.maxTurns : profile.maxTurns;
    return { level, model, thinking, maxTurns };
  }

  // ── Helper: process MQTT interrupts (Fix 1: silent filtering) ─────

  async function processInterrupts(): Promise<boolean> {
    const interrupts = mqtt.drain();
    if (interrupts.length === 0) return false;

    mqttMessagesProcessed += interrupts.length;

    const important: MqttInterrupt[] = [];

    for (const interrupt of interrupts) {
      // Always feed to protocol state machine (no LLM needed)
      if (interrupt.type === "consultation_message" && interrupt.threadId && interrupt.agentId) {
        protocol.onThreadMessage(interrupt.threadId, interrupt.agentId, interrupt.content || "");
      }
      if (interrupt.type === "consultation_resolving" && interrupt.threadId) {
        protocol.onResolutionProposed(interrupt.threadId);
      }

      // Silent types: log and skip LLM
      if (SILENT_INTERRUPT_TYPES.has(interrupt.type)) {
        logger.debug("MQTT silent", { type: interrupt.type, threadId: interrupt.threadId });
        continue;
      }

      // consultation_new: only if target modules overlap with ours
      if (interrupt.type === "consultation_new") {
        const theirModules = interrupt.targetModules || [];
        const overlap = theirModules.length === 0 || theirModules.some(m =>
          config.modules.some(cm => m.startsWith(cm) || cm.startsWith(m))
        );
        if (!overlap) {
          logger.debug("MQTT skip (no module overlap)", { type: interrupt.type, threadId: interrupt.threadId });
          continue;
        }
      }

      // consultation_message: only if it's a thread we claimed
      if (interrupt.type === "consultation_message" && interrupt.threadId) {
        if (!claimedThreadIds.has(interrupt.threadId)) {
          logger.debug("MQTT skip (not our thread)", { type: interrupt.type, threadId: interrupt.threadId });
          continue;
        }
      }

      important.push(interrupt);
    }

    if (important.length === 0) {
      logger.debug("MQTT all silent", { total: interrupts.length });
      return false;
    }

    // Fix 5: send to separate session to avoid polluting main context
    logger.info("Processing important MQTT interrupts", { count: important.length, skipped: interrupts.length - important.length });
    const formatted = formatInterrupts(important);
    await interruptClaude.send(formatted, { maxTurns: 1 });
    return true;
  }

  // ── Helper: process protocol actions ──────────────────────────────

  async function processProtocolActions(): Promise<void> {
    for (;;) {
      const action = protocol.nextAction();
      if (!action) break;
      switch (action.type) {
        case "announce": {
          const result = await announceViaRest(
            config.coordinatorUrl,
            config.agentId,
            action.work,
          );
          protocol.onAnnounceResult(result);
          break;
        }
        case "wait_responses": {
          // Wait for MQTT messages for the timeout period
          await new Promise((r) => setTimeout(r, Math.min(action.timeoutMs, RESPONSE_WAIT_MS)));
          // Process any messages that arrived
          await processInterrupts();
          // If still waiting, timeout
          if (protocol.phase === "waiting" && protocol.currentThreadId) {
            protocol.onTimeout(protocol.currentThreadId);
          }
          break;
        }
        case "ask_llm_decide": {
          const resp = await send(
            formatCoordinationContext(action.threadId, action.responses),
          );
          const decision = resp.content.trim().toUpperCase();
          if (decision.startsWith("YIELD")) {
            protocol.decideYield();
          } else {
            protocol.decideContinue();
          }
          break;
        }
        case "ask_llm_respond": {
          const respondResp = await send(`Réponds au thread ${action.threadId}:\n${action.context}`);
          // Post the LLM's response to the coordinator via REST
          await postToThreadViaRest(
            config.coordinatorUrl,
            action.threadId,
            config.agentId,
            config.agentName,
            respondResp.content,
          ).catch((err) => logger.warn("Failed to post to thread", { error: (err as Error).message }));
          break;
        }
        case "propose_resolution": {
          // Ask LLM for a summary, then propose via REST
          const summaryResp = await send(
            `Le travail est terminé. Résume en 1-2 phrases ce que tu as fait pour le thread ${action.threadId}.`,
          );
          await proposeResolutionViaRest(
            config.coordinatorUrl,
            action.threadId,
            config.agentId,
            summaryResp.content,
          ).catch((err) => logger.warn("Failed to propose resolution", { error: (err as Error).message }));
          protocol.onResolutionProposed(action.threadId);
          break;
        }
        case "wait_approvals": {
          await new Promise((r) => setTimeout(r, Math.min(action.timeoutMs, APPROVAL_WAIT_MS)));
          await processInterrupts();
          if (protocol.phase === "resolving" && protocol.currentThreadId) {
            protocol.onTimeout(protocol.currentThreadId);
          }
          break;
        }
        case "work":
          // Proceed to work loop
          return;
        case "done":
          summary = action.summary;
          return;
      }
    }
  }

  // ── Main execution ────────────────────────────────────────────────

  try {
    // ② COORDINATION PHASE — announce work
    logger.info("Phase 2: announcing work");
    // Build a meaningful subject from agent + modules — NOT the full prompt.
    // The old behaviour leaked the multi-line coordination prompt into the
    // thread list, making the dashboard unreadable.
    const modulesPart = config.modules.length > 0 ? ` on ${config.modules.join(", ")}` : "";
    const work: WorkDescription = {
      subject: `${config.agentName} starting work${modulesPart}`.slice(0, 200),
      targetModules: config.modules,
      targetFiles: [],
    };
    protocol.startWork(work);
    await processProtocolActions();

    if (protocol.phase === "idle") {
      // Yielded during coordination
      exitReason = "yielded";
      summary = "Yielded during coordination phase";
      logger.info("Agent yielded", { agentId: config.agentId });
    } else {
      if (config.phases && config.phases.length > 0) {
        // ── PHASED MODE (work-stealing) ──
        logger.info(`Phased mode: ${config.phases.map((p) => `${p.name}${p.loop ? "(loop)" : ""}`).join(" → ")}`);
        let discoveryContent = "";
        const hasReviewPhase = config.phases.some((p) => p.name === "review");
        logger.info(`Review phase: ${hasReviewPhase ? "YES — discoveries will be deduped" : "NO — discoveries posted directly"}`);

        // Cycle the phases if the execute pool exhausted while we still had turn budget.
        // Each cycle re-runs discover/review to seed new threads for the pool.
        const MAX_DISCOVER_CYCLES = Math.max(1, config.maxDiscoverCycles ?? 1);
        let cycle = 0;
        let poolExhaustedLastCycle = false;
        let tasksDoneLastCycle = 0;

        while (cycle < MAX_DISCOVER_CYCLES && turnsCount < maxTurns) {
          const cycleGate = checkTermination();
          if (cycleGate) {
            logger.warn(`Phased mode: cycle halted — ${cycleGate}`);
            exitReason = cycleGate;
            break;
          }
          cycle++;
          if (cycle > 1) {
            logger.info(`═══ Re-discover cycle ${cycle}/${MAX_DISCOVER_CYCLES} — pool exhausted, looking for more work ═══`);
          }
          poolExhaustedLastCycle = false;
          tasksDoneLastCycle = 0;
          discoveryContent = "";

        for (const phase of config.phases) {
          const phaseGate = checkTermination();
          if (phaseGate) {
            logger.warn(`Phased mode: skipping phase ${phase.name} — ${phaseGate}`);
            exitReason = phaseGate;
            break;
          }
          currentPhase = phase.name;
          logger.info(`Phase: ${phase.name} (tools=${phase.toolsMode}, loop=${phase.loop})`);

          if (!phase.loop) {
            // Single-pass phase (e.g., discovery, review)

            if (phase.name === "discover") {
              const profile = phaseEffortProfile(phase);
              const phaseTools = toolsForMode(phase.toolsMode, config.allowedTools);
              const phaseBlocked = disallowedForMode(phase.toolsMode);
              logger.info(`Phase discover: effort=${profile.level} (model=${profile.model}, thinking=${profile.thinking}, maxTurns=${profile.maxTurns}, tools=${phaseTools?.length ?? "all"}, blocked=${phaseBlocked.length})`);
              const resp = await send(phase.prompt, { model: profile.model, thinking: profile.thinking, maxTurns: profile.maxTurns, allowedTools: phaseTools, disallowedTools: phaseBlocked });
              discoveryContent = resp.content;

              const tasks = parseDiscoveries(resp.content);
              // Always log parse results — critical for diagnosing the "0 tasks"
              // failure mode. Include preview of content after the DISCOVERY: marker
              // so we can see whether the LLM produced the expected format.
              const discIdx = resp.content.indexOf("DISCOVERY:");
              const discPreview = discIdx >= 0
                ? resp.content.slice(discIdx, discIdx + 300).replace(/\n/g, "\\n")
                : "(no DISCOVERY: marker)";
              logger.info(`Discovery: parseDiscoveries → ${tasks.length} items (content ${resp.content.length} chars, preview: ${discPreview})`);
              if (hasReviewPhase) {
                // DON'T post yet — wait for review phase
                if (tasks.length > 0) {
                  logger.info(`Discovery: found ${tasks.length} items (pending review)`);
                }
              } else {
                // No review phase — post discoveries immediately (backward compat)
                if (tasks.length > 0) {
                  logger.info(`Discovery: found ${tasks.length} items, posting to coordinator`);
                  await postDiscoveries(config.coordinatorUrl, config.agentId, tasks);
                }
              }

              if (hasDoneMarker(resp.content)) {
                summary = extractDoneSummary(resp.content, "Phase complete");
              }
            } else if (phase.name === "review") {
              // Fetch existing threads for comparison
              logger.debug("Review: fetching existing threads from coordinator");
              const existingThreads = await fetchExistingThreads(config.coordinatorUrl);
              logger.debug(`Review: existing threads:\n${existingThreads}`);
              logger.debug(`Review: my discovery content (${discoveryContent.length} chars)`);

              // Inject both lists into the review prompt
              const reviewPrompt = phase.prompt
                .replace(/\{\{params\.my_discoveries\}\}/g, discoveryContent)
                .replace(/\{\{params\.existing_threads\}\}/g, existingThreads);

              const reviewProfile = phaseEffortProfile(phase);
              const reviewTools = toolsForMode(phase.toolsMode, config.allowedTools);
              const reviewBlocked = disallowedForMode(phase.toolsMode);
              logger.info(`Phase review: effort=${reviewProfile.level} (model=${reviewProfile.model}, thinking=${reviewProfile.thinking}, maxTurns=${reviewProfile.maxTurns}, tools=${reviewTools?.length ?? "all"}, blocked=${reviewBlocked.length}, fresh=true)`);
              logger.debug(`Review: sending prompt to LLM (${reviewPrompt.length} chars)`);
              // Fresh session for review: (1) Haiku can't reuse Sonnet's discover cache anyway,
              // (2) the review prompt's dynamic params invalidate most of the cache on every cycle.
              const resp = await send(reviewPrompt, { model: reviewProfile.model, thinking: reviewProfile.thinking, maxTurns: reviewProfile.maxTurns, allowedTools: reviewTools, disallowedTools: reviewBlocked, freshSession: true });
              logger.debug(`Review: LLM response (${resp.content.length} chars): ${resp.content.slice(0, 200)}`);

              // Parse and process review actions
              const actions = parseReviewActions(resp.content);
              logger.debug(`Review: parsed ${actions.length} actions — ${actions.map((a) => a.type).join(", ") || "none"}`);
              if (actions.length > 0) {
                const result = await processReviewActions(
                  config.coordinatorUrl, config.agentId, config.agentName, actions
                );
                logger.info(`Review: ${result.posted} new, ${result.enriched} enriched, ${result.skipped} duplicates skipped`);
              } else {
                // Fallback: if LLM didn't follow format, post all discoveries as-is
                logger.warn("Review: no structured actions found, posting all discoveries as fallback");
                const tasks = parseDiscoveries(discoveryContent);
                const reviewPreview = resp.content.slice(0, 300).replace(/\n/g, "\\n");
                logger.info(`Review fallback: ${tasks.length} tasks parsed from discovery content (${discoveryContent.length} chars). Haiku's response preview: ${reviewPreview}`);
                if (tasks.length > 0) {
                  await postDiscoveries(config.coordinatorUrl, config.agentId, tasks);
                }
              }
            } else {
              const otherProfile = phaseEffortProfile(phase);
              const otherTools = toolsForMode(phase.toolsMode, config.allowedTools);
              const otherBlocked = disallowedForMode(phase.toolsMode);
              logger.info(`Phase ${phase.name}: effort=${otherProfile.level} (model=${otherProfile.model}, thinking=${otherProfile.thinking}, maxTurns=${otherProfile.maxTurns}, tools=${otherTools?.length ?? "all"}, blocked=${otherBlocked.length})`);
              const resp = await send(phase.prompt, { model: otherProfile.model, thinking: otherProfile.thinking, maxTurns: otherProfile.maxTurns, allowedTools: otherTools, disallowedTools: otherBlocked });
              if (hasDoneMarker(resp.content)) {
                summary = extractDoneSummary(resp.content, "Phase complete");
              }
            }
          } else {
            // Work-stealing loop with grace period for late discoveries
            let tasksDone = 0;
            let emptyRetries = 0;
            const MAX_EMPTY_RETRIES = 3;
            const EMPTY_WAIT_MS = 10_000;  // 10s between retries

            logger.info(`Work-stealing loop starting (maxTurns=${maxTurns})`);

            while (turnsCount < maxTurns) {
              // Termination gate: deadline / external abort check each iteration.
              // This is the lone guardrail preventing a rate-limit resume from
              // dragging the agent hours past the orchestrator's timeout.
              const termReason = checkTermination();
              if (termReason) {
                logger.warn(`Work-stealing: terminating — ${termReason}`);
                exitReason = termReason;
                break;
              }

              // Quota guardrail: stop claiming new tasks when the Anthropic
              // quota is pressing, so the agent finishes gracefully instead of
              // starting work it can't afford to complete.
              const quotaBlock = await quotaBlocksNextTask();
              if (quotaBlock) {
                logger.warn(`Work-stealing: stopping — quota ${quotaBlock}`);
                exitReason = "rate_limited";
                break;
              }

              // Check MQTT between tasks
              const mqttCount = mqtt.peek();
              if (mqttCount > 0) logger.debug(`Work-stealing: ${mqttCount} MQTT messages pending`);
              await processInterrupts();
              await processProtocolActions();
              if ((protocol.phase as string) === "idle" && summary) {
                logger.debug("Work-stealing: protocol idle — exiting loop");
                break;
              }

              // Claim next task
              logger.debug(`Work-stealing: attempting claim (turn ${turnsCount}/${maxTurns}, done=${tasksDone})`);
              const task = await claimNextTask(config.coordinatorUrl, config.agentId);

              if (!task) {
                emptyRetries++;
                if (emptyRetries > MAX_EMPTY_RETRIES) {
                  logger.info(`Work-stealing: pool empty after ${MAX_EMPTY_RETRIES} retries — done`);
                  poolExhaustedLastCycle = true;
                  break;
                }
                logger.info(`Work-stealing: pool empty, waiting (retry ${emptyRetries}/${MAX_EMPTY_RETRIES})...`);
                await new Promise((r) => setTimeout(r, EMPTY_WAIT_MS));
                await processInterrupts();
                continue;
              }

              // Reset retries on successful claim
              emptyRetries = 0;
              claimedThreadIds.add(task.id);

              logger.info(`Work-stealing: claimed "${task.description.slice(0, 80)}"`);

              // Resolve effort for this task — upgrade based on severity parsed from description.
              // Note: phase.maxTurns is intentionally NOT honored here (unlike phaseEffortProfile).
              // Execute budget comes entirely from the profile because per-task severity upgrade
              // drives the turn count; a phase-level override would hide that signal.
              const baseLevel = resolveEffort(
                (phase.effort ?? "auto") as EffortLevel,
                { toolsMode: phase.toolsMode, loop: phase.loop },
              );
              const severity = parseSeverity(task.description);
              const upgraded = upgradeEffort(baseLevel, { severity });
              const execProfile = EFFORT_PROFILES[upgraded];
              if (upgraded !== baseLevel) {
                logger.info(`Effort upgrade: ${baseLevel} → ${upgraded} (severity=${severity})`);
              } else {
                logger.debug(`Effort: ${upgraded} (model=${execProfile.model}, maxTurns=${execProfile.maxTurns})`);
              }

              // Execute one task
              const taskPrompt = phase.prompt.replace(/\{\{params\.current_task\}\}/g, task.description);
              const execTools = toolsForMode(phase.toolsMode, config.allowedTools);
              const execBlocked = disallowedForMode(phase.toolsMode);
              const freshExec = config.freshSessionPerTask === true;
              const resp = await send(taskPrompt, { model: execProfile.model, thinking: execProfile.thinking, maxTurns: execProfile.maxTurns, allowedTools: execTools, disallowedTools: execBlocked, freshSession: freshExec });

              // Detect rate limit — pause and wait for reset instead of wasting turns.
              // F3: cap the wait to avoid hour-long resumes past the run deadline,
              // and if the wait itself would exceed our remaining budget, abort
              // the task cleanly instead of sleeping through the end of the run.
              if (resp.rateLimited) {
                const MAX_RATE_LIMIT_WAIT_MS = 10 * 60 * 1000; // 10 min hard cap
                const rawWaitMs = resp.rateLimitResetsAt
                  ? Math.max(0, resp.rateLimitResetsAt * 1000 - Date.now()) + 60_000 // +1min buffer
                  : 5 * 60 * 1000; // fallback: 5 min
                const budget = remainingBudgetMs();
                const waitMs = Math.min(rawWaitMs, MAX_RATE_LIMIT_WAIT_MS, budget);

                if (waitMs < rawWaitMs) {
                  const rawMin = Math.ceil(rawWaitMs / 60_000);
                  const cappedMin = Math.ceil(waitMs / 60_000);
                  logger.warn(`Work-stealing: rate limit wait capped ${rawMin}min → ${cappedMin}min`);
                }
                if (waitMs <= 0 || waitMs < 30_000) {
                  logger.warn(`Work-stealing: remaining budget (${waitMs}ms) too short to survive rate limit — aborting task and exiting`);
                  await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                  claimedThreadIds.delete(task.id);
                  exitReason = "rate_limited";
                  break;
                }

                const waitMin = Math.ceil(waitMs / 60_000);
                logger.warn(`Work-stealing: rate limited — pausing ${waitMin} min (capped)`);
                // Don't mark task complete — it wasn't done
                // Task stays claimed; other agents can't take it but it's recoverable
                await new Promise((r) => setTimeout(r, waitMs));

                // After the cap, re-check termination — deadline may now be reached.
                const termAfterWait = checkTermination();
                if (termAfterWait) {
                  logger.warn(`Work-stealing: post-rate-limit ${termAfterWait} — aborting task`);
                  await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                  claimedThreadIds.delete(task.id);
                  exitReason = termAfterWait;
                  break;
                }

                logger.info("Work-stealing: resuming after rate limit pause");
                // Re-execute the same task (it was claimed but not completed)
                const retryResp = await send(taskPrompt, { model: execProfile.model, thinking: execProfile.thinking, maxTurns: execProfile.maxTurns, allowedTools: execTools, disallowedTools: execBlocked, freshSession: freshExec });
                if (!retryResp.rateLimited) {
                  if (hasDoneMarker(retryResp.content)) {
                    const taskSummary = extractDoneSummary(retryResp.content, "Done");
                    logger.info(`Work-stealing: completed after retry — "${taskSummary.slice(0, 80)}"`);
                    await completeTask(config.coordinatorUrl, task.id, config.agentId, taskSummary);
                    tasksDone++;
                  } else {
                    logger.warn(`Work-stealing: aborting task after retry (no DONE:) — unclaiming thread=${task.id}`);
                    await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                    claimedThreadIds.delete(task.id);
                  }
                } else {
                  logger.error("Work-stealing: still rate limited after wait — stopping");
                  break;
                }
                continue;
              }

              // Only mark complete when the agent actually produced a DONE: marker.
              // Previously we took the first 200 chars of the response as the
              // "summary" and marked complete anyway — which resolved threads
              // with partial/unrelated content (e.g. "Je vais explorer..."),
              // blocking the real work from ever happening.
              if (hasDoneMarker(resp.content)) {
                const taskSummary = extractDoneSummary(resp.content, "Done");
                logger.info(`Work-stealing: completed — "${taskSummary.slice(0, 80)}"`);
                await completeTask(config.coordinatorUrl, task.id, config.agentId, taskSummary);
                tasksDone++;
              } else {
                logger.warn(`Work-stealing: aborting task (no DONE: marker) — unclaiming thread=${task.id}`);
                await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                claimedThreadIds.delete(task.id);
              }
            }
            logger.info(`Work-stealing: ${tasksDone} tasks done`);
            tasksDoneLastCycle += tasksDone;
          }
        }
        // Re-discover cycle gate:
        // - must be an execute (loop) phase for cycling to be meaningful
        // - only cycle if the pool actually exhausted AND we did real work this round
        //   (if tasksDone=0, a re-discover is unlikely to find new items)
        const hasLoopPhase = config.phases.some((p) => p.loop);
        if (!hasLoopPhase) break;
        if (!poolExhaustedLastCycle) break;
        if (tasksDoneLastCycle === 0) {
          logger.info(`Cycle ${cycle}: no tasks done — not re-discovering`);
          break;
        }
        logger.info(`Cycle ${cycle}: ${tasksDoneLastCycle} tasks done, pool exhausted — will re-discover`);
        }
        // Only stamp "done" if no earlier phase/work-stealing loop set a terminal reason
        // (aborted, deadline_exceeded, rate_limited).
        if (exitReason === "done") {
          summary = summary || "All phases completed";
        } else {
          summary = summary || `Agent loop stopped: ${exitReason}`;
        }
      } else {
        // ── ONE-SHOT MODE (backward compat) ──
        // ③ WORK LOOP — send initial prompt, then iterate
        logger.info(`Phase 3: work loop (protocol.phase=${protocol.phase})`);
        const initialResp = await send(config.prompt);
        if (hasDoneMarker(initialResp.content)) {
          summary = extractDoneSummary(initialResp.content, "Complete");
          exitReason = "done";
        } else {
          // Iterate: drain MQTT, ask for next action
          while (turnsCount < maxTurns) {
            // Check interrupts first
            await processInterrupts();

            // Process any protocol actions triggered by interrupts
            await processProtocolActions();
            if ((protocol.phase as string) === "idle" && summary) break;

            // Ask for next action
            if (!claude.isAlive()) {
              exitReason = "process_died";
              summary = "Claude process exited";
              break;
            }

            const resp = await send("Continue. Prochaine action?");

            if (hasDoneMarker(resp.content)) {
              summary = extractDoneSummary(resp.content, "Complete");
              exitReason = "done";
              break;
            }
          }

          if (turnsCount >= maxTurns && exitReason === "done") {
            exitReason = "max_turns";
            summary = `Reached max turns limit (${maxTurns})`;
            logger.warn("Max turns reached", { maxTurns });
          }
        }
      }

      // â'£ RESOLUTION PHASE
      if (exitReason === "done" && protocol.currentThreadId) {
        protocol.workDone();
        await processProtocolActions();
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      exitReason = "budget_exceeded";
      summary = "Budget limit exceeded";
      logger.warn("Budget exceeded");
    } else if (err instanceof AbortError) {
      // Propagated from claude-stream when orchestrator fires the abort signal.
      // Prefer "deadline_exceeded" over "aborted" if the deadline is the reason,
      // so the result reflects the user-meaningful cause.
      exitReason = config.deadlineMs !== undefined && Date.now() >= config.deadlineMs
        ? "deadline_exceeded"
        : "aborted";
      summary = `Agent loop ${exitReason}`;
      logger.warn(`Agent loop ${exitReason} — ${(err as Error).message}`);
    } else {
      exitReason = "error";
      summary = (err as Error).message;
      logger.error("Agent loop error", { error: (err as Error).message });
    }
  }

  // ⑤ CLEANUP
  claude.close();
  interruptClaude.close();
  await mqtt.close().catch(() => {});

  const result: AgentLoopResult = {
    agentId: config.agentId,
    exitReason,
    summary,
    totalCostUsd: totalCost,
    turnsCount,
    mqttMessagesProcessed,
    durationMs: Date.now() - startTime,
    tokens: { ...totalTokens },
    costByPhase: { ...costByPhase },
    costByModel: { ...costByModel },
    turnDetails: turnDetails.slice(),
  };

  // Pretty cost/token summary for logs
  const totalInputAll = totalTokens.input + totalTokens.cacheRead + totalTokens.cacheCreation;
  const cacheHitPct = totalInputAll > 0
    ? Math.round((totalTokens.cacheRead / totalInputAll) * 100)
    : 0;
  logger.info(
    `Agent loop finished: ${turnsCount} turns, $${totalCost.toFixed(4)}, ` +
    `in=${formatTokens(totalTokens.input)} out=${formatTokens(totalTokens.output)} ` +
    `cache-r=${formatTokens(totalTokens.cacheRead)} cache-w=${formatTokens(totalTokens.cacheCreation)} ` +
    `hit=${cacheHitPct}%`,
  );
  logger.info(`Cost by phase: ${JSON.stringify(Object.fromEntries(Object.entries(costByPhase).map(([k, v]) => [k, `$${v.toFixed(4)}`])))}`);
  logger.info(`Cost by model: ${JSON.stringify(Object.fromEntries(Object.entries(costByModel).map(([k, v]) => [k, `$${v.toFixed(4)}`])))}`);
  return result;
}

