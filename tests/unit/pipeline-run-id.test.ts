// tests/unit/pipeline-run-id.test.ts
//
// ensureRunId (src/run-id.ts) is idempotent and publishes the id to
// process.env.ESSAIM_RUN_ID, which lives for the whole process. `essaim
// pipeline` runs every step in that SAME process (cli/pipeline.ts), so two
// steps of the same template against the same repo used to mint (via
// runProject → ensureRunId) the exact same run id — and workspace.ts's
// agentBranchName() builds `mini-project-<runId>-<agentId>` from it. Same
// runId + same (deterministic, src/bridge.ts) agentId across steps means the
// same branch name: exactly the collision the recent workspace.ts fix
// eliminated for separate `essaim run` invocations, reopened by the pipeline
// running steps in-process.
//
// This exercises the real action closure (executeRun mocked out, like
// run-cli.test.ts does for `essaim run`) and asserts on the run id each step
// would see — not on git/worktree state, which is out of scope here and
// already covered by src/orchestrator/workspace.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../cli/run-core.js", () => ({
  executeRun: vi.fn(),
}));

const { executeRun } = await import("../../cli/run-core.js");
const { ensureRunId, currentRunId } = await import("../../src/run-id.js");
const { createPipelineCommand } = await import("../../cli/pipeline.js");

let dir: string;
let pipelinePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipeline-runid-"));
  pipelinePath = join(dir, "pipeline.yaml");
  // Same template + same project on both steps: exactly the narrow case the
  // finding names — deterministic agent ids collide unless the run id differs.
  writeFileSync(
    pipelinePath,
    "name: p\nsteps:\n  - name: step1\n    template: raid\n    project: .\n  - name: step2\n    template: raid\n    project: .\n",
  );
  vi.mocked(executeRun).mockReset();
  delete process.env.ESSAIM_RUN_ID;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ESSAIM_RUN_ID;
});

async function runPipeline(): Promise<void> {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await createPipelineCommand().parseAsync(["-f", pipelinePath], { from: "user" });
  } finally {
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  }
}

describe("essaim pipeline — un run id par étape, pas un seul pour tout le process", () => {
  it("deux étapes du même template mintent deux run ids DIFFÉRENTS quand aucun n'est fourni de l'extérieur", async () => {
    const seenRunIds: string[] = [];
    vi.mocked(executeRun).mockImplementation(async (opts) => {
      // Simule ce que runProject fait réellement en interne (orchestrator.ts:180).
      seenRunIds.push(ensureRunId(opts.template));
      return undefined;
    });

    await runPipeline();

    expect(seenRunIds).toHaveLength(2);
    expect(seenRunIds[0]).not.toBe(seenRunIds[1]);
  });

  it("un ESSAIM_RUN_ID fourni de l'extérieur (runner/CI/essaim parent) prime sur TOUTES les étapes", async () => {
    process.env.ESSAIM_RUN_ID = "external-run-id";
    const seenRunIds: string[] = [];
    vi.mocked(executeRun).mockImplementation(async (opts) => {
      seenRunIds.push(ensureRunId(opts.template));
      return undefined;
    });

    await runPipeline();

    expect(seenRunIds).toEqual(["external-run-id", "external-run-id"]);
    expect(currentRunId()).toBe("external-run-id");
  });
});
