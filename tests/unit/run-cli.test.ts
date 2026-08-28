// tests/unit/run-cli.test.ts
//
// run-exit-code.test.ts covers runExitCode() as a pure decision. Nothing
// verified that createRunCommand()'s action actually feeds its RunResult
// through that function and into process.exit — deleting the call, or
// hardcoding `process.exit(0)` in its place, leaves that suite green (it
// never touches the command). This exercises the real action closure:
// executeRun (network/orchestrator/coordinator) is mocked, process.exit is
// spied on, and only the wiring between the two is asserted.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentResult, RunResult } from "../../src/orchestrator/types.js";

vi.mock("../../cli/run-core.js", () => ({
  executeRun: vi.fn(),
}));

const { executeRun } = await import("../../cli/run-core.js");
const { createRunCommand } = await import("../../cli/run.js");

function agent(id: string, exit_code: number): AgentResult {
  return { agent_id: id, agent_name: id, exit_code, diff: "", stdout_length: 0 };
}

function runResult(agents: AgentResult[]): RunResult {
  return {
    project_id: "p",
    project_name: "proj",
    mode: "with_coordinator",
    duration_ms: 1,
    coordinator_metrics: {
      agents_count: agents.length, duration_total_ms: 1, threads_opened: 0,
      threads_resolved_consensus: 0, threads_auto_resolved: 0, threads_without_consensus: 0,
      messages_exchanged: 0, conflicts_by_layer: {}, introspections_triggered: 0,
      introspections_concerned: 0, avg_resolution_time_ms: 0, hot_files: [],
    },
    agent_results: agents,
    custom_metrics: {},
  };
}

async function runAction(): Promise<void> {
  await createRunCommand().parseAsync(["raid", "-p", "."], { from: "user" });
}

describe("essaim run — wiring de runExitCode dans l'action commander", () => {
  beforeEach(() => {
    vi.mocked(executeRun).mockReset();
  });

  it("sort en 1 quand TOUS les agents ont échoué", async () => {
    vi.mocked(executeRun).mockResolvedValue(runResult([agent("a1", 1), agent("a2", 1)]));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await runAction();

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("sort en 0 sur une défaillance PARTIELLE — pas un exit(0) figé qui masquerait aussi le cas ci-dessus", async () => {
    vi.mocked(executeRun).mockResolvedValue(
      runResult([agent("a1", 1), agent("a2", 0), agent("a3", 1), agent("a4", 0)]),
    );
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await runAction();

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
