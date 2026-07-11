import { describe, it, expect } from "vitest";
import { runPipelineDef } from "../../src/pipeline/runner.js";
import type { PipelineDef, PipelineStep } from "../../src/pipeline/schema.js";
import type { PipelineDeps } from "../../src/pipeline/runner.js";

function step(name: string, extra: Partial<PipelineStep> = {}): PipelineStep {
  return { name, template: "t", project: ".", ...extra };
}

function makeDeps(over: Partial<PipelineDeps> = {}): PipelineDeps & { calls: string[] } {
  const calls: string[] = [];
  const deps: PipelineDeps & { calls: string[] } = {
    calls,
    runStep: async (s) => {
      calls.push(`run:${s.name}`);
    },
    execHook: (cmd) => {
      calls.push(`hook:${cmd}`);
      return { code: 0, output: "" };
    },
    log: () => {},
    now: (() => {
      let t = 0;
      return () => (t += 1000);
    })(),
    ...over,
  };
  return deps;
}

describe("runPipelineDef", () => {
  it("runs steps in order and reports ok", async () => {
    const def: PipelineDef = { name: "p", steps: [step("a"), step("b")] };
    const deps = makeDeps();
    const res = await runPipelineDef(def, {}, deps);
    expect(res.ok).toBe(true);
    expect(deps.calls).toEqual(["run:a", "run:b"]);
    expect(res.outcomes.map((o) => o.status)).toEqual(["ok", "ok"]);
    expect(res.outcomes[0]!.durationMs).toBeGreaterThan(0);
  });

  it("runs before-hooks before runStep and after-hooks after", async () => {
    const def: PipelineDef = {
      name: "p",
      steps: [step("a", { hooks: { before: ["pre"], after: ["post"] } })],
    };
    const deps = makeDeps();
    const res = await runPipelineDef(def, {}, deps);
    expect(deps.calls).toEqual(["hook:pre", "run:a", "hook:post"]);
    expect(res.ok).toBe(true);
  });

  it("before-hook failure prevents runStep and fails the step", async () => {
    const def: PipelineDef = {
      name: "p",
      steps: [step("a", { hooks: { before: ["bad"] } }), step("b")],
    };
    const deps = makeDeps({
      execHook: (cmd) => {
        deps.calls.push(`hook:${cmd}`);
        return cmd === "bad" ? { code: 3, output: "boom" } : { code: 0, output: "" };
      },
    });
    const res = await runPipelineDef(def, {}, deps);
    expect(deps.calls).toEqual(["hook:bad"]); // runStep NOT called
    expect(res.ok).toBe(false);
    expect(res.outcomes[0]!.status).toBe("failed");
    expect(res.outcomes[0]!.hookFailures).toContain("bad");
    expect(res.outcomes[1]!.status).toBe("skipped");
  });

  it("after-hook failure fails the step", async () => {
    const def: PipelineDef = {
      name: "p",
      steps: [step("a", { hooks: { after: ["boom"] } })],
    };
    const deps = makeDeps({
      execHook: (cmd) => {
        deps.calls.push(`hook:${cmd}`);
        return { code: 1, output: "nope" };
      },
    });
    const res = await runPipelineDef(def, {}, deps);
    expect(deps.calls).toEqual(["run:a", "hook:boom"]);
    expect(res.outcomes[0]!.status).toBe("failed");
    expect(res.outcomes[0]!.hookFailures).toContain("boom");
    expect(res.ok).toBe(false);
  });

  it("stops on first failing runStep and marks the rest skipped", async () => {
    const def: PipelineDef = {
      name: "p",
      steps: [step("a"), step("b"), step("c")],
    };
    const deps = makeDeps({
      runStep: async (s) => {
        deps.calls.push(`run:${s.name}`);
        if (s.name === "b") throw new Error("step b exploded");
      },
    });
    const res = await runPipelineDef(def, {}, deps);
    expect(deps.calls).toEqual(["run:a", "run:b"]); // c never runs
    expect(res.outcomes.map((o) => o.status)).toEqual(["ok", "failed", "skipped"]);
    expect(res.outcomes[1]!.error).toContain("step b exploded");
    expect(res.ok).toBe(false);
  });

  it("passes shared context to runStep", async () => {
    const seen: unknown[] = [];
    const def: PipelineDef = { name: "p", steps: [step("a")] };
    const deps = makeDeps({
      runStep: async (_s, shared) => {
        seen.push(shared);
      },
    });
    await runPipelineDef(def, { coordinatorUrl: "http://x", dryRun: true }, deps);
    expect(seen[0]).toEqual({ coordinatorUrl: "http://x", dryRun: true });
  });

  it("runs after-hooks with cwd = step project", async () => {
    const cwds: string[] = [];
    const def: PipelineDef = {
      name: "p",
      steps: [step("a", { project: "../code", hooks: { after: ["build"] } })],
    };
    const deps = makeDeps({
      execHook: (cmd, cwd) => {
        cwds.push(cwd);
        return { code: 0, output: "" };
      },
    });
    await runPipelineDef(def, {}, deps);
    expect(cwds).toEqual(["../code"]);
  });
});
