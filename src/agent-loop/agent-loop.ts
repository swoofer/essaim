import { createClaudeStream, type ClaudeStreamClient, type AssistantResponse, type SendOptions, type TokenUsage, type CompactionInfo, BudgetExceededError, AbortError } from "./claude-stream.js";
import { createMqttListener, type MqttListener, type MqttInterrupt, type InterruptType } from "./mqtt-listener.js";
import {
  createCoordinationProtocol,
  type CoordinationProtocol,
  type ProtocolAction,
  type WorkDescription,
  type AnnounceResult,
} from "./coordination-protocol.js";
import { parseDiscoveries, postDiscoveries, claimNextTask, completeTask, unclaimTask, parseReviewActions, fetchExistingThreads, processReviewActions, COORDINATOR_UNREACHABLE } from "./work-stealing.js";
import { createLogger } from "../logger.js";
import { resolveEffort, upgradeEffort, parseSeverity, EFFORT_PROFILES, isThinkingLevel, type EffortLevel, type ConcreteEffortLevel, type ThinkingLevel } from "./effort.js";
import { authHeaders } from "../coordinator-auth.js";
import { verifyFailingTest, parseUntrackedFiles, type FalsifiabilityDeps } from "./falsifiability.js";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectLanguage } from "../orchestrator/scanner.js";

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
  // DF4 — l'agent est declare lecture seule (behavior read-only-mode). Sous
  // --dangerously-skip-permissions l'allowlist ne protege rien : le mode
  // one-shot passe alors disallowedForMode("read_only") pour bloquer dur toute
  // ecriture (Write/Edit/NotebookEdit/Bash). Cable depuis agent.read_only.
  readOnly?: boolean;
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
    // Opt-in, propagé par promptweave depuis le YAML du behavior. Quand vrai,
    // un DONE: n'est accepté que si le test ajouté échoue SANS le patch.
    requireFailingTest?: boolean;
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
  // Le coordinator est devenu INJOIGNABLE en plein run (tué, réseau coupé) :
  // distinct de "done", pour que le rapport soit ROUGE (orchestrator mappe tout
  // ≠ "done" -> exit_code 1). Sans lui, une piscine devenue muette passait pour
  // « tout le travail est fait » — un faux vert (#151).
  | "coordinator_unreachable"
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
  // Compactions de contexte subies pendant ce tour. `compactions > 0` sur un
  // tour qui finit en error_max_turns veut dire « fenêtre de contexte pleine »,
  // pas « plafond de tours trop bas » — deux diagnostics aux remèdes opposés.
  compactions: number;
  compactionPreTokens: number;
  compactionPostTokens: number;
}

// Registre d'UNE tâche réclamée (#162) : chaque thread réclamé finit en done,
// refused (garde-fou de falsifiabilité) ou aborted (pas de DONE:). Le `reason`
// porte le résumé (done) ou le MOTIF du refus/abandon — pour que le rapport dise
// POURQUOI, au lieu d'un log.warn volatil et d'un post dans un thread éphémère.
export interface TaskRecord {
  threadId: string;
  verdict: "done" | "refused" | "aborted";
  reason: string;
}

