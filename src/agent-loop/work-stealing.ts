// client/agent-loop/work-stealing.ts

import { createLogger } from "../logger.js";
import { authHeaders } from "../coordinator-auth.js";
const log = createLogger("work-stealing");

export interface Task {
  id: string;           // thread_id from coordinator
  description: string;
  file?: string;
  line?: number;
  severity?: string;
}

const DISCOVERY_MARKER = "DISCOVERY:";

/**
 * Parse the LLM's discovery output into structured tasks.
 * Expected format after DISCOVERY: marker:
 *   FICHIER | LIGNE | DESCRIPTION | SEVERITE
 */
export function parseDiscoveries(output: string): Task[] {
  const idx = output.indexOf(DISCOVERY_MARKER);
  if (idx === -1) return [];

  const text = output.slice(idx + DISCOVERY_MARKER.length).trim();
  const tasks: Task[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 3) continue;
    tasks.push({
      id: "",
      description: parts[2],
      file: parts[0] || undefined,
      line: parseInt(parts[1]) || undefined,
      severity: parts[3] || "minor",
    });
  }
  return tasks;
}

// HttpError carries the response status so callers can distinguish expected
// race conditions (404/410) from unexpected failures.
class HttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly body: string) {
    super(`Coordinator ${url} returned ${status}: ${body.slice(0, 200)}`);
  }
}

