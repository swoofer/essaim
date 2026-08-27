import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "../../src/orchestrator/reporter.js";
import type { AgentResult, RunResult } from "../../src/orchestrator/types.js";

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runResult(agents: AgentResult[]): RunResult {
  return {
    project_id: "p",
    project_name: "proj",
    mode: "with_coordinator",
    duration_ms: 1000,
    coordinator_metrics: {
      agents_count: agents.length, duration_total_ms: 1000, threads_opened: 0,
      threads_resolved_consensus: 0, threads_auto_resolved: 0, threads_without_consensus: 0,
      messages_exchanged: 0,
      conflicts_by_layer: {}, introspections_triggered: 0, introspections_concerned: 0,
      avg_resolution_time_ms: 0, hot_files: [],
    },
    agent_results: agents,
    custom_metrics: {},
  };
}

describe("writeReport — colonne Raison (exit_reason)", () => {
  it("distingue « mort en cours de route » de « jamais démarré »", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-exitreason-"));
    const md = readFileSync(
      writeReport(
        [
          runResult([
            // Agent lancé, boucle morte en route : exit_reason est recopié depuis
            // AgentLoopResult par orchestrator.ts:615.
            { agent_id: "a1", agent_name: "Alpha", exit_code: 1, diff: "", stdout_length: 0, exit_reason: "process_died" },
            // Agent JAMAIS démarré (échec de pré-enregistrement coordinateur,
            // orchestrator.ts:574-575) : exit_code 1, aucun AgentLoopResult,
            // donc exit_reason absent.
            { agent_id: "a2", agent_name: "Bravo", exit_code: 1, diff: "", stdout_length: 0 },
          ]),
        ],
        dir,
      ),
      "utf8",
    );

    expect(md).toContain("| Agent | Exit | Raison | Compilation | Diff (lignes) |");
    expect(md).toContain("| Alpha | 1 | process_died | N/A | 0 |");
    expect(md).toContain("| Bravo | 1 | N/A | N/A | 0 |");
  });
});
