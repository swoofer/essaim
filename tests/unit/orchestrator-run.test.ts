// tests/unit/orchestrator-run.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import type { AgentConfig, MiniProject } from "../../src/orchestrator/types.js";
import type { AgentLoopResult } from "../../src/agent-loop/agent-loop.js";

// ── Module mocks ──────────────────────────────────────────────────────────
// Everything the orchestrator talks to over the network or as a subprocess is
// mocked; workspace.ts/reporter.ts are left real since workspace.type "none"
// makes them side-effect-free (no worktrees, no git diff/tsc).

vi.mock("mcp-coordinator", () => ({
  startServer: vi.fn(),
}));

vi.mock("../../src/orchestrator/agent-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orchestrator/agent-launcher.js")>();
  return {
    ...actual,
    launchAgent: vi.fn(() => {
      throw new Error("legacy launchAgent should not be called by these agent-loop tests");
    }),
    launchAgentLoop: vi.fn(),
  };
});

vi.mock("../../src/orchestrator/metrics.js", () => ({
  fetchCoordinatorMetrics: vi.fn(async () => ({
    agents_count: 0,
    duration_total_ms: 0,
    threads_opened: 0,
    threads_resolved_consensus: 0,
    threads_auto_resolved: 0,
    messages_exchanged: 0,
    conflicts_by_layer: {},
    introspections_triggered: 0,
    introspections_concerned: 0,
    avg_resolution_time_ms: 0,
    hot_files: [],
  })),
  fetchLatestEventId: vi.fn(async () => 0),
}));

vi.mock("../../src/orchestrator/preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/orchestrator/preflight.js")>();
  return {
    ...actual,
    preflightQuotaCheck: vi.fn(async () => ({ canProceed: true })),
  };
});

const { startServer } = await import("mcp-coordinator");
const { launchAgentLoop } = await import("../../src/orchestrator/agent-launcher.js");
const { runProject } = await import("../../src/orchestrator/orchestrator.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeAgent(partial: Partial<AgentConfig> & Pick<AgentConfig, "id" | "name">): AgentConfig {
  return {
    prompt: "do the thing",
    profile: "codeur",
    hooks: {},
    envVars: {},
    mcpTools: ["announce_work"],
    ...partial,
  };
}

function makeProject(partial: Partial<MiniProject> & Pick<MiniProject, "agents">): MiniProject {
  return {
    id: "test-project",
    name: "Test Project",
    description: "orchestrator-run test fixture",
    phase: 1,
    workspace: { type: "none" },
    stagger: { mode: "fixed", delay: [0, 0] },
    metrics: [],
    ...partial,
  };
}

function makeLoopResult(agentId: string, exitReason: AgentLoopResult["exitReason"] = "done"): AgentLoopResult {
  return {
    agentId,
    exitReason,
    summary: "ok",
    totalCostUsd: 0,
    turnsCount: 1,
    mqttMessagesProcessed: 0,
    durationMs: 1,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    costByPhase: {},
    costByModel: {},
    turnDetails: [],
  };
}

/** Dispatches the bare `fetch` calls postJson makes (register/run-config/reset). */
function makeFetchMock(registerOk: Record<string, boolean>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    if (pathname === "/api/register") {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const ok = registerOk[body.agent_id] !== false;
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 500 });
    }
    if (pathname === "/api/run-config" || pathname === "/api/reset") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("", { status: 404 });
  });
}

let TMP_DIR: string;
let ORIGINAL_CWD: string;

beforeEach(() => {
  ORIGINAL_CWD = process.cwd();
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "essaim-orch-run-"));
  process.chdir(TMP_DIR); // keep the `runs/` dir this creates out of the repo
  // createWorkspaces() (real, unmocked) does a `git rev-parse HEAD` for the
  // diff baseline even for workspace.type "none" — give it a real (if empty)
  // repo so that's a normal no-op instead of noisy "not a git repository"
  // stderr from every test run.
  execSync("git init -q && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: TMP_DIR });
  fs.writeFileSync(path.join(TMP_DIR, ".gitkeep"), "");
  execSync("git add . && git commit -q -m init", { cwd: TMP_DIR });
  delete process.env.ESSAIM_RUN_ID;
  vi.mocked(launchAgentLoop).mockReset();
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  vi.unstubAllGlobals();
  delete process.env.ESSAIM_RUN_ID;
});

