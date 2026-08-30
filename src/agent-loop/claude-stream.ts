import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { basename, delimiter, dirname, join, resolve as resolvePath } from "path";
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

/**
 * Compactions de contexte observées pendant UN envoi.
 *
 * C'est le signal qui lève l'ambiguïté de `error_max_turns`. Sans lui, un
 * abandon veut dire « plafond de tours trop bas » — remède : monter maxTurns.
 * Avec lui, il veut dire « la fenêtre de contexte a débordé », et le remède est
 * OPPOSÉ : DESCENDRE maxTurns, sinon on remplit la fenêtre plus vite et on paie
 * deux compactions pour le même abandon.
 *
 * Voir le commentaire de EFFORT_PROFILES.mid dans effort.ts : maxTurns y a été
 * DOUBLÉ (8 → 16) sur la foi de « 21 error_max_turns pour 19 tâches
 * abandonnées ». Ce compteur est ce qui permet enfin de qualifier ce 21.
 */
export interface CompactionInfo {
  /** Nombre d'événements system/compact_boundary reçus pendant l'envoi. */
  count: number;
  /** Somme des tokens de contexte AVANT compaction, tous événements confondus. */
  preTokens: number;
  /** Somme des tokens APRÈS compaction. 0 si le CLI ne publie pas ce champ. */
  postTokens: number;
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
   * Compactions subies pendant cet envoi. TOUJOURS présent — vaut
   * `{ count: 0, preTokens: 0, postTokens: 0 }` quand rien n'a été compacté,
   * pour que l'appelant n'ait jamais à tester undefined.
   */
  compaction: CompactionInfo;
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
  // --dangerously-skip-permissions effectively grants every permission-gated
  // tool regardless of what --allowedTools contains, and is the only lever
  // against tools that require a human (AskUserQuestion), which the bypass
  // never grants either. Use this to strictly forbid tool names for
  // restricted phases (e.g. review phase = no Read/Bash/Edit).
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
  // Émis quand le CLI compacte la fenêtre de contexte. La forme du payload est
  // SUPPOSÉE (voir readCompactTokens) : d'où l'index signature plutôt que des
  // champs typés qu'on ne peut pas vérifier depuis ce dépôt.
  | { type: "system"; subtype: "compact_boundary"; [k: string]: unknown }
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
 * Lecture DÉFENSIVE du payload d'un compact_boundary.
 *
 * La forme exacte n'est PAS vérifiable depuis ce dépôt : node_modules ne
 * contient que @anthropic-ai/sdk (le client HTTP de l'API), jamais les types du
 * flux du CLI. On SUPPOSE `compact_metadata: { pre_tokens, post_tokens }` et on
 * tolère les mêmes clés à la racine de l'événement. Tout champ absent, non
 * numérique, null ou NaN vaut 0 — jamais une exception.
 *
 * Conséquence VOULUE : un événement de forme inconnue est quand même COMPTÉ par
 * l'appelant, seuls ses tokens restent à 0. Le compteur d'occurrences — la
 * moitié qui sert au diagnostic — reste juste quelle que soit la forme.
 */
function readCompactTokens(event: Record<string, unknown>): { pre: number; post: number } {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  // `?? {}` couvre null/undefined ; un metadata non-objet (string, number)
  // donne simplement undefined sur ses propriétés, donc 0 après num().
  const meta = (event.compact_metadata ?? {}) as Record<string, unknown>;
  return {
    pre: num(meta.pre_tokens) || num(event.pre_tokens),
    post: num(meta.post_tokens) || num(event.post_tokens),
  };
}

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

/**
 * Prompt effectif = prompt + (mot-clé de thinking sur sa propre ligne à la fin,
 * pour que le modèle le capte quel que soit le contexte). Exporté pour que
 * runOneTurn puisse l'écrire sur stdin quand claude passe par un shell.
 */
export function composePrompt(prompt: string, sendOpts?: SendOptions): string {
  const kw = sendOpts?.thinking ? thinkingKeyword(sendOpts.thinking) : "";
  return kw ? `${prompt}\n\n${kw}` : prompt;
}

export function buildArgs(
  opts: ClaudeStreamOptions,
  prompt: string,
  resume: boolean,
  sendOpts?: SendOptions,
  promptViaStdin = false,
): string[] {
  const full = composePrompt(prompt, sendOpts);
  // Deux modes de livraison du prompt (#149) :
  //  - promptViaStdin=true (chemin shell/.cmd Windows) : le prompt part par
  //    stdin, HORS ligne de commande — ni plafond cmd.exe (8191 car) ni
  //    interprétation de ses metachars. `-p` reste un flag nu.
  //  - false (POSIX + Windows .exe, défaut) : prompt en arg -p, newlines
  //    aplaties (elles cassent le parseur d'args de Bun).
  const args = promptViaStdin
    ? ["-p", "--output-format", "stream-json", "--verbose"]
    : ["-p", full.replace(/\n+/g, " \\n "), "--output-format", "stream-json", "--verbose"];
  if (resume && opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }
  if (opts.mcpConfigPath) args.push("--mcp-config", opts.mcpConfigPath);
  // Per-send allowedTools overrides the session-level list (used for per-phase tool restriction).
  const effectiveAllowedTools = sendOpts?.allowedTools ?? opts.allowedTools;
  if (effectiveAllowedTools?.length) args.push("--allowedTools", effectiveAllowedTools.join(","));
  // Per-send disallowedTools is the only reliable way to block tools when
  // --dangerously-skip-permissions is set: that flag auto-approves every tool
  // that merely needs a permission, making --allowedTools advisory. It does
  // NOT cover tools requiring a human (AskUserQuestion) — those are checked
  // before the bypass branch, so only a deny rule stops them.
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
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    home && `${home}/.local/bin/claude`,
    home && `${home}/.claude/local/claude`,
    "/usr/local/bin/claude",
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Windows : le spawn du run est SANS shell (buildChildEnv, prompt en arg qui
  // peut faire des dizaines de Ko). Node n'applique alors PAS PATHEXT, donc un
  // « claude » nu ne trouve ni claude.cmd ni claude.exe -> ENOENT (issue #149).
  // On résout le vrai fichier sur le PATH, en préférant un .exe (runnable
  // no-shell, sans plafond cmd.exe) au shim .cmd (voir claudeSpawnNeedsShell).
  if (process.platform === "win32") {
    const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const resolved = resolveWindowsExecutable("claude", dirs);
    if (resolved) return resolved;
  }
  return "claude";
}

/**
 * Cherche `<name>` sur le PATH Windows en essayant les extensions exécutables,
 * en PRÉFÉRANT .exe/.com (lançables par un spawn sans shell, prompt de toute
 * longueur) à .cmd/.bat (shims qui forcent cmd.exe : plafond 8191 caractères de
 * ligne de commande + interprétation des metachars du prompt). L'ordre des
 * extensions prime sur l'ordre des dossiers : un vrai .exe plus loin sur le PATH
 * bat un shim .cmd plus tôt. Rend undefined si rien n'est trouvé. Pur (dirs
 * injectés) pour rester testable hors Windows.
 */
export function resolveWindowsExecutable(name: string, dirs: string[]): string | undefined {
  // 1. Un vrai exécutable sur le PATH (install native) : parfait, aucun shell.
  for (const ext of [".exe", ".com"]) {
    for (const dir of dirs) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  // 2. Sinon un shim .cmd/.bat (install npm) : on tente d'en extraire le .exe
  //    enveloppé pour lancer le vrai binaire SANS shell ; à défaut on rend le
  //    shim lui-même (chemin shell, cf. claudeSpawnNeedsShell).
  for (const ext of [".cmd", ".bat"]) {
    for (const dir of dirs) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return resolveCmdShimExe(full) ?? full;
    }
  }
  return undefined;
}

/**
 * Si `cmdPath` est un shim .cmd/.bat qui enveloppe un .exe — le cas des installs
 * npm de claude, dont le shim fait `"%dp0%\...\claude.exe" %*` — rend le chemin
 * absolu de ce .exe (résolvant %dp0%/%~dp0% vers le dossier du shim) s'il existe.
 * Lancer ce .exe directement évite le shell, donc les plafonds (8191 car) et
 * l'interprétation des metachars de cmd.exe sur TOUS les args (prompt comme
 * --append-system-prompt, qui contient des `<`/`>` traités en redirections).
 * Rend undefined si aucun .exe résoluble : parse best-effort, jamais bloquant.
 */
export function resolveCmdShimExe(cmdPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(cmdPath, "utf8");
  } catch {
    return undefined;
  }
  const shimDir = dirname(cmdPath);
  // On ne matche QUE <nom>.exe (claude.exe pour claude.cmd) : un shim qui lance
  // node.exe + un .js (npm/corepack/essaim...) ne doit PAS faire prendre node.exe
  // pour le binaire — dans ce cas on rend undefined et on retombe sur le shell.
  const exeName = basename(cmdPath).replace(/\.(cmd|bat)$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`"?([^"\\r\\n]*?${exeName}\\.exe)"?`, "i"));
  if (!m) return undefined;
  // %dp0% / %~dp0% / %~dp0 -> dossier du shim (le shim ajoute son propre "\").
  const raw = m[1].trim().replace(/%~?dp0%?\\?/gi, shimDir + "\\");
  const abs = resolvePath(raw);
  return existsSync(abs) ? abs : undefined;
}

/**
 * Un spawn a besoin d'un shell UNIQUEMENT pour lancer un shim .cmd/.bat sous
 * Windows : Node refuse de les exécuter sans shell (patch CVE-2024-27980). Un
 * .exe, un chemin sans extension, ou toute cible hors Windows se lancent sans
 * shell — ce qui évite les plafonds/metachars de cmd.exe et les problèmes de
 * chemin à espace. `platform` est injecté pour le test.
 */
export function claudeSpawnNeedsShell(bin: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(bin);
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
  // shell UNIQUEMENT pour un shim .cmd/.bat (Node refuse de les lancer sans) ;
  // un .exe/chemin sans ext se lance sans shell -> pas de plafond cmd.exe ni
  // d'interprétation des metachars. Voir claudeSpawnNeedsShell / buildArgs (#149).
  const needsShell = claudeSpawnNeedsShell(claudeBin);
  const args = buildArgs(options, prompt, resume, sendOpts, needsShell);

  const turnStart = Date.now();
  log.debug("spawn", { claudeBin, resume, needsShell, promptLength: prompt.length });

  return new Promise<AssistantResponse>((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      cwd: options.workspacePath,
      env: buildChildEnv(process.env, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsShell,
    });
    log.info(`spawned claude (pid=${child.pid}, resume=${resume})`);
    onSpawn?.(child);
    // Sur le chemin shell, le prompt part par stdin (hors ligne de commande) ;
    // sinon -p le porte en arg et stdin se ferme vide.
    if (needsShell) child.stdin!.write(composePrompt(prompt, sendOpts));
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
    // Accumulé sur tout l'envoi : le CLI peut compacter plusieurs fois par tour.
    const compaction: CompactionInfo = { count: 0, preTokens: 0, postTokens: 0 };

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
      if (event.type === "system" && event.subtype === "compact_boundary") {
        const { pre, post } = readCompactTokens(event as Record<string, unknown>);
        compaction.count++;
        compaction.preTokens += pre;
        compaction.postTokens += post;
        // warn et non debug : une compaction est l'explication la plus probable
        // d'un error_max_turns qui suit, et on veut la voir au niveau de log
        // par défaut (LOG_LEVEL=info).
        log.warn(`context compacted (#${compaction.count})`, { preTokens: pre, postTokens: post });
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
          log.warn(`result with non-success subtype: ${subtype ?? "?"} — resolving with partial content`, { compactions: compaction.count });
        } else {
          log.info("turn complete", { durationMs: (eventRec.duration_ms as number) ?? 0, toolCalls: toolCalls.length, contentLength: content.length, rateLimited: isRateLimited, tokens, compactions: compaction.count });
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
          // COPIE, pas la référence : le flush de fin de buffer (readable "end")
          // peut encore émettre un événement après le result, ce qui ferait
          // muter en douce un objet que l'appelant a déjà lu.
          compaction: { ...compaction },
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

