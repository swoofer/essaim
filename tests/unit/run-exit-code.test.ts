import { describe, it, expect } from "vitest";
import { runExitCode } from "../../cli/run.js";
import type { AgentResult, RunResult } from "../../src/orchestrator/types.js";

function agent(id: string, exit_code: number, diff = "", diff_measured?: boolean): AgentResult {
  return { agent_id: id, agent_name: id, exit_code, diff, diff_measured, stdout_length: 0 };
}

function runResult(
  agents: AgentResult[],
  metrics: Partial<RunResult["coordinator_metrics"]> = {},
): RunResult {
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
      ...metrics,
    },
    agent_results: agents,
    custom_metrics: {},
  };
}

describe("runExitCode — TOUS les agents, pas « au moins un »", () => {
  it("0 quand tous les agents réussissent", () => {
    expect(runExitCode(runResult([agent("a1", 0), agent("a2", 0)]))).toBe(0);
  });

  it("0 sur une défaillance PARTIELLE — 2 agents sur 4 est le régime normal d'un essaim", () => {
    // Régime observé sur un run réel à 4 agents : Alpha exit 1, Bravo exit 0
    // (17 lignes de diff), Charlie exit 1, Delta exit 0 (19 lignes). Les
    // survivants ont livré ; le run est exploitable. Une implémentation
    // « au moins un échec → 1 » échoue ICI et nulle part ailleurs.
    expect(
      runExitCode(runResult([agent("a1", 1), agent("a2", 0), agent("a3", 1), agent("a4", 0)])),
    ).toBe(0);
  });

  it("1 quand TOUS les agents ont échoué", () => {
    expect(runExitCode(runResult([agent("a1", 1), agent("a2", 1)]))).toBe(1);
  });

  it("0 pour un run sans aucun agent : [].every() vaut true, ce n'est pas un échec", () => {
    // `essaim security --triage-only` vide project.agents (run-core.ts:103) et
    // un template peut légitimement n'en produire aucun.
    expect(runExitCode(runResult([]))).toBe(0);
  });

  it("0 pour un dry-run : executeRun renvoie undefined, rien n'a tourné", () => {
    expect(runExitCode(undefined)).toBe(0);
  });
});

// #153 — « il ne te dit pas vert quand rien n'a eu lieu ». Des agents qui sortent
// proprement mais ne produisent RIEN (0 thread résolu ET 0 ligne de diff mesurée)
// doivent donner exit 1, pas un faux vert.
describe("runExitCode — 0 résolu ET 0 diff mesuré => 1 (#153)", () => {
  it("agents propres mais 0 résolu et 0 diff MESURÉ -> 1 (acceptance)", () => {
    // diff_measured=true (worktree) + diff vide + 0 thread résolu = rien n'a eu lieu.
    expect(runExitCode(runResult([agent("a1", 0, "", true), agent("a2", 0, "", true)]))).toBe(1);
  });

  it("0 résolu mais du DIFF réel a été livré -> 0 (du travail a eu lieu)", () => {
    expect(runExitCode(runResult([agent("a1", 0, "+ajout\n-suppr", true)]))).toBe(0);
  });

  it("0 diff mais des threads RÉSOLUS -> 0 (du travail a eu lieu)", () => {
    expect(runExitCode(runResult([agent("a1", 0, "", true)], { threads_resolved_consensus: 2 }))).toBe(0);
  });

  it("threads_final fait autorité : resolved=0 y prime sur un compte SSE non nul -> 1", () => {
    const r = runResult([agent("a1", 0, "", true)], {
      threads_resolved_consensus: 3, // estimation SSE, mais…
      threads_final: { total: 3, open: 0, resolving: 0, resolved: 0, cancelled: 0, poisoned: 3 }, // …autorité: 0 résolu
    });
    expect(runExitCode(r)).toBe(1);
  });

  it("run IN-PLACE (diff NON mesuré) + 0 résolu -> 0 (pas de faux rouge : on ne peut pas prouver l'absence de travail)", () => {
    expect(runExitCode(runResult([agent("a1", 0)]))).toBe(0); // diff_measured undefined
  });
});