// ── #107 — skip agents that failed pre-registration ────────────────────────

describe("runProject — pre-registration failures (#107)", () => {
  it("launches only the agents that registered; skips the one that failed", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ a1: true, a2: false }));
    vi.mocked(launchAgentLoop).mockImplementation(async (agent) => makeLoopResult(agent.id));

    const project = makeProject({
      agents: [
        makeAgent({ id: "a1", name: "Agent A" }),
        makeAgent({ id: "a2", name: "Agent B" }),
      ],
      workspace: { type: "none", base: TMP_DIR },
    });

    const result = await runProject(project, "with_coordinator", false, {
      coordinatorUrl: "http://coordinator.test",
    });

    const launchedIds = vi.mocked(launchAgentLoop).mock.calls.map((call) => (call[0] as AgentConfig).id);
    expect(launchedIds).toEqual(["a1"]);

    // The skipped agent still gets a result row (workspace was created for
    // both), just marked as not run rather than misattributed another
    // agent's outcome.
    expect(result.agent_results).toHaveLength(2);
    const skipped = result.agent_results.find((r) => r.agent_id === "a2")!;
    expect(skipped.exit_code).toBe(1);
  });

  it("launches every agent when registration fully succeeds (no regression)", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ a1: true, a2: true }));
    vi.mocked(launchAgentLoop).mockImplementation(async (agent) => makeLoopResult(agent.id));

    const project = makeProject({
      agents: [
        makeAgent({ id: "a1", name: "Agent A" }),
        makeAgent({ id: "a2", name: "Agent B" }),
      ],
      workspace: { type: "none", base: TMP_DIR },
    });

    await runProject(project, "with_coordinator", false, { coordinatorUrl: "http://coordinator.test" });

    const launchedIds = vi.mocked(launchAgentLoop).mock.calls.map((call) => (call[0] as AgentConfig).id);
    expect(launchedIds.sort()).toEqual(["a1", "a2"]);
  });
});

// ── #112 — drain original agent-loop promises before coordinator teardown ──

describe("runProject — timeout teardown ordering (#112)", () => {
  it("awaits the original agent-loop promise (within the grace window) before stopping the coordinator", async () => {
    const order: string[] = [];
    const stop = vi.fn(async () => {
      order.push("coordinator-stopped");
    });
    vi.mocked(startServer).mockResolvedValue({ port: 5555, stop } as never);

    vi.mocked(launchAgentLoop).mockImplementation(async (agent, _ws, _url, _mcp, _prompt, opts) => {
      return new Promise<AgentLoopResult>((resolve) => {
        // Never resolves on its own — only once the orchestrator's timeout
        // aborts it, simulating a claude child that takes a moment to drain
        // (SIGKILL propagation + a final coordinator POST) after the signal.
        opts?.abortSignal?.addEventListener("abort", () => {
          setTimeout(() => {
            order.push("agent-drained");
            resolve(makeLoopResult(agent.id, "aborted"));
          }, 30);
        });
      });
    });

    vi.stubGlobal("fetch", makeFetchMock({ a1: true }));

    const project = makeProject({
      agents: [makeAgent({ id: "a1", name: "Agent A" })],
      workspace: { type: "none", base: TMP_DIR },
      timeout_minutes: 0.0005, // ~30ms — fires well before the agent-loop would ever resolve on its own
    });

    await runProject(project, "with_coordinator", false, {});

    expect(order).toEqual(["agent-drained", "coordinator-stopped"]);
  });
});
