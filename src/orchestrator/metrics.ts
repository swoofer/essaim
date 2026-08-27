import type { CoordinatorMetrics } from "./types.js";
import { authHeaders } from "../coordinator-auth.js";

export interface SseEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export function parseSseEvents(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = raw.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const lines = block.split("\n");
    let id = 0;
    let type = "";
    let data = "";

    for (const line of lines) {
      if (line.startsWith("id: ")) id = parseInt(line.slice(4));
      else if (line.startsWith("event: ")) type = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }

    if (type && data) {
      try {
        events.push({ id, type, data: JSON.parse(data) });
      } catch {}
    }
  }
  return events;
}

export function computeMetrics(events: SseEvent[]): CoordinatorMetrics {
  const conflicts_by_layer: Record<string, number> = {};

  for (const e of events) {
    if (e.type === "impact_scored" && Array.isArray(e.data.reasons)) {
      for (const reason of e.data.reasons as string[]) {
        conflicts_by_layer[reason] = (conflicts_by_layer[reason] || 0) + 1;
      }
    }
  }

  const threadOpened = events.filter((e) => e.type === "thread_opened");
  const messagesPosted = events.filter((e) => e.type === "message_posted");
  const introspectionRequested = events.filter((e) => e.type === "introspection_requested");
  const introspectionCompleted = events.filter((e) => e.type === "introspection_completed");
  // A thread's FINAL state only ever arrives in `thread_resolved`: the
  // coordinator emits it exactly once, when the table actually flips, carrying
  // a `resolution_type` of consensus | auto_resolved | timeout | max_rounds |
  // closed | agent_departure (mcp-coordinator, server-setup.ts, the
  // consultation.onResolve callback).
  //
  // `resolution_proposed`, which this used to read, only ever says "someone
  // PROPOSED": on the coordinator side it moves a thread to `resolving`, never
  // to `resolved` (consultation.proposeResolution), and a contested thread
  // emits one per round.
  //
  // A `poisoned` thread — too many unclaims — emits NO event at all: it's a
  // table UPDATE. It can't show up here, and falls into
  // threads_without_consensus.
  const outcomeByThread = new Map<string, string>();
  for (const e of events) {
    if (e.type !== "thread_resolved") continue;
    const id = e.data.thread_id;
    const type = e.data.resolution_type;
    if (typeof id === "string" && typeof type === "string") outcomeByThread.set(id, type);
  }
  const countOutcome = (want: string): number => {
    let n = 0;
    for (const type of outcomeByThread.values()) if (type === want) n++;
    return n;
  };
  const consensus = countOutcome("consensus");
  const autoResolved = countOutcome("auto_resolved");

  // The residual is derived from thread IDENTIFIERS, never from a subtraction
  // of counters. `Math.max(0, opened - consensus - autoResolved)` didn't only
  // guard against a negative — it ERASED: on a mixed window (threads opened
  // here and never resolved, PLUS resolutions of threads opened BEFORE the SSE
  // cursor) it printed "Threads opened 4 | Consensus 5 | Without consensus 0",
  // a label more optimistic than its own data. Counting the opened ids whose
  // outcome is neither consensus nor auto_resolved can't go negative, so the
  // clamp is gone with it.
  const openedIds = new Set<string>();
  for (const e of threadOpened) {
    if (typeof e.data.thread_id === "string") openedIds.add(e.data.thread_id);
  }
  let withoutConsensus = 0;
  for (const id of openedIds) {
    const outcome = outcomeByThread.get(id);
    if (outcome !== "consensus" && outcome !== "auto_resolved") withoutConsensus++;
  }

  return {
    agents_count: 0,
    duration_total_ms: 0,
    threads_opened: threadOpened.length,
    threads_resolved_consensus: consensus,
    threads_auto_resolved: autoResolved,
    threads_without_consensus: withoutConsensus,
    messages_exchanged: messagesPosted.length,
    conflicts_by_layer,
    introspections_triggered: introspectionRequested.length,
    introspections_concerned: introspectionCompleted.filter((e) => e.data.concerned).length,
    avg_resolution_time_ms: 0,
    hot_files: [],
  };
}

