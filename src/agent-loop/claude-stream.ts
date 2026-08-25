import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { EventEmitter } from "events";
import { createLogger } from "../logger.js";
import { thinkingKeyword, type ThinkingLevel } from "./effort.js";
import { buildChildEnv } from "./child-env.js";
const log = createLogger("claude-stream");

// ── Types ──────────────────────────────────────────────────────────────

export interface ClaudeStreamOptions {
  workspacePath: string;
  mcpConfigPath?: string;
  allowedTools?: string[];
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  env?: Record<string, string>;
  dangerouslySkipPermissions?: boolean;
  // When aborted, any running claude child process is SIGKILLed and pending
  // send() calls reject with AbortError. Enables the orchestrator to reclaim
  // agents that would otherwise continue running past the run deadline.
  abortSignal?: AbortSignal;
}

export class AbortError extends Error {
  constructor(message?: string) {
    super(message ?? "claude-stream aborted");
    this.name = "AbortError";
  }
}

export interface TokenUsage {
  inputTokens: number;        // fresh input (not from cache)
  outputTokens: number;
  cacheReadTokens: number;    // input read from prompt cache (cheap)
  cacheCreationTokens: number; // input written to prompt cache (expensive, one-time)
}

export interface AssistantResponse {
  content: string;
  toolCalls: ToolCall[];
  costUsd: number;
  durationMs: number;
  sessionId: string;
  rateLimited: boolean;
  rateLimitResetsAt?: number;  // Unix timestamp (seconds)
  tokens: TokenUsage;
  /**
   * Subtype du `result` renvoyé par le CLI : "success", "error_max_turns", …
   *
   * Le parseur le connaissait déjà et le journalisait, mais le jetait ensuite.
   * Sans lui, la boucle de work-stealing ne peut pas distinguer un agent qui a
   * divagué d'un agent qui a simplement épuisé ses tours — les deux arrivent
   * comme « pas de marqueur DONE: ». Exposé pour être JOURNALISÉ, pas pour
   * changer une décision : voir les deux sites d'abandon dans agent-loop.ts.
   */
  subtype?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface SendOptions {
  maxTurns?: number;
  model?: string;
  thinking?: ThinkingLevel;
  allowedTools?: string[];
  // Explicit block list — bypasses the pre-approval loophole where
  // --dangerously-skip-permissions effectively grants every tool regardless
  // of what --allowedTools contains. Use this to strictly forbid tool names
  // for restricted phases (e.g. review phase = no Read/Bash/Edit).
  disallowedTools?: string[];
  // Start a fresh session for this send — don't resume the previous turn's
  // context. Useful when switching models (Haiku can't reuse Sonnet's cache)
  // or when the previous context is pure clutter (review phase doesn't need
  // discover's file reads). Reduces cache-write waste significantly.
  freshSession?: boolean;
}

export interface ClaudeStreamClient {
  send(content: string, opts?: SendOptions): Promise<AssistantResponse>;
  close(): void;
  isAlive(): boolean;
  readonly sessionId: string | null;
}

export class BudgetExceededError extends Error {
  constructor(message?: string) {
    super(message ?? "Budget exceeded");
    this.name = "BudgetExceededError";
  }
}

// ── Stream event types ─────────────────────────────────────────────────

export type StreamEvent =
  | { type: "system"; subtype: "init"; session_id?: string; [k: string]: unknown }
  | { type: "system"; subtype: "hook_started"; [k: string]: unknown }
  | { type: "system"; subtype: "hook_response"; [k: string]: unknown }
  | { type: "assistant"; message: { role: "assistant"; content: ContentBlock[] }; [k: string]: unknown }
  | { type: "rate_limit_event"; [k: string]: unknown }
  | { type: "result"; subtype: "success"; cost_usd: number; duration_ms: number; session_id: string; [k: string]: unknown }
  | { type: "result"; subtype: "error_max_budget_usd"; [k: string]: unknown };

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const NOISE_SUBTYPES = new Set(["hook_started", "hook_response"]);

/**
 * Produce a short human-readable summary of a tool_use input so the flow log
 * shows what the agent is doing without spamming full JSON payloads.
 */
function summarizeToolInput(name: string, input: Record<string, unknown>): string {
  const get = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  switch (name) {
    case "Read":
    case "Glob": {
      const p = get("file_path") ?? get("pattern") ?? get("path");
      return p ? `${p}` : "";
    }
    case "Grep": {
      const pat = get("pattern");
      const path = get("path");
      return pat ? `"${pat}"${path ? ` in ${path}` : ""}` : "";
    }
    case "Bash": {
      const cmd = get("command") ?? "";
      return cmd.length > 100 ? `${cmd.slice(0, 97)}...` : cmd;
    }
    case "Edit":
    case "Write":
    case "NotebookEdit": {
      const p = get("file_path") ?? get("notebook_path");
      return p ? `${p}` : "";
    }
    default: {
      // Fallback: show the first string-valued field if any
      const firstStr = Object.entries(input).find(([, v]) => typeof v === "string");
      return firstStr ? `${firstStr[0]}=${String(firstStr[1]).slice(0, 80)}` : "";
    }
  }
}

// ── Build CLI args ─────────────────────────────────────────────────────

export function buildArgs(opts: ClaudeStreamOptions, prompt: string, resume: boolean, sendOpts?: SendOptions): string[] {
  // Extended-thinking trigger keyword (Claude CLI-specific: the keyword must appear in the user prompt).
  // Appended on its own line at the end so the model picks it up regardless of the surrounding prompt.
  const thinking = sendOpts?.thinking;
  const kw = thinking ? thinkingKeyword(thinking) : "";
  const promptWithThinking = kw ? `${prompt}\n\n${kw}` : prompt;
  // Newlines in -p value break Bun's arg parser — flatten to single line
  const sanitizedPrompt = promptWithThinking.replace(/\n+/g, " \\n ");
  const args = [
    "-p", sanitizedPrompt,
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (resume && opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  // Per-send allowedTools overrides the session-level list (used for per-phase tool restriction).
  const effectiveAllowedTools = sendOpts?.allowedTools ?? opts.allowedTools;
  if (effectiveAllowedTools?.length) args.push("--allowedTools", effectiveAllowedTools.join(","));
  // Per-send disallowedTools is the only reliable way to block tools when
  // --dangerously-skip-permissions is set (that flag auto-approves every
  // tool, making --allowedTools effectively advisory).
  if (sendOpts?.disallowedTools?.length) args.push("--disallowedTools", sendOpts.disallowedTools.join(","));
  if (!resume && opts.sessionId) args.push("--session-id", opts.sessionId);
  const effectiveModel = sendOpts?.model ?? opts.model;
  if (effectiveModel) args.push("--model", effectiveModel);
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
  if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
  if (opts.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  // Per-send maxTurns takes priority, then session-level default
  const effectiveMaxTurns = sendOpts?.maxTurns ?? opts.maxTurns;
  if (effectiveMaxTurns !== undefined) args.push("--max-turns", String(effectiveMaxTurns));
  return args;
}

// ── NDJSON parser ──────────────────────────────────────────────────────

export function createStreamParser(emitter: EventEmitter, readable: NodeJS.ReadableStream): void {
  let buffer = "";

  // Decode as UTF-8 at the stream level so Node buffers any partial
  // multi-byte sequence internally and only hands the "data" handler
  // complete codepoints — otherwise a multi-byte character split across
  // two chunks (e.g. by a TCP/pipe boundary) decodes as garbage on each
  // half independently.
  readable.setEncoding("utf8");

  readable.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        emitter.emit("event", event);
      } catch {
        // Non-JSON line — ignore
      }
    }
  });