export interface AgentLoopResult {
  agentId: string;
  exitReason: ExitReason;
  summary: string;
  // Une entrée par tâche réclamée : id, verdict, motif (#162).
  taskRecords: TaskRecord[];
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

/**
 * Commande de test DU DÉPÔT CIBLE, pas du nôtre.
 *
 * Codée en dur à `pnpm exec vitest run`, elle défaisait le garde-fou sur tout
 * dépôt qui n'est pas pnpm+vitest : la commande échouait faute de vitest, et
 * cet échec se lisait comme « le test échoue sans le patch ». On réutilise la
 * détection du scanner — même source de vérité que le reste de l'orchestrateur
 * — appliquée au worktree réel de l'agent.
 *
 * La plupart des lanceurs filtrent par chemin (`vitest run <f>`, `pytest <f>`),
 * donc seuls les tests que l'agent vient d'écrire sont rejoués. Ceux qui ne le
 * font pas (`go test ./...`, `cargo test`) échoueront sur l'argument ajouté —
 * la mesure de référence de `verifyFailingTest` transforme alors le cas en
 * abandon explicite et journalisé, plus en acceptation silencieuse.
 */
function testCommandFor(workspacePath: string): { cmd: string; args: string[] } {
  const parts = detectLanguage(workspacePath).test_command.trim().split(/\s+/);
  return { cmd: parts[0] || "npm", args: parts.slice(1) };
}

/** Exécuteur réel pour le contrôle de falsifiabilité. Ne jette jamais. */
function gitExec(cwd: string): FalsifiabilityDeps {
  return {
    exec(cmd, args) {
      return new Promise((resolve) => {
        // `shell` UNIQUEMENT pour le lanceur de tests. Sur Windows `pnpm`/`npx`
        // sont des .cmd et exigent un shell ; `git` est un vrai .exe et n'en a
        // pas besoin. Or sous `shell: true` Node NE CITE PAS les arguments :
        // un chemin contenant une espace (« my src.ts », ou un tmpdir sous
        // `C:\Users\Jean Dupont\...`) se scindait en deux pathspecs et le
        // fichier n'était jamais neutralisé — un bon correctif se faisait alors
        // refuser par « le test passe SANS le patch », le pire des verdicts
        // puisqu'il a l'air d'un vrai. Le contrôle d'effet ne le rattrapait pas :
        // il rejouait le même pathspec cassé.
        const child = spawn(cmd, args, { cwd, shell: process.platform === "win32" && cmd !== "git" });
        let stdout = "";
        child.stdout?.on("data", (d) => { stdout += String(d); });
        child.stderr?.on("data", (d) => { stdout += String(d); });
        child.on("error", () => resolve({ code: -1, stdout }));
        child.on("close", (code) => resolve({ code: code ?? -1, stdout }));
      });
    },
    // HORS du worktree : un patch déposé dedans apparaîtrait dans le
    // `git status` du contrôle suivant et serait compté comme fichier source.
    async writeTemp(content) {
      const file = join(mkdtempSync(join(tmpdir(), "essaim-falsifiability-")), "neutralize.patch");
      writeFileSync(file, content);
      return file;
    },
  };
}

/**
 * HEAD relevé AVANT que l'agent touche à la tâche : la base contre laquelle le
 * garde-fou mesure ce qui a été produit. Sans elle il n'inspectait que l'arbre
 * de travail, que le commit par tâche (behaviors/phase-execute.yaml:56) vide.
 * Rendre `undefined` si git ne répond pas — le contrôle retombe alors sur son
 * comportement historique plutôt que de bloquer une tâche légitime.
 */
async function taskBaseline(
  deps: FalsifiabilityDeps,
): Promise<{ sha: string; untracked: string[] } | undefined> {
  const r = await deps.exec("git", ["rev-parse", "HEAD"]);
  const sha = r.stdout.trim();
  // Les non-suivis DÉJÀ LÀ avant la tâche. Sans cet inventaire, `.mcp.json` —
  // que promptweave dépose dans chaque worktree à sa création — compte comme
  // « fichier de production changé » à chaque tâche.
  const st = await deps.exec("git", ["status", "--porcelain", "--untracked-files=all"]);
  // Tout ou rien. Une base partielle est PIRE qu'aucune : sans `sha` le
  // contrôle retombe sur l'arbre seul (le défaut aveugle de #142), et sans
  // l'inventaire des non-suivis `.mcp.json` redevient un « fichier de
  // production » et fait sauter le contrôle à chaque DONE:. L'appelant ne
  // mémorise que ce qui est complet.
  if (r.code !== 0 || !sha || st.code !== 0) return undefined;
  return { sha, untracked: parseUntrackedFiles(st.stdout) };
}

/**
 * Résolution « ce n'en est pas un » — la mission de sentinelle la prévoit
 * noir sur blanc. Aucun patch, donc aucun test à exiger.
 */
export const FALSE_POSITIVE_PATTERN = /FALSE[_ ]?POSITIVE/i;

/** Publie le motif du refus dans le thread, pour que la reprise soit informée. */
async function postRefusal(
  config: AgentLoopConfig,
  threadId: string,
  reason: string,
): Promise<void> {
  try {
    await fetch(`${config.coordinatorUrl}/api/post-to-thread`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        thread_id: threadId,
        agent_id: config.agentId,
        agent_name: config.agentName,
        type: "context",
        content:
          `Résolution refusée par le garde-fou de falsifiabilité : ${reason}.

` +
          `Écris un test qui ÉCHOUE sans ton patch avant de conclure DONE:. ` +
          `Si le défaut n'existe pas, conclus FALSE_POSITIVE: <raison>.`,
      }),
    });
  } catch {
    // Le refus tient même si le thread ne peut pas être annoté.
  }
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

/**
 * Même tolérance typographique, mais ANCRÉ en début de ligne — et testé sur la
 * seule FIN du contenu.
 *
 * `content` concatène le texte de tous les tours internes du CLI. Sans ancrage
 * ni fenêtre, un agent qui écrit « je terminerai par DONE: ... » dans un tour
 * intermédiaire — comportement que `extractDoneSummary` documente juste en
 * dessous comme courant — résout le thread avant d'avoir travaillé. C'est
 * précisément ce que la règle « pas de marqueur = jamais complete » devait
 * empêcher.
 */
const DONE_LINE_PATTERN = new RegExp("^[ \t*_`]*" + DONE_PATTERN.source, "im");
const DONE_TAIL_CHARS = 500;