/**
 * Read the run's coordination metrics off the coordinator.
 *
 * These calls MUST carry the bearer token. This was the lone REST caller in
 * essaim that shelled out to a bare `curl` with no Authorization header: against
 * a secured coordinator (the k3s deployment) every request 401'd, the SSE replay
 * came back empty, and the report cheerfully printed "Threads ouverts: 0" for a
 * run full of real threads (#29). Metrics that silently read as zero are worse
 * than metrics that fail loudly.
 */
interface BudgetedResponse {
  ok: boolean;
  status: number;
  body: string;
}

/**
 * GET/POST and read the body, the whole thing under ONE time budget.
 *
 * `/api/events` is an SSE stream the coordinator NEVER closes: `handleSse`
 * writes the replay, registers a listener, then starts a keep-alive heartbeat
 * and returns (mcp-coordinator `serve-http.ts`). Its body has no end, so
 * `resp.text()` — which waits for exactly that — can never resolve.
 *
 * Two failure modes, both real, and a fix has to dodge both:
 *
 *   1. Releasing the abort timer once the HEADERS land leaves the body read
 *      with no deadline at all. That was the bug (#58): `fetchLatestEventId`
 *      runs BEFORE `/api/reset`, before workspaces, before any agent spawns,
 *      so the whole run hung at startup against a real coordinator.
 *   2. Letting the budget abort mid-body throws away everything buffered —
 *      which IS the replay we came for. The call returns fast and empty, and
 *      the report prints zeros, the exact symptom #29 was about.
 *
 * So the body is read INCREMENTALLY and whatever arrived is kept. The replay
 * lands in one burst right after the headers; a short silence after it means
 * "that's all there is" — that is what `idleMs` detects, and it is why this
 * returns in milliseconds rather than sitting out the full budget. The budget
 * remains as a hard backstop for a server that dribbles forever.
 *
 * `idleMs` is opt-in: endpoints whose response actually ENDS (hot-files) pass
 * nothing and are read to completion, so a slow transfer is never truncated.
 */
async function getWithBudget(
  url: string,
  init: RequestInit,
  budgetMs: number,
  idleMs?: number,
): Promise<BudgetedResponse> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budgetMs);
  try {
    const resp = await fetch(url, { ...init, signal: abort.signal });
    if (!resp.ok || !resp.body) return { ok: resp.ok, status: resp.status, body: "" };
    return { ok: true, status: resp.status, body: await readBody(resp.body, idleMs) };
  } finally {
    clearTimeout(timer);
  }
}

/** Accumulate a stream until it ends, goes quiet for `idleMs`, or is aborted. */
async function readBody(stream: ReadableStream<Uint8Array>, idleMs?: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  // Carried ACROSS iterations on purpose. When the idle race wins we go round
  // again and re-race the SAME read: issuing a second reader.read() would queue
  // behind the first, which is still in flight and would swallow the very chunk
  // we are waiting for.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  try {
    for (;;) {
      // Swallow the read's rejection here rather than letting it dangle: when
      // the idle race wins, this promise is still in flight and the cancel()
      // below settles it — an unhandled rejection would crash the process.
      pending ??= reader.read().catch(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>);
      const read = pending;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const chunk =
        idleMs === undefined
          ? await read
          : await Promise.race([
              read,
              new Promise<"idle">((r) => {
                idleTimer = setTimeout(() => r("idle"), idleMs);
              }),
            ]).finally(() => clearTimeout(idleTimer));

      if (chunk === "idle") {
        // "A short silence AFTER the burst" — the doc above says APRÈS, and
        // this is where that word is enforced. Honouring idle before a single
        // byte has landed turns a slow first chunk (a loaded 2-core CI runner)
        // into an empty body and zeroed metrics. Nothing read yet means the
        // burst hasn't started, so keep waiting; budgetMs stays the hard net.
        if (out) break;
        continue;
      }
      pending = undefined;
      if (chunk.done) break;
      out += decoder.decode(chunk.value, { stream: true });
    }
    out += decoder.decode();
  } catch {
    // Budget abort, or a torn socket. Keep whatever arrived — partial metrics
    // beat none, and an SSE replay is complete long before the budget expires.
  } finally {
    void reader.cancel().catch(() => {});
  }
  return out;
}