async function coordinatorPost(url: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
  } catch (err) {
    throw new Error(`Cannot reach coordinator at ${url}: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    throw new HttpError(resp.status, url, bodyText);
  }
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * Post discoveries to coordinator as open threads (keep_open: true).
 * Returns tasks with thread IDs populated.
 */
export async function postDiscoveries(
  coordinatorUrl: string,
  agentId: string,
  tasks: Task[],
): Promise<Task[]> {
  log.debug(`postDiscoveries: ${tasks.length} tasks to post (keep_open=true)`);
  for (const task of tasks) {
    const subject = task.file
      ? `${task.severity ?? "finding"}: ${task.description} (${task.file}${task.line ? ":" + task.line : ""})`
      : `${task.severity ?? "finding"}: ${task.description}`;
    try {
      const data = await coordinatorPost(`${coordinatorUrl}/api/announce`, {
        agent_id: agentId,
        subject: subject.slice(0, 200),
        target_modules: [],
        target_files: task.file ? [task.file] : [],
        keep_open: true,
      });
      task.id = (data.thread_id as string) || "";
      log.info(`posted thread=${task.id}: ${subject.slice(0, 80)}`);
    } catch (err) {
      log.warn(`failed to post: ${subject.slice(0, 80)}`, { error: (err as Error).message });
    }
  }
  const posted = tasks.filter((t) => t.id);
  log.debug(`postDiscoveries: ${posted.length}/${tasks.length} posted successfully`);
  return posted;
}

/**
 * Atomically claim the next available task from the coordinator.
 * Uses POST /api/claim-task which does UPDATE WHERE claimed_by IS NULL.
 * Returns null if no tasks available.
 */
export async function claimNextTask(
  coordinatorUrl: string,
  agentId: string,
): Promise<Task | null> {
  // Get all active threads
  let threads: Array<Record<string, unknown>>;
  try {
    const resp = await fetch(`${coordinatorUrl}/api/threads-active`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: "{}",
    });
    if (!resp.ok) { log.warn("claimNextTask: threads-active failed", { status: resp.status }); return null; }
    const data = await resp.json();
    threads = Array.isArray(data) ? data : [];
  } catch (err) {
    log.warn("claimNextTask: coordinator unreachable", { error: (err as Error).message });
    return null;
  }

  const open = threads.filter((t) => t.status === "open");
  const unclaimed = open.filter((t) => !t.claimed_by);
  log.debug(`claimNextTask: ${threads.length} active, ${open.length} open, ${unclaimed.length} unclaimed`);

  // Try to claim each open, unclaimed thread
  for (const thread of threads) {
    if (thread.status !== "open") continue;
    if (thread.claimed_by) continue;
    // Directed-dispatch: a thread with assigned_to set is only claimable by
    // that named agent. Skipping here avoids hitting claim-task just to get
    // a polite 'success: false, assigned_to: otherAgent'. For workers in a
    // lead/worker preset this is the normal case — most threads target other
    // workers.
    const assignedTo = (thread as Record<string, unknown>).assigned_to as string | null | undefined;
    if (assignedTo && assignedTo !== agentId) continue;

    const threadId = thread.id as string;
    const subject = (thread.subject as string) || "?";
    try {
      const result = await coordinatorPost(`${coordinatorUrl}/api/claim-task`, {
        thread_id: threadId,
        agent_id: agentId,
      });
      if ((result as Record<string, unknown>).success === true) {
        log.info(`claimed thread=${threadId}: ${subject.slice(0, 80)}`);
        return {
          id: threadId,
          description: subject,
          file: undefined,
          severity: undefined,
        };
      }
      log.info(`claim race lost thread=${threadId} to ${(result as Record<string, unknown>).claimed_by as string}: ${subject.slice(0, 60)}`);
    } catch (err) {
      log.warn(`claim error: ${threadId}`, { error: (err as Error).message });
    }
  }

  log.debug("claimNextTask: nothing to claim");
  return null;
}

/**
 * Mark a task complete by proposing resolution.
 */
export async function completeTask(
  coordinatorUrl: string,
  threadId: string,
  agentId: string,
  summary: string,
): Promise<void> {
  log.debug(`completeTask: thread=${threadId}`, { summary: summary.slice(0, 80) });
  await coordinatorPost(`${coordinatorUrl}/api/propose-resolution`, {
    thread_id: threadId,
    agent_id: agentId,
    summary,
  }).catch((err) => {
    log.warn("completeTask failed", { error: (err as Error).message });
  });
}

/**
 * Release a claim on a task so another agent can pick it up.
 * Used when the agent gave up on the task without producing a DONE: marker.
 */
export async function unclaimTask(
  coordinatorUrl: string,
  threadId: string,
  agentId: string,
): Promise<void> {
  log.debug(`unclaimTask: thread=${threadId}`);
  await coordinatorPost(`${coordinatorUrl}/api/unclaim-task`, {
    thread_id: threadId,
    agent_id: agentId,
  }).catch((err) => {
    log.warn("unclaimTask failed", { error: (err as Error).message });
  });
}

// ── Review phase ─────────────────────────────────────────────────────

export type ReviewAction =
  | { type: "nouveau"; description: string }
  | { type: "doublon"; threadId: string }
  | { type: "enrichit"; threadId: string; context: string };

const REVIEW_MARKER = "REVIEW:";

/**
 * Parse the LLM's review output into structured actions.
 * Expected format after REVIEW: marker:
 *   NOUVEAU | description
 *   DOUBLON | thread_id
 *   ENRICHIT | thread_id | additional context
 */
export function parseReviewActions(output: string): ReviewAction[] {
  const idx = output.indexOf(REVIEW_MARKER);
  if (idx === -1) return [];

  const text = output.slice(idx + REVIEW_MARKER.length).trim();
  const actions: ReviewAction[] = [];

  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s*/, "");
    if (!line) continue;
    const parts = line.split("|").map((s) => s.trim());
    if (parts.length < 2) continue;

    const action = parts[0].toUpperCase();
    if (action === "NOUVEAU") {
      actions.push({ type: "nouveau", description: parts[1] });
    } else if (action === "DOUBLON") {
      actions.push({ type: "doublon", threadId: parts[1] });
    } else if (action === "ENRICHIT" && parts.length >= 3) {
      actions.push({ type: "enrichit", threadId: parts[1], context: parts[2] });
    }
  }
  return actions;
}

/**
 * Fetch existing open threads from the coordinator for comparison.
 * Returns a formatted string for injection into the review prompt.
 */
export async function fetchExistingThreads(coordinatorUrl: string): Promise<string> {
  try {
    const resp = await fetch(`${coordinatorUrl}/api/threads-active`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: "{}",
    });
    if (!resp.ok) return "(aucun thread actif)";
    const threads = (await resp.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(threads) || threads.length === 0) {
      log.debug("fetchExistingThreads: 0 threads");
      return "(aucun thread actif)";
    }

    const open = threads.filter((t) => t.status === "open");
    log.debug(`fetchExistingThreads: ${threads.length} total, ${open.length} open`);
    for (const t of open) {
      log.debug(`thread [${t.id}] claimed_by=${t.claimed_by || "none"} -- ${(t.subject as string || "").slice(0, 60)}`);
    }

    return open
      .map((t) => `- [${t.id}] ${t.subject}`)
      .join("\n") || "(aucun thread actif)";
  } catch {
    return "(coordinator non disponible)";
  }
}

/**
 * Extract the file path from a review description like "server/src/foo.ts:123 — ..."
 */
function extractFile(description: string): string {
  const match = description.match(/^(\S+\.\w+)(?::\d+)?/);
  return match ? match[1] : "__ungrouped__";
}

/**
 * Process review actions: post new findings grouped by file, enrich existing threads.
 * Fix 3: Groups NOUVEAU actions by source file to reduce thread count.
 */
export async function processReviewActions(
  coordinatorUrl: string,
  agentId: string,
  agentName: string,
  actions: ReviewAction[],
): Promise<{ posted: number; enriched: number; skipped: number }> {
  let posted = 0;
  let enriched = 0;
  let skipped = 0;

  log.debug(`processReviewActions: ${actions.length} actions to process`);

  // Separate action types
  const nouveaux = actions.filter((a): a is ReviewAction & { type: "nouveau" } => a.type === "nouveau");
  const others = actions.filter(a => a.type !== "nouveau");

  // Group NOUVEAU by source file
  const byFile = new Map<string, string[]>();
  for (const action of nouveaux) {
    const file = extractFile(action.description);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push(action.description);
  }

  // Post one thread per file group
  for (const [file, descriptions] of byFile) {
    const subject = file === "__ungrouped__"
      ? descriptions[0].slice(0, 200)
      : `${file}: ${descriptions.length} issue(s)`;
    const plan = descriptions.map((d, i) => `${i + 1}. ${d}`).join("\n");
    log.debug(`NOUVEAU (grouped): ${subject} — ${descriptions.length} items`);
    try {
      await coordinatorPost(`${coordinatorUrl}/api/announce`, {
        agent_id: agentId,
        subject: subject.slice(0, 200),
        plan,
        target_modules: [],
        target_files: file !== "__ungrouped__" ? [file] : [],
        keep_open: true,
      });
      posted++;
    } catch (err) { log.warn("NOUVEAU group post failed", { error: (err as Error).message }); }
  }

  // Process enrichments and doublons normally
  for (const action of others) {
    if (action.type === "enrichit") {
      log.debug(`ENRICHIT: thread=${action.threadId}`, { context: action.context.slice(0, 60) });
      try {
        await coordinatorPost(`${coordinatorUrl}/api/post-to-thread`, {
          thread_id: action.threadId,
          agent_id: agentId,
          agent_name: agentName,
          type: "context",
          content: action.context,
        });
        enriched++;
      } catch (err) {
        // 404 (thread disappeared) / 410 (thread cancelled) are expected races
        // when the LLM references a thread that resolved/cancelled between the
        // review's list and the post. Log at debug, count as skipped.
        if (err instanceof HttpError && (err.status === 404 || err.status === 410)) {
          log.debug(`ENRICHIT skipped (thread ${err.status}): ${action.threadId}`);
          skipped++;
        } else {
          log.warn("ENRICHIT post failed", { error: (err as Error).message });
        }
      }
    } else {
      log.debug(`DOUBLON: skip thread=${(action as ReviewAction & { threadId?: string }).threadId}`);
      skipped++;
    }
  }

  return { posted, enriched, skipped };
}

