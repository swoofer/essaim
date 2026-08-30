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
    // Sans état final autoritaire, l'estimation SSE reste (seule source), relibellée (#154).
    expect(md).toContain("| Sans consensus (estimation SSE : timeout/empoisonnés/abandonnés) | 4 |");
  });
});

// mcp-coordinator 2.3.0 — POST /api/threads-summary renvoie l'état FINAL des
// threads, faisant autorité et scopé par run_id côté serveur (là où tout le
// tableau reste dérivé d'une fenêtre d'événements SSE non scopée par run —
// voir le docstring de fetchCoordinatorMetrics). Les deux sources répondent
// à des questions différentes et ne doivent JAMAIS partager une ligne du
// tableau : mélanger même un seul champ (round 2, finding critique) suffit
// à faire imprimer un "Threads ouverts" inférieur à son propre "Consensus".
// Le tableau reste donc entièrement SSE ; threads_final ne sert que dans la
// ligne de note distincte, qui suffit à elle seule à rendre 'poisoned' et
// 'cancelled' visibles.
describe("writeReport — état final du coordinator (threads-summary) reste hors du tableau", () => {
  function runAvecEtatFinal(): RunResult {
    const base = runReel();
    // total(9) = open(0) + resolving(0) + resolved(2) + cancelled(1) + poisoned(6).
    base.coordinator_metrics.threads_final = { total: 9, open: 0, resolving: 0, resolved: 2, cancelled: 1, poisoned: 6 };
    base.coordinator_metrics.threads_resolved_consensus = 2;
    base.coordinator_metrics.threads_auto_resolved = 0;
    return base;
  }

  it("le tableau reste celui du SSE (threads_opened, pas finalState.total) même quand l'état final est disponible", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-final-"));
    const md = readFileSync(writeReport([runAvecEtatFinal()], dir), "utf8");

    // 4 (threads_opened, la source SSE de runReel()), pas 9 (finalState.total).
    expect(md).toContain("| Threads ouverts | 4 |");
    expect(md).toContain("| Consensus (approuvé par tous) | 2 |");
    // Avec l'état final autoritaire présent, l'estimation SSE « Sans consensus »
    // est RETIRÉE : elle contredirait le footnote (empoisonnés/annulés) — #154.
    expect(md).not.toContain("Sans consensus");
  });

  it("rend le statut 'poisoned' visible dans la ligne de note — jusqu'ici structurellement invisible au rapport", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-final-"));
    const md = readFileSync(writeReport([runAvecEtatFinal()], dir), "utf8");

    expect(md).toMatch(/empoisonné/i);
    expect(md).toMatch(/6/);
  });

  // #154 — aucune paire de nombres incompatibles dans le même rapport. Quand
  // l'état final autoritaire est là et dit « 0 empoisonné, 0 annulé », mais que
  // l'estimation SSE (fenêtrée, contaminée par un coordinateur partagé) prétend
  // « 4 sans consensus », les deux se contrediraient. La ligne SSE est donc
  // RETIRÉE : seul le footnote autoritaire parle.
  it("estimation SSE contradictoire vs footnote autoritaire : la ligne « Sans consensus » est retirée (#154)", () => {
    const base = runReel();
    base.coordinator_metrics.threads_resolved_consensus = 9;
    base.coordinator_metrics.threads_auto_resolved = 0;
    base.coordinator_metrics.threads_without_consensus = 4; // estimation SSE contaminée
    base.coordinator_metrics.threads_final = { total: 3, open: 1, resolving: 0, resolved: 2, cancelled: 0, poisoned: 0 };

    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-contam-"));
    const md = readFileSync(writeReport([base], dir), "utf8");

    // Aucune ligne « Sans consensus » : pas de « 4 » qui contredise « poisoned 0 ».
    expect(md).not.toContain("Sans consensus");
    // Le footnote autoritaire donne le vrai décompte (0 empoisonné).
    expect(md).toMatch(/faisant autorité/);
    expect(md).toMatch(/0 empoisonné/);
  });

  // Finding critique (round 2) : "Threads ouverts" était substitué par
  // finalState.total alors que "Consensus" restait SSE — deux sources dans
  // la même ligne de présentation. Réutilise le scénario de contamination :
  // finalState.total(3) tombe sous le Consensus SSE de CE run (9). L'ancien
  // calcul aurait imprimé "Threads ouverts 3" à côté de "Consensus 9" — un
  // total plus petit que le compteur qu'il est censé contenir. threads_opened
  // (10) est ici cohérent avec son propre Consensus (9) : même source, donc
  // pas de contradiction — ce que finalState.total(3) aurait cassé.
  it("« Threads ouverts » vient du SSE, jamais de threads_final : le tableau ne contredit jamais son propre Consensus", () => {
    const base = runReel();
    base.coordinator_metrics.threads_opened = 10;
    base.coordinator_metrics.threads_resolved_consensus = 9;
    base.coordinator_metrics.threads_final = { total: 3, open: 1, resolving: 0, resolved: 2, cancelled: 0, poisoned: 0 };

    dir = mkdtempSync(join(tmpdir(), "rep-outcomes-nomix-"));
    const md = readFileSync(writeReport([base], dir), "utf8");

    expect(md).toContain("| Threads ouverts | 10 |");
    expect(md).not.toContain("| Threads ouverts | 3 |");
  });
});