/** Silence after the SSE replay burst that means "the replay is complete". */
const SSE_REPLAY_IDLE_MS = 250;

/**
 * Capture the coordinator's current max event id, to be used as the
 * `Last-Event-ID` cursor baseline for a run that's about to start (#108).
 *
 * Reuses the same replay the SSE endpoint always sends on connect: a
 * `Last-Event-ID: 0` GET returns the last 50 buffered events (fewer if less
 * history exists) in ascending id order — so the max id among them IS the
 * coordinator's current max, regardless of how much history precedes it.
 */
export async function fetchLatestEventId(coordinatorUrl: string): Promise<number> {
  try {
    const resp = await getWithBudget(
      `${coordinatorUrl}/api/events`,
      { headers: { "Last-Event-ID": "0", ...authHeaders() } },
      3000,
      SSE_REPLAY_IDLE_MS,
    );
    if (!resp.ok) return 0;
    const events = parseSseEvents(resp.body);
    return events.reduce((max, e) => Math.max(max, e.id), 0);
  } catch {
    // Coordinator unreachable — degrade to "no baseline" (0), matching the
    // fail-open posture of fetchCoordinatorMetrics itself.
    return 0;
  }
}

/**
 * @param sinceEventId Cursor baseline captured via fetchLatestEventId right
 * before this run's agents started. Only events with a strictly greater id
 * are replayed, so a run no longer reads the coordinator's ENTIRE history —
 * only what happened since. This isolates SEQUENTIAL runs sharing one
 * coordinator; it does NOT isolate CONCURRENT runs, whose event ids
 * interleave in the same stream — full isolation needs coordinator-side
 * run_id filtering, which is out of scope here.
 */
export async function fetchCoordinatorMetrics(coordinatorUrl: string, sinceEventId = 0): Promise<CoordinatorMetrics> {
  let sseRaw = "";
  try {
    // Never send "0" literally: the endpoint special-cases lastEventId<=0 as
    // "give me the last 50 buffered events" rather than "since the start",
    // which would silently cap a long/busy run's metrics. Clamp to at least 1
    // (the previous hardcoded value) so a fresh coordinator with no prior
    // events still gets the full replay instead of the last-50 fallback.
    const cursor = Math.max(sinceEventId, 1);
    const resp = await getWithBudget(
      `${coordinatorUrl}/api/events`,
      { headers: { "Last-Event-ID": String(cursor), ...authHeaders() } },
      3000,
      SSE_REPLAY_IDLE_MS,
    );
    if (resp.ok) {
      sseRaw = resp.body;
    } else {
      console.warn(`[metrics] /api/events → ${resp.status} — counters will read 0`);
    }
  } catch {
    // Coordinator unreachable (or the SSE stream never closes and we abort):
    // degrade to empty metrics rather than failing the run.
  }

  const metrics = computeMetrics(parseSseEvents(sseRaw));

  try {
    // No idle cutoff: unlike /api/events this response actually ends, so it is
    // read to completion and a slow transfer can never be truncated mid-JSON.
    const resp = await getWithBudget(
      `${coordinatorUrl}/api/hot-files`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: "{}",
      },
      2000,
    );
    if (resp.ok) {
      const hotFiles = JSON.parse(resp.body) as { file_path: string }[];
      metrics.hot_files = hotFiles.map((f) => f.file_path);
    }
  } catch {}

  return metrics;
}