export function hasDoneMarker(content: string): boolean {
  return DONE_LINE_PATTERN.test(content.slice(-DONE_TAIL_CHARS));
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

// Bloqué sur TOUS les envois, y compris ceux qui contournent le wrapper `send`
// (la session d'interruption). Une entrée ajoutée ici s'applique aux deux sites ;
// deux littéraux séparés laissaient le second dériver en silence.
const ALWAYS_BLOCKED = ["AskUserQuestion"];

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

export function disallowedForMode(
  toolsMode: "read_only" | "full" | "none",
): string[] {
  // Nested agents are blocked in every mode — see NESTED_AGENT_TOOLS comment.
  if (toolsMode === "full") return [...NESTED_AGENT_TOOLS];
  if (toolsMode === "none") return [...ALL_USER_TOOLS];
  // read_only: block write tools + Bash + nested agents. Bash EST un vecteur
  // d'ecriture (`echo > f`, `rm`, `sed -i`) ; l'omettre laissait un agent
  // read-only ecrire l'arbre sous --dangerously-skip-permissions, ou seul
  // --disallowedTools bloque vraiment (l'allowlist y est ignoree). DF4.
  return [...WRITE_USER_TOOLS, "Bash", ...NESTED_AGENT_TOOLS];
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

// promptweave APLATIT les params runtime à l'assemblage. `current_task`,
// `my_discoveries` et `existing_threads` sont déclarés `default: ""` dans
// behaviors/phase-execute.yaml, behaviors/security-fix.yaml et
// behaviors/phase-review.yaml : au rendu du prompt ils valent "", donc le
// marqueur DISPARAÎT — le bloc `{{#if params.current_task}}` est supprimé en
// entier, `{{params.my_discoveries}}` est interpolé à vide. Les `.replace()`
// d'ici ne trouvaient alors plus rien : l'agent d'execute ne savait jamais
// quelle tâche il avait réclamée, et la phase review dédoublonnait sur deux
// listes vides.
//
// On garde la substitution quand le marqueur a survécu (un prompt qui le
// contient encore doit être substitué en place, pas se voir accoler un second
// bloc), et on ne concatène qu'à défaut. Le marqueur survivant est substitué
// MÊME par une valeur vide : c'est ce que faisait le .replace() d'origine, et
// laisser un {{params.…}} littéral partir au LLM serait pire que rien.
function injectRuntimeParam(prompt: string, param: string, heading: string, value: string): string {
  return injectRuntimeParams(prompt, [{ param, heading, value }]);
}

/**
 * Substitue tous les params EN UNE PASSE sur le prompt d'ORIGINE, puis concatène
 * ceux dont le marqueur n'a pas survécu à l'assemblage.
 *
 * La passe unique est le point : enchaîner les injections ferait rescanner la
 * valeur déjà injectée du param précédent — du texte produit par un LLM, et
 * essaim lance ses swarms sur ce dépôt, dont les YAML contiennent justement ces
 * marqueurs — à la recherche du marqueur du suivant.
 */
function injectRuntimeParams(
  prompt: string,
  params: { param: string; heading: string; value: string }[],
): string {
  const byName = new Map(params.map((p) => [p.param, p]));
  const substituted = new Set<string>();
  // Remplacement par fonction, délibérément : la valeur de retour d'un replacer
  // est insérée littéralement, là où une chaîne de remplacement interpréterait
  // les motifs $&, $' et $backtick du texte produit par le LLM.
  const out = prompt.replace(/\{\{params\.(\w+)\}\}/g, (marker, name: string) => {
    const p = byName.get(name);
    if (!p) return marker;
    substituted.add(name);
    return p.value;
  });
  return params.reduce(
    (acc, p) =>
      substituted.has(p.param) || !p.value ? acc : `${acc}\n\n## ${p.heading}\n${p.value}`,
    out,
  );
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

export async function announceViaRest(
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
    // PAS d'estampille run_id ici — et c'est DÉLIBÉRÉ, contrairement aux deux
    // autres chemins d'annonce (postDiscoveries et le NOUVEAU groupé, qui la
    // passent tous deux depuis #32).
    //
    // Elle ne fermerait qu'une fuite INTER-runs, dont le banc de 6 runs n'a
    // mesuré aucune occurrence, et dont le vrai dommage — être réclamée comme
    // tâche — est déjà fermé par isWorkItem() dans work-stealing.ts. En face,
    // elle régresserait une ligne de rapport rendue honnête exprès :
    // /api/threads-summary filtre en ÉGALITÉ STRICTE sur run_id (voir le
    // commentaire de fetchThreadsSummary dans orchestrator/metrics.ts), donc
    // les annonces en sont aujourd'hui exclues et la note « État final
    // (coordinator, faisant autorité) » ne compte que du vrai travail.
    // Estampillées, les N annonces de boot entreraient dans le total : un raid
    // à 4 agents qui corrige 4 bugs afficherait 8 threads au lieu de 4.
    // Vérifié sur un rapport réel du banc : threads_opened=9, threads_final
    // {total:4, poisoned:4} — l'égalité stricte est prouvée par artefact.
    //
    // À rouvrir seulement si /api/threads-summary apprend à ne compter que les
    // items de travail (`AND timeout_seconds = 0`), côté mcp-coordinator.
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
  // Durée du dernier envoi. Sert d'estimation du coût en temps d'une tâche
  // avant d'en réclamer une nouvelle (voir la boucle de work-stealing).
  let lastSendMs = 0;
  let mqttMessagesProcessed = 0;
  let exitReason: ExitReason = "done";
  // #184 — SANTÉ DU CHEMIN D'ÉCRITURE AU SEMIS. Une phase discover/review qui a
  // TROUVÉ du travail mais n'en a consigné AUCUN (tous les POST /api/announce
  // échouent : coordinator lisible, écriture morte) laisse la piscine « vide-
  // mais-joignable » ; la boucle execute en sortait "done" — faux vert : l'agent
  // a trouvé des bugs qui n'existeront jamais côté coordinator. Sticky : un seul
  // semis totalement perdu suffit à teindre le run en rouge. Le garde #151
  // (unreachableStreak) ne le voit pas — il ne surveille que le chemin de CLAIM.
  let seedWriteFailed = false;
  // Registre par tâche (#162) : rempli aux points de règlement (settleDone) et
  // d'abandon (pas de DONE:), remonté dans AgentLoopResult puis au rapport.
  const taskRecords: TaskRecord[] = [];
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

  /**
   * Ligne de base du garde-fou de falsifiabilité, UNE PAR THREAD.
   *
   * Clé = le thread, jamais l'agent. Une base unique par agent, relevée au
   * démarrage de la boucle, serait plus courte et complaisante : le même
   * worktree sert à toutes les tâches d'affilée, donc le test écrit pour la
   * tâche 1 créditerait la tâche 2 qui n'en a produit aucun. Voir le cas
   * « ne crédite PAS un thread du test écrit pour le thread précédent ».
   *
   * PURGÉE À LA COMPLÉTION (voir settleDone). Le cas « thread complété, puis
   * un AUTRE thread sur le même fichier » se règle tout seul — l'autre thread
   * a sa propre clé, donc sa propre base, qui inventorie le travail du premier
   * comme préexistant, commité ou non. Ce qui reste à trancher est le thread
   * ROUVERT par le coordinator : sans purge il rejouerait éternellement la
   * base de sa toute première réclamation et se ferait créditer d'un test déjà
   * livré. On purge donc — une reprise après complétion repart d'une base
   * fraîche et doit prouver son propre travail. Le sens conservateur : le
   * garde-fou peut trop demander, jamais trop peu.
   *
   * Portée du run, comme claimedThreadIds : un thread abandonné au cycle N
   * peut être re-réclamé au cycle N+1, dans le même worktree.
   */
  // UN SEUL emplacement, pas une Map — et c'est le point du correctif.
  //
  // Une Map par thread paraissait plus juste : chaque thread garderait sa base
  // et la retrouverait à la reprise. Deux relectures indépendantes l'ont cassée
  // par exécution : l'entrée survit à l'abandon, mais aussi à TOUT ce qui se
  // passe entre les deux tentatives. Ordonnancement mesuré — A réclamé (base
  // S0), A abandonné, B réclamé, B écrit son test et COMMITE (ce que
  // phase-execute.yaml:56 ordonne), B complété, puis A re-réclamé : `git diff
  // S0 HEAD` remonte alors les fichiers de B, et A est ACCEPTÉ sur la preuve
  // de B sans avoir rien écrit. Le garde-fou devenait complaisant là où main
  // refusait correctement.
  //
  // Un emplacement unique rend la péremption impossible par construction :
  // toute réclamation d'un AUTRE thread l'écrase, donc la base n'est réutilisée
  // que sur des tentatives CONSÉCUTIVES du même thread — exactement le cas G3
  // (thread 2a2548b3 déréclamé en error_max_turns puis re-réclamé dans la
  // foulée, le test de la tentative 1 restant invisible et un travail réel
  // jeté). Effacé aussi à la complétion : un thread rouvert doit reprouver.
  let lastBaseline: { threadId: string; base: { sha: string; untracked: string[] } } | null = null;

  const mqtt: MqttListener = createMqttListener({
    url: config.mqttUrl,
    agentId: config.agentId,
    agentModules: config.modules,
    coordinatorUrl: config.coordinatorUrl,
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

  // La télémétrie par tour partait vers /api/token-usage, route supprimée dans le
  // coordinator 2.x. Le try/catch avalait déjà l'échec ; on ne garde pas un appel
  // dont on sait qu'il ne peut plus aboutir. Le compteur local et le rapport
  // reports/YYYY-MM-DD-<run-id>.md sont indépendants et restent en place.

  async function send(content: string, opts?: SendOptions): Promise<AssistantResponse> {
    logger.info(`Sending to claude (${content.length} chars): ${content.slice(0, 80)}...`);
    // AskUserQuestion attend une réponse humaine ; un run headless n'en a pas.
    // Le binaire renvoie "ask" sur requiresUserInteraction() AVANT d'évaluer
    // bypassPermissions : --dangerously-skip-permissions ne le débloque donc
    // jamais, mais ne le bloque pas non plus — seule une règle de deny mord.
    // Le merge se fait ici, pas dans disallowedForMode(), parce que la moitié
    // des envois de cette session ne passent aucune option : coordination
    // (ask_llm_decide / ask_llm_respond / propose_resolution) et mode one-shot.
    const blocked = new Set(opts?.disallowedTools ?? []);
    for (const tool of ALWAYS_BLOCKED) blocked.add(tool);
    // DF4 — verrou lecture seule au niveau SESSION. Un agent read-only (preset
    // avec read-only-mode) ne doit ecrire sous AUCUN envoi : ni le one-shot, ni
    // les envois de coordination (ask_llm_*, propose_resolution) qui ne passent
    // aucune option. Sous --dangerously-skip-permissions, seul --disallowedTools
    // bloque dur ; le poser ici couvre TOUS les envois d'un coup. Les phases
    // (phased mode) passent deja leur propre disallow, superset compatible.
    if (config.readOnly) for (const tool of disallowedForMode("read_only")) blocked.add(tool);
    const resp = await claude.send(content, { ...opts, disallowedTools: [...blocked] });

    totalCost += resp.costUsd;
    turnsCount++;

    // Accumulate tokens
    const t: TokenUsage = resp.tokens ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    // Même prudence que pour `tokens` juste au-dessus, et pour la même raison :
    // les tests de ce module montent des AssistantResponse partielles.
    const c: CompactionInfo = resp.compaction ?? { count: 0, preTokens: 0, postTokens: 0 };
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
      compactions: c.count,
      compactionPreTokens: c.preTokens,
      compactionPostTokens: c.postTokens,
    };
    lastSendMs = resp.durationMs;
    turnDetails.push(detail);

    // Suffixe conditionnel : n'apparaît que si le contexte a été compacté, pour
    // ne pas noyer la ligne de tour normale sous des zéros.
    const compactSuffix = c.count > 0
      ? ` compact=${c.count} (${formatTokens(c.preTokens)}→${formatTokens(c.postTokens)})`
      : "";

    logger.info(
      `Turn ${turnsCount} [${currentPhase}] ${model.split("-")[1] ?? model}: ` +
      `in=${formatTokens(t.inputTokens)} out=${formatTokens(t.outputTokens)} ` +
      `cache-r=${formatTokens(t.cacheReadTokens)} cache-w=${formatTokens(t.cacheCreationTokens)} ` +
      `hit=${cacheHitPct}% cost=$${resp.costUsd.toFixed(4)} ` +
      `(${resp.durationMs}ms, ${resp.toolCalls.length} tools)` + compactSuffix,
    );

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
    // interruptClaude est une session SEPAREE : elle ne passe pas par le wrapper
    // `send`, donc le verrou read_only doit etre applique ici aussi (DF4). Le
    // contenu d'une interruption vient d'un pair — un agent read-only ne doit
    // pas pouvoir ecrire l'arbre sur injection.
    const interruptBlocked = [
      ...ALWAYS_BLOCKED,
      ...(config.readOnly ? disallowedForMode("read_only") : []),
    ];
    await interruptClaude.send(formatted, { maxTurns: 1, disallowedTools: interruptBlocked });
    return true;
  }

  // ── Helper: process protocol actions ──────────────────────────────

  async function processProtocolActions(): Promise<void> {
    // Le protocole envoie des tours (ask_llm_decide / ask_llm_respond /
    // propose_resolution) à n'importe quel moment du run, phases commencées
    // comprises : sans ça ils étaient facturés à la dernière phase traversée.
    const prevPhase = currentPhase;
    currentPhase = "coordination";
    try {
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
          case "post_to_thread": {
            // #108 : porte le plan révisé jusqu'aux pairs. Le coordinator le
            // rediffuse sur consultations/<id>/messages, donc ils le reçoivent
            // en push sans qu'on ait à ré-annoncer.
            await postToThreadViaRest(
              config.coordinatorUrl,
              action.threadId,
              config.agentId,
              config.agentName,
              action.content,
            );
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
            const content = resp.content.trim();
            const decision = content.toUpperCase();
            if (decision.startsWith("YIELD")) {
              protocol.decideYield();
            } else if (decision.startsWith("ADJUST")) {
              // The LLM's reply is "ADJUST" followed by its new plan — strip
              // the leading token (and any separator like ":" or "-") to get
              // the plan text.
              const newPlan = content.slice("ADJUST".length).replace(/^[:\s-]+/, "").trim();
              if (newPlan) {
                protocol.decideAdjust(newPlan);
              } else {
                // Malformed ADJUST (no plan attached) — don't let it wedge the
                // loop on a plan we don't have. Fall back to the safe default.
                logger.warn("ADJUST decision had no plan attached — falling back to CONTINUE", {
                  threadId: action.threadId,
                });
                protocol.decideContinue();
              }
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
    } finally {
      currentPhase = prevPhase;
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
                  const posted = await postDiscoveries(config.coordinatorUrl, config.agentId, tasks);
                  if (posted.length === 0) {
                    logger.error(`Discovery: ${tasks.length} trouvaille(s) et 0 thread enregistré — write-path coordinator mort (#184)`);
                    seedWriteFailed = true;
                  }
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

              // Inject both lists into the review prompt — substitution quand le
              // marqueur a survécu à l'assemblage, concaténation sinon.
              const reviewPrompt = injectRuntimeParams(phase.prompt, [
                { param: "my_discoveries", heading: "Tes trouvailles (de la phase discovery)", value: discoveryContent },
                { param: "existing_threads", heading: "Threads déjà ouverts par d'autres agents", value: existingThreads },
              ]);

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
                // La review a du NEUF à semer mais l'écriture a tout raté : faux vert (#184).
                if (result.newAttempted > 0 && result.posted === 0) {
                  logger.error(`Review: ${result.newAttempted} nouveau(x) thread(s) tenté(s), 0 enregistré — write-path coordinator mort (#184)`);
                  seedWriteFailed = true;
                }
              } else {
                // Fallback: if LLM didn't follow format, post all discoveries as-is
                logger.warn("Review: no structured actions found, posting all discoveries as fallback");
                const tasks = parseDiscoveries(discoveryContent);
                const reviewPreview = resp.content.slice(0, 300).replace(/\n/g, "\\n");
                logger.info(`Review fallback: ${tasks.length} tasks parsed from discovery content (${discoveryContent.length} chars). Haiku's response preview: ${reviewPreview}`);
                if (tasks.length > 0) {
                  const posted = await postDiscoveries(config.coordinatorUrl, config.agentId, tasks);
                  if (posted.length === 0) {
                    logger.error(`Review fallback: ${tasks.length} trouvaille(s) et 0 thread enregistré — write-path coordinator mort (#184)`);
                    seedWriteFailed = true;
                  }
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
            // UN seul compteur de « pas de progrès » (pool vide OU coordinator
            // injoignable) décide QUAND abandonner ; un compteur d'injoignabilités
            // dans la fenêtre décide du VERDICT. >= 2 injoignabilités => ROUGE
            // ("coordinator_unreachable"), sinon un pool constamment vide => "done".
            // Un seuil de 2 (et non 1) évite qu'UN blip transitoire en fin de drain
            // ne bascule un run terminé en faux rouge, tout en attrapant un
            // coordinator mort ou qui flappe. Deux compteurs séparés créaient une
            // COURSE non déterministe rouge/vert ; ici un seul décide (#151).
            const MIN_UNREACHABLE_FOR_RED = 2;
            let noProgressRetries = 0;
            let unreachableStreak = 0;
            // Laissé à 3, contre mon intuition — et c'est la mesure qui a
            // tranché. Le garde-fou isWorkItem() supprime une temporisation
            // ACCIDENTELLE : avant, un agent arrivé en execute avant ses pairs
            // réclamait une annonce et y brûlait des minutes, pendant
            // lesquelles les découvertes des pairs plus lents atterrissaient.
            // La crainte était qu'un agent rapide sorte désormais en 30 s sans
            // rien faire. Sur les 3 runs de validation, ça ne s'est produit
            // AUCUNE fois : les 4 agents de chaque run ont pris leur tâche
            // (« 1 tasks done » x4), et le second cycle seul trouve le pool
            // vide. Porter le budget à 6 aurait ajouté 30 s d'attente par
            // agent et par cycle pour un problème qui ne se manifeste pas.
            const MAX_NO_PROGRESS_RETRIES = 3;
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

              // Ne pas réclamer ce qu'on n'a pas le temps de finir. Le budget
              // contraignant est l'horloge, pas maxTurns : mesuré, 7 à 17 envois
              // pour un plafond de 50. Un SIGKILL du timeout en plein envoi
              // laisse la tâche réclamée ; le balayage la désréclame, et cette
              // désréclamation compte vers l'empoisonnement du thread au même
              // titre qu'un abandon de qualité. 1,5 × la durée du dernier envoi
              // est la marge la moins arbitraire dont on dispose.
              if (lastSendMs > 0) {
                const need = lastSendMs * 1.5;
                const left = remainingBudgetMs();
                if (left < need) {
                  logger.info(
                    `Work-stealing: pas de nouvelle réclamation — ${Math.round(left / 1000)}s restantes < ${Math.round(need / 1000)}s estimées`,
                  );
                  break;
                }
              }

              // Claim next task
              logger.debug(`Work-stealing: attempting claim (turn ${turnsCount}/${maxTurns}, done=${tasksDone})`);
              const task = await claimNextTask(config.coordinatorUrl, config.agentId);

              // Pas de tâche : soit la piscine est vide (`null`), soit le
              // coordinator est INJOIGNABLE (COORDINATOR_UNREACHABLE #151). On
              // retente les deux à la même cadence, avec UN seul compteur — mais
              // si l'injoignabilité est survenue au moins une fois dans la fenêtre,
              // on sort en ROUGE ("coordinator_unreachable"), jamais "done" (un
              // coordinator mort/flappant n'est pas un travail fini). Un pool
              // constamment vide (jamais injoignable) sort en "done".
              if (task === COORDINATOR_UNREACHABLE || !task) {
                if (task === COORDINATOR_UNREACHABLE) unreachableStreak++;
                noProgressRetries++;
                if (noProgressRetries > MAX_NO_PROGRESS_RETRIES) {
                  if (unreachableStreak >= MIN_UNREACHABLE_FOR_RED) {
                    logger.error(`Work-stealing: coordinator injoignable (${unreachableStreak}×) pendant la fenêtre de réessai — abandon (rapport rouge)`);
                    exitReason = "coordinator_unreachable";
                  } else {
                    logger.info(`Work-stealing: pool empty after ${MAX_NO_PROGRESS_RETRIES} retries — done`);
                    poolExhaustedLastCycle = true;
                  }
                  break;
                }
                const why = task === COORDINATOR_UNREACHABLE ? "coordinator injoignable" : "pool vide";
                logger.info(`Work-stealing: ${why}, attente (essai ${noProgressRetries}/${MAX_NO_PROGRESS_RETRIES})...`);
                await new Promise((r) => setTimeout(r, EMPTY_WAIT_MS));
                await processInterrupts();
                continue;
              }

              // Reset on successful claim (progrès réel)
              noProgressRetries = 0;
              unreachableStreak = 0;
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
              // #169 — HONORER les overrides model/thinking de phase-execute. Le
              // levier documenté ne marchait que sur discover/review (via
              // phaseEffortProfile) ; execute prenait le profil BRUT, donc
              // `--set phase-execute.model=X` était ignoré sur la phase la plus
              // chère. Le maxTurns reste piloté par le profil/sévérité (cf. note
              // ci-dessus), seuls model/thinking sont surchargés.
              const baseProfile = EFFORT_PROFILES[upgraded];
              const execProfile = {
                ...baseProfile,
                model: phase.model && phase.model !== "" ? phase.model : baseProfile.model,
                thinking: phase.thinking && phase.thinking !== "" && isThinkingLevel(phase.thinking)
                  ? phase.thinking
                  : baseProfile.thinking,
              };
              if (upgraded !== baseLevel) {
                logger.info(`Effort upgrade: ${baseLevel} → ${upgraded} (severity=${severity})`);
              } else {
                logger.debug(`Effort: ${upgraded} (model=${execProfile.model}, maxTurns=${execProfile.maxTurns})`);
              }

              // Execute one task. When work already landed on this file, say so:
              // an agent is otherwise blind to its peers, which is how three
              // hunters each committed a near-identical repro test for one bug
              // (#30). Ce contexte couvre le cas SÉQUENTIEL — un pair a déjà
              // livré sur ce fichier avant nous.
              //
              // Le cas CONCURRENT n'est pas couvert, contrairement à ce que
              // disait ce commentaire : work-stealing.ts:226-231 est explicite,
              // claim-task est atomique sur thread_id seul, pas sur le fichier,
              // donc deux agents peuvent réclamer deux threads distincts qui
              // partagent un fichier. Le correctif est côté coordinator
              // (swoofer/mcp-coordinator#258). Un commentaire qui affirmait le
              // contraire de son propre module a déjà envoyé un triage sur une
              // fausse piste (#107).
              let taskPrompt = injectRuntimeParam(phase.prompt, "current_task", "Détails de la tâche", task.description);
              if (task.relatedDone?.length) {
                taskPrompt += `\n\n## Déjà livré sur ce fichier (par un autre agent, ce run)\n`
                  + task.relatedDone.map((s) => `- ${s}`).join("\n")
                  + `\n\nAvant d'écrire quoi que ce soit : lis ce qui existe déjà.\n`
                  + `- Même cause racine que ta tâche ? Alors c'est un DOUBLON : ne commite RIEN, `
                  + `résous ton thread en disant « DUP de <ce qui existe> » et passe à la suite.\n`
                  + `- Cause réellement différente ? Alors ÉTENDS le test existant plutôt que d'en `
                  + `créer un quasi identique à côté.`;
              }
              const execTools = toolsForMode(phase.toolsMode, config.allowedTools);
              const execBlocked = disallowedForMode(phase.toolsMode);
              const freshExec = config.freshSessionPerTask === true;

              // Relevé AVANT le premier envoi : le garde-fou de falsifiabilité
              // compare contre ce SHA. Sans lui il n'inspecte que l'arbre de
              // travail, que le commit par tâche vide — 54 refus « aucun
              // fichier de test modifié » sur un banc de 6 runs.
              //
              // RELEVÉ UNE FOIS PAR THREAD, PAS PAR TENTATIVE. Une tâche peut
              // être re-réclamée par le MÊME agent après un abandon sans DONE:
              // (`error_max_turns`), et le travail de l'essai précédent est
              // alors DÉJÀ dans l'arbre. Mesuré au run G3 : un refus sur douze,
              // thread 2a2548b3 réclamé deux fois — l'essai 1 écrit source et
              // test sans commiter, l'essai 2 n'a plus rien à écrire, lance les
              // tests et dit DONE:. Une base relevée à la seconde réclamation
              // inventorie le test de l'essai 1 comme non-suivi PRÉEXISTANT, le
              // soustrait, et refuse « aucun fichier de test modifié » sur un
              // travail réellement fait — qui part ensuite à la poubelle. La
              // soustraction de #142 retournée contre le correctif qu'elle
              // protège. L'unité de jugement est le THREAD.
              const falsifiabilityDeps = gitExec(config.workspacePath);
              let taskBase: { sha: string; untracked: string[] } | undefined =
                lastBaseline?.threadId === task.id ? lastBaseline.base : undefined;
              if (phase.requireFailingTest && !taskBase) {
                taskBase = await taskBaseline(falsifiabilityDeps);
                // `taskBaseline` rend undefined si git a hoqueté — on ne
                // mémorise QUE les relevés réussis. Mémoriser un échec le
                // figerait pour toutes les tentatives suivantes du thread,
                // alors qu'un `index.lock` (l'agent commite dans le même
                // worktree) est une collision ordinaire dont la tentative
                // suivante doit pouvoir se relever.
                lastBaseline = taskBase ? { threadId: task.id, base: taskBase } : null;
              }

              /**
               * Un seul chemin « l'agent a dit DONE: », pour les DEUX envois.
               * Celui de reprise après rate limit appelait completeTask sans
               * passer par le garde-fou : un DONE arraché après la pause était
               * accepté sans preuve, `requireFailingTest` ou non.
               *
               * Le DONE: ne suffit pas quand le behavior exige une preuve.
               * Mesuré : un agent a « corrigé » deux champs non contrôlables
               * par le moteur, avec un test qui passait avant comme après.
               * Un FALSE_POSITIVE n'a ni patch ni test : c'est une issue que
               * la mission de sentinelle autorise explicitement. Mesuré sur un
               * vrai swarm — un agent a correctement identifié le faux positif
               * et s'est fait refuser sa résolution, faute de test à montrer.
               */
              const settleDone = async (content: string, after: string): Promise<void> => {
                const taskSummary = extractDoneSummary(content, "Done");
                const verdict =
                  phase.requireFailingTest && !FALSE_POSITIVE_PATTERN.test(taskSummary)
                    ? await verifyFailingTest(falsifiabilityDeps, testCommandFor(config.workspacePath), taskBase?.sha, taskBase?.untracked, detectLanguage(config.workspacePath).language)
                    : null;
                if (verdict && !verdict.falsifiable) {
                  logger.warn(`Work-stealing: DONE refusé — ${verdict.reason}`, {
                    taskId: task.id,
                    testFiles: verdict.testFiles,
                  });
                  // Dire POURQUOI dans le thread. Sans ça le prochain agent
                  // reprend la tâche sans savoir ce qui a été refusé et refait
                  // la même chose : mesuré, trois refus d'affilée pour « aucun
                  // test » sur des tâches reprises en boucle.
                  await postRefusal(config, task.id, verdict.reason);
                  await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                  taskRecords.push({ threadId: task.id, verdict: "refused", reason: verdict.reason });
                  return;
                }
                logger.info(`Work-stealing: completed${after} — "${taskSummary.slice(0, 80)}"`);
                await completeTask(config.coordinatorUrl, task.id, config.agentId, taskSummary);
                taskRecords.push({ threadId: task.id, verdict: "done", reason: taskSummary.slice(0, 140) });
                // La base ne survit PAS à la complétion : elle n'existe que
                // pour recoller les tentatives d'un thread INACHEVÉ. Sur refus,
                // au contraire, on la garde — c'est tout l'objet du correctif.
                lastBaseline = null;
                tasksDone++;
              };

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
                    await settleDone(retryResp.content, " after retry");
                  } else {
                    logger.warn(`Work-stealing: aborting task after retry (no DONE:) — unclaiming thread=${task.id} subtype=${retryResp.subtype ?? "?"}`);
                    await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                    claimedThreadIds.delete(task.id);
                    taskRecords.push({ threadId: task.id, verdict: "aborted", reason: `pas de DONE: après reprise (${retryResp.subtype ?? "?"})` });
                  }
                } else {
                  logger.error("Work-stealing: still rate limited after wait — stopping");
                  await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                  claimedThreadIds.delete(task.id);
                  exitReason = "rate_limited";
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
                await settleDone(resp.content, "");
              } else {
                // subtype distingue « l'agent a divagué » (success) de « il a
                // manqué de tours » (error_max_turns). On le JOURNALISE sans
                // brancher dessus : la décision reste l'abandon, mais elle
                // devient diagnosticable.
                logger.warn(`Work-stealing: aborting task (no DONE: marker) — unclaiming thread=${task.id} subtype=${resp.subtype ?? "?"}`);
                await unclaimTask(config.coordinatorUrl, task.id, config.agentId);
                claimedThreadIds.delete(task.id);
                taskRecords.push({ threadId: task.id, verdict: "aborted", reason: `pas de DONE: (${resp.subtype ?? "?"})` });
              }
            }
            // Réconcilie l'injoignabilité à TOUTE sortie de boucle, pas seulement
            // au seuil : les sorties par budget (« plus le temps de réclamer ») et
            // par MQTT-idle font un `break` nu qui laisserait exitReason="done".
            // Si le coordinator a été injoignable >= 2× dans la fenêtre en cours,
            // le run n'est PAS « fini » (faux vert) — il est rouge (#151).
            if (unreachableStreak >= MIN_UNREACHABLE_FOR_RED && exitReason === "done") {
              logger.error(`Work-stealing: coordinator injoignable (${unreachableStreak}×) à la sortie de boucle — rapport rouge`);
              exitReason = "coordinator_unreachable";
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
        // #184 — Un semis totalement perdu (trouvailles trouvées, 0 consigné) prime
        // sur "done" : le run n'est pas fini, il est rouge. Même verdict que le
        // chemin de claim injoignable (#151) — l'utilisateur voit du rouge, pas un
        // faux succès sur un travail qui n'existera jamais côté coordinator.
        if (seedWriteFailed && exitReason === "done") {
          logger.error("Semis: des trouvailles n'ont JAMAIS été enregistrées (write-path coordinator mort) — rapport rouge (#184)");
          exitReason = "coordinator_unreachable";
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
        currentPhase = "main";
        // DF4 : le verrou read_only est applique par le wrapper `send` (voir
        // `if (config.readOnly)` plus haut), donc les envois one-shot ci-dessous
        // heritent du blocage d'ecriture sans traitement special ici.
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

  // Chaque sortie nominale dépareille unclaimTask avec un
  // claimedThreadIds.delete(), donc ce balayage ne voit normalement rien. Il
  // couvre le cas qui échappait à toutes : une exception entre le claim et
  // l'une de ces sorties laissait le thread réservé sur le coordinator,
  // assigné à un agent mort, et donc involable par les autres (#101).
  // Best-effort : le run se termine de toute façon, et un unclaim qui échoue
  // ne doit pas masquer l'exitReason déjà déterminé.
  for (const threadId of claimedThreadIds) {
    await unclaimTask(config.coordinatorUrl, threadId, config.agentId).catch(() => {});
  }
  claimedThreadIds.clear();

  const result: AgentLoopResult = {
    agentId: config.agentId,
    exitReason,
    summary,
    taskRecords: taskRecords.slice(),
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

