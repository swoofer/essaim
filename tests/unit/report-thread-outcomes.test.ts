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
      threads_without_consensus: 4,
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

  // Les deux libellés anglais ci-dessus ont déjà été renommés une première fois
  // (en français) avant même ce test : `not.toContain` sur "| Consensus |" /
  // "| Auto-resolved |" est donc vrai que les trois lignes de compteurs soient
  // présentes ou que quelqu'un les supprime purement et simplement — le test ne
  // discriminait que dans un sens. Ceci vérifie l'autre : les trois lignes du
  // tableau existent réellement, avec les valeurs mesurées.
  it("écrit les trois compteurs de threads avec leurs valeurs mesurées", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-"));
    const md = readFileSync(writeReport([runReel()], dir), "utf8");

    expect(md).toContain("| Threads ouverts | 4 |");
    expect(md).toContain("| Consensus (approuvé par tous) | 9 |");
    expect(md).toContain("| Auto-résolus (aucun agent concerné) | 0 |");
    expect(md).toContain("| Sans consensus (timeout, empoisonnés, abandonnés) | 4 |");
  });
});

// mcp-coordinator 2.3.0 — POST /api/threads-summary renvoie l'état FINAL des
// threads, faisant autorité (là où tout ce qui précède est dérivé d'une
// fenêtre d'événements SSE). Quand il est disponible, il remplace l'estimation
// pour "Threads ouverts" et "Sans consensus" — sans jamais contredire
// "Consensus", qui reste sa seule vraie source (resolution_type n'existe que
// sur thread_resolved, pas dans ce tally).
describe("writeReport — état final du coordinator (threads-summary) remplace l'estimation quand disponible", () => {
  function runAvecEtatFinal(): RunResult {
    const base = runReel();
    // total(9) = open(0) + resolving(0) + resolved(2) + cancelled(1) + poisoned(6).
    base.coordinator_metrics.threads_final = { total: 9, open: 0, resolving: 0, resolved: 2, cancelled: 1, poisoned: 6 };
    base.coordinator_metrics.threads_resolved_consensus = 2;
    base.coordinator_metrics.threads_auto_resolved = 0;
    return base;
  }

  it("remplace « Threads ouverts » et « Sans consensus » par le compte réel, sans contredire Consensus", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-final-"));
    const md = readFileSync(writeReport([runAvecEtatFinal()], dir), "utf8");

    // 9 (le total réel du coordinator), pas 4 (le compte SSE fenêtré de runReel()).
    expect(md).toContain("| Threads ouverts | 9 |");
    expect(md).toContain("| Consensus (approuvé par tous) | 2 |");
    // open(0) + resolving(0) + poisoned(6) + cancelled(1) + (resolved(2) - consensus(2) - auto(0)) = 7
    expect(md).toContain("| Sans consensus (timeout, empoisonnés, abandonnés) | 7 |");
  });

  it("rend le statut 'poisoned' visible — jusqu'ici structurellement invisible au rapport", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-final-"));
    const md = readFileSync(writeReport([runAvecEtatFinal()], dir), "utf8");

    expect(md).toMatch(/empoisonné/i);
    expect(md).toMatch(/6/);
  });
});