  readable.on("end", () => {
    const trimmed = buffer.trim();
    if (trimmed) {
      try {
        const event = JSON.parse(trimmed) as StreamEvent;
        emitter.emit("event", event);
      } catch { /* ignore */ }
    }
    emitter.emit("end");
  });
}

// ── Resolve claude binary ─────────────────────────────────────────────

export function resolveClaudeBin(): string {
  const envPath = process.env.CLAUDE_BIN;
  if (envPath) return envPath;
  const candidates = [
    process.env.HOME && `${process.env.HOME}/.local/bin/claude`,
    process.env.HOME && `${process.env.HOME}/.claude/local/claude`,
    "/usr/local/bin/claude",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "claude";
}

// ── Run one turn ──────────────────────────────────────────────────────

/**
 * Spawn claude -p for a single turn. Each turn is a separate process.
 * Multi-turn context is maintained via --session-id / --resume.
 *
 * Passing `onSpawn` lets the caller register the child process for external
 * cancellation (e.g. the stream client tracks the current child so `close()`
 * can SIGKILL it when an abort signal fires).
 */
function runOneTurn(
  claudeBin: string,
  options: ClaudeStreamOptions,
  prompt: string,
  resume: boolean,
  sendOpts?: SendOptions,
  onSpawn?: (child: ChildProcess) => void,
): Promise<AssistantResponse> {
  const args = buildArgs(options, prompt, resume, sendOpts);

  const turnStart = Date.now();
  log.debug("spawn", { claudeBin, resume, promptLength: prompt.length });

  return new Promise<AssistantResponse>((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd: options.workspacePath,
      env: buildChildEnv(process.env, options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    log.info(`spawned claude (pid=${child.pid}, resume=${resume})`);
    onSpawn?.(child);
    // Close stdin immediately — -p provides the prompt via args
    child.stdin!.end();

    const emitter = new EventEmitter();
    createStreamParser(emitter, child.stdout!);

    let content = "";
    let toolCalls: ToolCall[] = [];
    let resultSessionId = options.sessionId || "";
    let stderrBuf = "";
    let resolved = false;
    let rateLimitResetsAt: number | undefined;
    let firstEventLogged = false;

    child.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    emitter.on("event", (event: StreamEvent) => {
      if (!firstEventLogged) {
        firstEventLogged = true;
        log.info(`first event received (+${Date.now() - turnStart}ms)`);
      }
      if (event.type === "system" && event.subtype === "init") {
        if (event.session_id) {
          resultSessionId = event.session_id;
          log.info(`session ready (id=${event.session_id}, +${Date.now() - turnStart}ms)`);
        }
        return;
      }
      if (event.type === "system" && NOISE_SUBTYPES.has(event.subtype)) return;
      if (event.type === "rate_limit_event") {
        const info = (event as Record<string, unknown>).rate_limit_info as Record<string, unknown> | undefined;
        if (info?.resetsAt) rateLimitResetsAt = info.resetsAt as number;
        return;
      }

      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text") content += (content ? "\n" : "") + block.text;
          else if (block.type === "tool_use") {
            toolCalls.push({ id: block.id, name: block.name, input: block.input });
            log.info(`tool: ${block.name} ${summarizeToolInput(block.name, block.input)}`);
          }
        }
        return;
      }

      if (event.type === "result") {
        if (event.subtype === "error_max_budget_usd") {
          resolved = true;
          log.error("budget exceeded");
          reject(new BudgetExceededError());
          return;
        }
        // Success OR any other non-fatal subtype (error_max_turns, error_during_execution, unknown future subtypes):
        // settle with whatever content/toolCalls we collected so callers never hang.
        resolved = true;
        if (event.session_id) resultSessionId = event.session_id as string;
        const isRateLimited = content.includes("hit your limit") || content.includes("rate limit");
        const eventRec = event as Record<string, unknown>;
        const subtype = eventRec.subtype as string | undefined;
        // Claude CLI places token accounting under `usage` on the result event.
        const usageRaw = (eventRec.usage ?? {}) as Record<string, unknown>;
        const tokens: TokenUsage = {
          inputTokens: (usageRaw.input_tokens as number) ?? 0,
          outputTokens: (usageRaw.output_tokens as number) ?? 0,
          cacheReadTokens: (usageRaw.cache_read_input_tokens as number) ?? 0,
          cacheCreationTokens: (usageRaw.cache_creation_input_tokens as number) ?? 0,
        };
        if (subtype !== "success") {
          log.warn(`result with non-success subtype: ${subtype ?? "?"} — resolving with partial content`);
        } else {
          log.info("turn complete", { durationMs: (eventRec.duration_ms as number) ?? 0, toolCalls: toolCalls.length, contentLength: content.length, rateLimited: isRateLimited, tokens });
        }
        resolve({
          content,
          toolCalls,
          costUsd: (eventRec.cost_usd as number) ?? 0,
          rateLimited: isRateLimited,
          rateLimitResetsAt,
          durationMs: (eventRec.duration_ms as number) ?? 0,
          sessionId: resultSessionId,
          tokens,
          subtype,
        });
        return;
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        if (code !== 0) {
          log.warn(`exit code ${code}`, { stderr: stderrBuf.slice(0, 200) });
          reject(new Error(`Claude exited code ${code}${stderrBuf ? ": " + stderrBuf.slice(0, 500) : ""}`));
        } else {
          log.warn("exited without result", { stderr: stderrBuf.slice(0, 200) });
          reject(new Error(`Claude exited without producing a result. stderr: ${stderrBuf.slice(0, 500) || "(empty)"}`));
        }
      }
    });

    child.on("error", (err) => {
      if (!resolved) reject(err);
    });
  });
}

