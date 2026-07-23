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
  const resolutionProposed = events.filter((e) => e.type === "resolution_proposed");
  // A thread that cycles contest → re-propose emits MULTIPLE resolution_proposed
  // events for the same thread_id. Counting them flat both inflates
  // threads_resolved_consensus and can push threads_auto_resolved negative
  // (#117) — dedup by thread_id first.
  const resolvedThreadIds = new Set(
    resolutionProposed
      .map((e) => e.data.thread_id)
      .filter((id): id is string => typeof id === "string"),
  );

  return {
    agents_count: 0,
    duration_total_ms: 0,
    threads_opened: threadOpened.length,
    threads_resolved_consensus: resolvedThreadIds.size,
    // Guarded: even after dedup this can go negative when the observed event
    // window doesn't include a thread's own thread_opened event (e.g. it opened
    // just before an SSE replay cursor) but does include its resolution.
    threads_auto_resolved: Math.max(0, threadOpened.length - resolvedThreadIds.size),
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
async function getWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
    const resp = await getWithTimeout(
      `${coordinatorUrl}/api/events`,
      { headers: { "Last-Event-ID": "0", ...authHeaders() } },
      3000,
    );
    if (!resp.ok) return 0;
    const events = parseSseEvents(await resp.text());
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
    const resp = await getWithTimeout(
      `${coordinatorUrl}/api/events`,
      { headers: { "Last-Event-ID": String(cursor), ...authHeaders() } },
      3000,
    );
    if (resp.ok) {
      sseRaw = await resp.text();
    } else {
      console.warn(`[metrics] /api/events → ${resp.status} — counters will read 0`);
    }
  } catch {
    // Coordinator unreachable (or the SSE stream never closes and we abort):
    // degrade to empty metrics rather than failing the run.
  }

  const metrics = computeMetrics(parseSseEvents(sseRaw));

  try {
    const resp = await getWithTimeout(
      `${coordinatorUrl}/api/hot-files`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: "{}",
      },
      2000,
    );
    if (resp.ok) {
      const hotFiles = (await resp.json()) as { file_path: string }[];
      metrics.hot_files = hotFiles.map((f) => f.file_path);
    }
  } catch {}

  return metrics;
}


