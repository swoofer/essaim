import type { PipelineDef, PipelineStep } from "./schema.js";

export interface PipelineShared {
  coordinatorUrl?: string;
  maxQuotaPct?: number;
  dryRun?: boolean;
}

export interface PipelineDeps {
  /** Execute a single step. Throws on failure. */
  runStep: (step: PipelineStep, shared: PipelineShared) => Promise<void>;
  /** Run a shell hook command. Returns exit code + captured output. */
  execHook: (cmd: string, cwd: string) => { code: number; output: string };
  log: (msg: string) => void;
  now?: () => number;
}

export interface StepOutcome {
  name: string;
  status: "ok" | "failed" | "skipped";
  durationMs: number;
  hookFailures: string[];
  error?: string;
}

export interface PipelineResult {
  outcomes: StepOutcome[];
  ok: boolean;
}

/**
 * Run a pipeline definition strictly sequentially.
 * For each step: before-hooks (any non-zero exit → step failed, runStep skipped),
 * then runStep, then after-hooks (non-zero → step failed).
 * The first failed step stops the pipeline; remaining steps are recorded "skipped".
 * Error messages are never swallowed.
 */
export async function runPipelineDef(
  def: PipelineDef,
  shared: PipelineShared,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const now = deps.now ?? Date.now;
  const outcomes: StepOutcome[] = [];
  let stopped = false;

  for (const step of def.steps) {
    if (stopped) {
      outcomes.push({ name: step.name, status: "skipped", durationMs: 0, hookFailures: [] });
      continue;
    }

    const start = now();
    const hookFailures: string[] = [];
    let error: string | undefined;

    deps.log(`▶ step '${step.name}' (${step.template} on ${step.project})`);

    // before-hooks
    for (const cmd of step.hooks?.before ?? []) {
      const r = deps.execHook(cmd, step.project);
      if (r.code !== 0) {
        hookFailures.push(cmd);
        error = `before-hook failed (exit ${r.code}): ${cmd}${r.output ? `\n${r.output}` : ""}`;
        break;
      }
    }

    // runStep — only if before-hooks all passed
    if (hookFailures.length === 0) {
      try {
        await deps.runStep(step, shared);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }

    // after-hooks — only if runStep succeeded
    if (!error) {
      for (const cmd of step.hooks?.after ?? []) {
        const r = deps.execHook(cmd, step.project);
        if (r.code !== 0) {
          hookFailures.push(cmd);
          error = `after-hook failed (exit ${r.code}): ${cmd}${r.output ? `\n${r.output}` : ""}`;
          break;
        }
      }
    }

    const durationMs = now() - start;
    if (error) {
      outcomes.push({ name: step.name, status: "failed", durationMs, hookFailures, error });
      deps.log(`✗ step '${step.name}' failed: ${error}`);
      stopped = true;
    } else {
      outcomes.push({ name: step.name, status: "ok", durationMs, hookFailures });
      deps.log(`✓ step '${step.name}' ok (${durationMs}ms)`);
    }
  }

  return { outcomes, ok: outcomes.every((o) => o.status === "ok") };
}
