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

  return {
    agents_count: 0,
    duration_total_ms: 0,
    threads_opened: threadOpened.length,
    threads_resolved_consensus: resolutionProposed.length,
    threads_auto_resolved: threadOpened.length - resolutionProposed.length,
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

export async function fetchCoordinatorMetrics(coordinatorUrl: string): Promise<CoordinatorMetrics> {
  let sseRaw = "";
  try {
    const resp = await getWithTimeout(
      `${coordinatorUrl}/api/events`,
      { headers: { "Last-Event-ID": "1", ...authHeaders() } },
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