// ── Main factory ───────────────────────────────────────────────────────

/**
 * Create a claude stream client that spawns one process per turn.
 * Multi-turn context is maintained via --session-id / --resume.
 */
export function createClaudeStream(options: ClaudeStreamOptions): ClaudeStreamClient {
  const claudeBin = resolveClaudeBin();
  let alive = true;
  let currentSessionId: string | null = options.sessionId || randomUUID();
  let turnCount = 0;
  // Track the child running for the current send() so close()/abort can SIGKILL it.
  let currentChild: ChildProcess | null = null;

  const killCurrent = (reason: string): void => {
    const child = currentChild;
    if (!child || child.killed || child.exitCode !== null) return;
    log.warn(`SIGKILL claude child pid=${child.pid} — ${reason}`);
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  };

  const abortHandler = (): void => {
    alive = false;
    killCurrent("abort signal fired");
  };
  if (options.abortSignal) {
    if (options.abortSignal.aborted) {
      alive = false;
    } else {
      options.abortSignal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  // Mutate options to set the session ID
  const opts = { ...options, sessionId: currentSessionId };

  const onSpawn = (child: ChildProcess): void => {
    currentChild = child;
    // If the signal was already fired between send() entry and spawn completion,
    // kill the child immediately — otherwise the abort handler already covered it.
    if (options.abortSignal?.aborted) killCurrent("abort signal already aborted at spawn");
  };

  return {
    get sessionId() {
      return currentSessionId;
    },

    isAlive() {
      return alive;
    },

    async send(content: string, sendOpts?: SendOptions): Promise<AssistantResponse> {
      if (!alive) throw new AbortError("Claude stream client is closed");
      if (options.abortSignal?.aborted) {
        alive = false;
        throw new AbortError("abort signal already aborted before send");
      }

      try {
        // Fresh session bypasses --resume and uses a throwaway session-id so the
        // main session state isn't polluted. Useful for one-off calls that
        // shouldn't inherit prior turn context (e.g. review phase with different
        // model, or per-task execute).
        if (sendOpts?.freshSession) {
          const freshOpts = { ...opts, sessionId: randomUUID() };
          return await runOneTurn(claudeBin, freshOpts, content, false, sendOpts, onSpawn);
        }

        const isResume = turnCount > 0;
        turnCount++;

        const resp = await runOneTurn(claudeBin, opts, content, isResume, sendOpts, onSpawn);

        // Update session ID from response (for --resume on next turn)
        if (resp.sessionId) {
          currentSessionId = resp.sessionId;
          opts.sessionId = resp.sessionId;
        }

        return resp;
      } finally {
        currentChild = null;
      }
    },

    close() {
      alive = false;
      options.abortSignal?.removeEventListener("abort", abortHandler);
      killCurrent("close() called");
    },
  };
}

