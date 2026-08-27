// tests/unit/report-thread-outcomes.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "../../src/orchestrator/reporter.js";
import type { RunResult } from "../../src/orchestrator/types.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// A real run printed "Threads ouverts 4" / "Consensus 9": the counter was fed by
// resolution_proposed events (a PROPOSAL — the coordinator only flips a thread
// to 'resolving' there, never to 'resolved'), deduped by thread_id, over a set
// of thread_ids that isn't even the same set as the observed thread_opened
// events. See metrics.test.ts for the full event-by-event breakdown.
function runReel(): RunResult {
  return {
    project_id: "p",
    project_name: "proj",
    mode: "with_coordinator",
    duration_ms: 1000,
    coordinator_metrics: {
      agents_count: 2,
      duration_total_ms: 1000,
      threads_opened: 4,
      threads_resolved_consensus: 9,
      threads_auto_resolved: 0,
      messages_exchanged: 2,
      conflicts_by_layer: {},
      introspections_triggered: 0,
      introspections_concerned: 0,
      avg_resolution_time_ms: 0,
      hot_files: [],
    },
    agent_results: [],
    custom_metrics: {},
  };
}

describe("writeReport — le tableau ne promet plus un accord qu'il n'a pas mesuré", () => {
  it("n'écrit plus « | Consensus | » ni « | Auto-resolved | »", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-"));
    const md = readFileSync(writeReport([runReel()], dir), "utf8");

    expect(md).not.toContain("| Consensus |");
    expect(md).not.toContain("| Auto-resolved |");
  });
});
