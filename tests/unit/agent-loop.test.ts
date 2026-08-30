import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLoopConfig, AgentLoopResult, AgentLoopLogger } from "../../src/agent-loop/agent-loop.js";

// ── Mocks ──────────────────────────────────────────────────────────────

// Mock claude-stream
const mockSend = vi.fn();
const mockClose = vi.fn();
const mockIsAlive = vi.fn(() => true);
let mockSessionId: string | null = "test-session";

vi.mock("../../src/agent-loop/claude-stream.js", () => ({
  createClaudeStream: vi.fn(() => ({
    send: mockSend,
    close: mockClose,
    isAlive: mockIsAlive,
    get sessionId() { return mockSessionId; },
  })),
  BudgetExceededError: class BudgetExceededError extends Error {
    constructor(msg?: string) { super(msg ?? "Budget exceeded"); this.name = "BudgetExceededError"; }
  },
  // Le catch de runAgentLoop teste `err instanceof AbortError` avant de
  // retomber sur "error". Sans cet export, tout test qui fait échouer un tour
  // meurt sur « No "AbortError" export is defined » au lieu d'exercer le
  // chemin d'erreur — c'est pourquoi aucun ne l'exerçait.
  AbortError: class AbortError extends Error {
    constructor(msg?: string) { super(msg ?? "Aborted"); this.name = "AbortError"; }
  },
}));

// Mock mqtt-listener
const mockMqttConnect = vi.fn(async () => {});
const mockMqttDrain = vi.fn((): unknown[] => []);
const mockMqttClose = vi.fn(async () => {});
const mockMqttPeek = vi.fn(() => 0);

vi.mock("../../src/agent-loop/mqtt-listener.js", () => ({
  createMqttListener: vi.fn(() => ({
    connect: mockMqttConnect,
    drain: mockMqttDrain,
    peek: mockMqttPeek,
    close: mockMqttClose,
    connected: true,
  })),
}));

// Mock coordination-protocol
const mockStartWork = vi.fn();
const mockNextAction = vi.fn(() => null);
const mockOnAnnounceResult = vi.fn();
const mockDecideContinue = vi.fn();
const mockDecideYield = vi.fn();
const mockDecideAdjust = vi.fn();
const mockWorkDone = vi.fn();
const mockOnTimeout = vi.fn();
const mockOnThreadMessage = vi.fn();
const mockOnResolutionProposed = vi.fn();
let mockPhase = "idle";
let mockCurrentThreadId: string | null = null;

vi.mock("../../src/agent-loop/coordination-protocol.js", () => ({
  createCoordinationProtocol: vi.fn(() => ({
    startWork: mockStartWork,
    nextAction: mockNextAction,
    onAnnounceResult: mockOnAnnounceResult,
    onThreadMessage: mockOnThreadMessage,
    onResolutionProposed: mockOnResolutionProposed,
    onApproval: vi.fn(),
    onContestation: vi.fn(),
    onTimeout: mockOnTimeout,
    decideContinue: mockDecideContinue,
    decideYield: mockDecideYield,
    decideAdjust: mockDecideAdjust,
    workDone: mockWorkDone,
    getThreadState: vi.fn(() => null),
    get phase() { return mockPhase; },
    get currentThreadId() { return mockCurrentThreadId; },
  })),
}));

// Mock work-stealing
const mockParseDiscoveries = vi.fn((_output: string) => [] as Array<{ id: string; description: string; file?: string; line?: number; severity?: string }>);
const mockPostDiscoveries = vi.fn(async (_url: string, _agentId: string, _tasks: unknown[]) => [] as Array<{ id: string; description: string; file?: string; line?: number; severity?: string }>);
const mockClaimNextTask = vi.fn(async (_url: string, _agentId: string) => null as { id: string; description: string; file?: string; severity?: string } | null | "coordinator_unreachable");
const mockCompleteTask = vi.fn(async (_url: string, _threadId: string, _agentId: string, _summary: string) => {});
const mockUnclaimTask = vi.fn(async (_url: string, _threadId: string, _agentId: string) => {});
const mockParseReviewActions = vi.fn((_output: string) => [] as Array<{ type: string; description?: string; threadId?: string; context?: string }>);
const mockFetchExistingThreads = vi.fn(async (_url: string) => "(aucun thread actif)");
const mockProcessReviewActions = vi.fn(async (_url: string, _agentId: string, _agentName: string, _actions: unknown[]) => ({ posted: 0, enriched: 0, skipped: 0, newAttempted: 0 }));

vi.mock("../../src/agent-loop/work-stealing.js", () => ({
  COORDINATOR_UNREACHABLE: "coordinator_unreachable",
  parseDiscoveries: (output: string) => mockParseDiscoveries(output),
  postDiscoveries: (url: string, agentId: string, tasks: unknown[]) => mockPostDiscoveries(url, agentId, tasks),
  claimNextTask: (url: string, agentId: string) => mockClaimNextTask(url, agentId),
  completeTask: (url: string, threadId: string, agentId: string, summary: string) => mockCompleteTask(url, threadId, agentId, summary),
  unclaimTask: (url: string, threadId: string, agentId: string) => mockUnclaimTask(url, threadId, agentId),
  parseReviewActions: (output: string) => mockParseReviewActions(output),
  fetchExistingThreads: (url: string) => mockFetchExistingThreads(url),
  processReviewActions: (url: string, agentId: string, agentName: string, actions: unknown[]) => mockProcessReviewActions(url, agentId, agentName, actions),
}));

// Mock falsifiability — le garde-fou est testé contre un vrai dépôt git dans
// tests/unit/falsifiability.test.ts. Ici on vérifie uniquement que le loop
// l'appelle sur TOUS les chemins où l'agent dit DONE:, et qu'il lui obéit.
const mockVerifyFailingTest = vi.fn(async (..._args: unknown[]) => ({
  falsifiable: true,
  reason: "ok",
  testFiles: [] as string[],
  sourceFiles: [] as string[],
}));
// Le reste du module reste RÉEL (`importOriginal` + étalement). Deux raisons :
// agent-loop importe aussi `parseUntrackedFiles` — qu'un mock ne rendant que
// `verifyFailingTest` laissait `undefined`, sauvé par le seul court-circuit
// `st.code === 0 ? ... : []` — et les cas « ligne de base par THREAD » plus bas
// font tourner le VRAI garde-fou sur un VRAI dépôt git.
vi.mock("../../src/agent-loop/falsifiability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/agent-loop/falsifiability.js")>()),
  verifyFailingTest: (...args: unknown[]) => mockVerifyFailingTest(...args),
}));

// Mock fetch for coordinator REST
const mockFetch = vi.fn(async () => ({
  ok: true,
  json: async () => ({ briefing: "" }),
}));
vi.stubGlobal("fetch", mockFetch);

// Silent logger for tests
const silentLogger: AgentLoopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function makeConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    agentId: "test-agent",
    agentName: "Test Agent",
    modules: ["auth"],
    coordinatorUrl: "http://localhost:3100",
    mqttUrl: "ws://localhost:3100/mqtt",
    workspacePath: "/tmp/test",
    mcpConfigPath: "/tmp/.mcp.json",
    prompt: "Fix the auth bug",
    maxTurns: 5,
    dangerouslySkipPermissions: true,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("runAgentLoop", () => {
  let runAgentLoop: (config: AgentLoopConfig, logger?: AgentLoopLogger) => Promise<AgentLoopResult>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPhase = "idle";
    mockCurrentThreadId = null;
    mockSessionId = "test-session";
    mockIsAlive.mockReturnValue(true);
    mockMqttDrain.mockReturnValue([]);

    // Default: protocol auto-resolves (no respondents), then enters work phase
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockNextAction.mockImplementation((): any => {
      if (callCount === 0) {
        callCount++;
        mockPhase = "working";
        return { type: "work" };
      }
      return null;
    });

    // Import after mocks are set up
    const mod = await import("../../src/agent-loop/agent-loop.js");
    runAgentLoop = mod.runAgentLoop;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes when LLM says DONE on first turn", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: Fixed the auth bug by adding token validation",
      toolCalls: [],
      costUsd: 0.05,
      durationMs: 1000,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("done");
    expect(result.summary).toBe("Fixed the auth bug by adding token validation");
    expect(result.turnsCount).toBe(1);
    expect(result.totalCostUsd).toBe(0.05);
    expect(mockClose).toHaveBeenCalled();
    expect(mockMqttClose).toHaveBeenCalled();
  });

  it("reporte les compactions du tour dans turnDetails", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: patch posé",
      toolCalls: [],
      costUsd: 0.05,
      durationMs: 1000,
      sessionId: "s1",
      tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      compaction: { count: 1, preTokens: 150000, postTokens: 42000 },
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.turnDetails).toHaveLength(1);
    expect(result.turnDetails[0]).toMatchObject({
      compactions: 1,
      compactionPreTokens: 150000,
      compactionPostTokens: 42000,
    });
  });

  it("un envoi sans champ compaction ne fait pas tomber la boucle", async () => {
    // Les ~20 mockSend existants de ce fichier montent des réponses partielles
    // sans `tokens` ni `compaction` : la lecture doit rester défensive.
    mockSend.mockResolvedValue({
      content: "DONE: ok",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("done");
    expect(result.turnDetails[0].compactions).toBe(0);
  });

  it("étiquette les tours du mode one-shot phase=main, pas coordination", async () => {
    // Sans phases, la ventilation par phase du rapport de run rangeait 100 % des
    // tours sous "coordination" — l'instrument mentait sur un run entier.
    mockSend.mockResolvedValue({
      content: "DONE: ok",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.turnDetails[0].phase).toBe("main");
  });

  it("iterates multiple turns until DONE", async () => {
    let turnNum = 0;
    mockSend.mockImplementation(async () => {
      turnNum++;
      return {
        content: turnNum >= 3 ? "DONE: All fixed" : "I'll read the file next.",
        toolCalls: [],
        costUsd: 0.01,
        durationMs: 500,
        sessionId: "s1",
      };
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("done");
    expect(result.turnsCount).toBe(3);
    expect(result.totalCostUsd).toBeCloseTo(0.03);
  });

  it("stops at max turns limit", async () => {
    mockSend.mockResolvedValue({
      content: "Still working...",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makeConfig({ maxTurns: 3 }), silentLogger);

    expect(result.exitReason).toBe("max_turns");
    expect(result.turnsCount).toBe(3);
  });

  it("handles process death gracefully", async () => {
    let turnNum = 0;
    mockSend.mockImplementation(async () => {
      turnNum++;
      if (turnNum === 2) mockIsAlive.mockReturnValue(false);
      return {
        content: "Working...",
        toolCalls: [],
        costUsd: 0.01,
        durationMs: 200,
        sessionId: "s1",
      };
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("process_died");
  });

  it("handles budget exceeded error", async () => {
    const { BudgetExceededError } = await import("../../src/agent-loop/claude-stream.js");
    mockSend.mockRejectedValue(new BudgetExceededError());

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("budget_exceeded");
  });

  it("processes MQTT interrupts between turns", async () => {
    let turnNum = 0;
    mockSend.mockImplementation(async () => {
      turnNum++;
      return {
        content: turnNum >= 3 ? "DONE: Fixed" : "OK, noted.",
        toolCalls: [],
        costUsd: 0.01,
        durationMs: 200,
        sessionId: "s1",
      };
    });

    // Return MQTT messages on the second drain
    let drainCall = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockMqttDrain.mockImplementation((): any[] => {
      drainCall++;
      if (drainCall === 2) {
        return [{
          type: "consultation_new" as const,
          threadId: "t1",
          subject: "Agent B touching auth",
          agentId: "agent-b",
          timestamp: Date.now(),
          raw: {},
        }];
      }
      return [];
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("done");
    expect(result.mqttMessagesProcessed).toBe(1);
  });

  it("connects MQTT and closes on cleanup", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: quick",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    await runAgentLoop(makeConfig(), silentLogger);

    expect(mockMqttConnect).toHaveBeenCalled();
    expect(mockMqttClose).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it("continues if MQTT connection fails", async () => {
    mockMqttConnect.mockRejectedValue(new Error("Connection refused"));
    mockSend.mockResolvedValue({
      content: "DONE: worked without MQTT",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("done");
  });

  it("calls protocol.startWork with a meaningful subject (not the raw prompt)", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: quick",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    const longPrompt = "## Contexte du projet\n- Langage: typescript\n- Modules: auth,shared\n## Règles...";
    await runAgentLoop(makeConfig({ prompt: longPrompt }), silentLogger);

    const callArg = mockStartWork.mock.calls[0][0];
    expect(callArg.targetModules).toEqual(["auth"]);
    // Subject must be human-readable — derived from agent name + modules, not the prompt body.
    expect(callArg.subject).toContain("Test Agent");
    expect(callArg.subject).toContain("auth");
    expect(callArg.subject).not.toContain("## Contexte");
    expect(callArg.subject.length).toBeLessThanOrEqual(200);
  });

  it("returns result with all metrics", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: Fixed",
      toolCalls: [],
      costUsd: 0.02,
      durationMs: 500,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result).toMatchObject({
      agentId: "test-agent",
      exitReason: "done",
      turnsCount: 1,
      totalCostUsd: 0.02,
      mqttMessagesProcessed: 0,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("creates interruptClaude with haiku model (low effort)", async () => {
    const { createClaudeStream } = await import("../../src/agent-loop/claude-stream.js");
    mockSend.mockResolvedValue({
      content: "DONE: quick",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    await runAgentLoop(makeConfig(), silentLogger);

    // Two createClaudeStream calls: main claude + interruptClaude
    const calls = (createClaudeStream as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // The second call is interruptClaude — should use haiku
    const interruptOpts = calls[1][0] as { model?: string };
    expect(interruptOpts.model).toBe("claude-haiku-4-5-20251001");
  });

  // ── Coordination decision: ADJUST ────────────────────────────────────

  it("routes an ADJUST reply to protocol.decideAdjust with the parsed plan", async () => {
    let nextActionCall = 0;
    mockNextAction.mockImplementation((): any => {
      nextActionCall++;
      if (nextActionCall === 1) {
        return { type: "ask_llm_decide", threadId: "t-1", responses: "[agent-2]: I'm on file X too" };
      }
      mockPhase = "working";
      return { type: "work" };
    });

    let sendCall = 0;
    mockSend.mockImplementation(async () => {
      sendCall++;
      if (sendCall === 1) {
        return {
          content: "ADJUST: je vais éviter le fichier X et me concentrer sur Y à la place",
          toolCalls: [],
          costUsd: 0.01,
          durationMs: 100,
          sessionId: "s1",
        };
      }
      return {
        content: "DONE: finished",
        toolCalls: [],
        costUsd: 0.01,
        durationMs: 100,
        sessionId: "s1",
      };
    });

    await runAgentLoop(makeConfig(), silentLogger);

    expect(mockDecideAdjust).toHaveBeenCalledWith("je vais éviter le fichier X et me concentrer sur Y à la place");
    expect(mockDecideContinue).not.toHaveBeenCalled();
    expect(mockDecideYield).not.toHaveBeenCalled();
  });

  it("falls back to CONTINUE and logs a warning when ADJUST has no plan attached", async () => {
    let nextActionCall = 0;
    mockNextAction.mockImplementation((): any => {
      nextActionCall++;
      if (nextActionCall === 1) {
        return { type: "ask_llm_decide", threadId: "t-2", responses: "[agent-2]: hello" };
      }
      mockPhase = "working";
      return { type: "work" };
    });

    let sendCall = 0;
    mockSend.mockImplementation(async () => {
      sendCall++;
      if (sendCall === 1) {
        return {
          content: "ADJUST",
          toolCalls: [],
          costUsd: 0.01,
          durationMs: 100,
          sessionId: "s1",
        };
      }
      return {
        content: "DONE: finished",
        toolCalls: [],
        costUsd: 0.01,
        durationMs: 100,
        sessionId: "s1",
      };
    });

    const warnSpy = vi.fn();
    const loggerWithSpy: AgentLoopLogger = { ...silentLogger, warn: warnSpy };

    await runAgentLoop(makeConfig(), loggerWithSpy);

    expect(mockDecideAdjust).not.toHaveBeenCalled();
    expect(mockDecideContinue).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ADJUST"),
      expect.anything(),
    );
  });
});

// ── Phased mode tests ──────────────────────────────────────────────────

describe("runAgentLoop — phased mode", () => {
  let runAgentLoop: (config: AgentLoopConfig, logger?: AgentLoopLogger) => Promise<AgentLoopResult>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockPhase = "idle";
    mockCurrentThreadId = null;
    mockSessionId = "test-session";
    mockIsAlive.mockReturnValue(true);
    mockMqttDrain.mockReturnValue([]);

    // Default: protocol auto-resolves, enters work phase immediately
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockNextAction.mockImplementation((): any => {
      if (callCount === 0) {
        callCount++;
        mockPhase = "working";
        return { type: "work" };
      }
      return null;
    });

    // Reset work-stealing mocks to defaults — mockReset clears both history
    // AND any queued mockResolvedValueOnce/mockImplementation from prior tests.
    mockSend.mockReset();
    mockParseDiscoveries.mockReset();
    mockParseDiscoveries.mockReturnValue([]);
    mockPostDiscoveries.mockReset();
    mockPostDiscoveries.mockResolvedValue([]);
    mockClaimNextTask.mockReset();
    mockClaimNextTask.mockResolvedValue(null);
    mockCompleteTask.mockReset();
    mockCompleteTask.mockResolvedValue(undefined);
    mockUnclaimTask.mockReset();
    mockUnclaimTask.mockResolvedValue(undefined);
    mockParseReviewActions.mockReset();
    mockParseReviewActions.mockReturnValue([]);
    mockFetchExistingThreads.mockReset();
    mockFetchExistingThreads.mockResolvedValue("(aucun thread actif)");
    mockProcessReviewActions.mockReset();
    mockProcessReviewActions.mockResolvedValue({ posted: 0, enriched: 0, skipped: 0, newAttempted: 0 });

    const mod = await import("../../src/agent-loop/agent-loop.js");
    runAgentLoop = mod.runAgentLoop;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makePhasedConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
    return makeConfig({
      phases: [
        {
          name: "discover",
          prompt: "Scan for bugs",
          toolsMode: "read_only",
          loop: false,
        },
        {
          name: "execute",
          prompt: "Fix this: {{params.current_task}}",
          toolsMode: "full",
          loop: true,
        },
      ],
      ...overrides,
    });
  }

  it("runs discovery phase then exits when no tasks to claim", async () => {
    vi.useFakeTimers();

    // Discovery phase: LLM returns findings
    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });

    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);
    mockPostDiscoveries.mockResolvedValue([
      { id: "t-1", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);

    // Work-stealing loop: no tasks to claim (they may have been claimed by others)
    mockClaimNextTask.mockResolvedValue(null);

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);

    // Advance past EMPTY_WAIT_MS retries (3 retries x 10s = 30s)
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const result = await loopPromise;

    // Should have parsed discoveries
    expect(mockParseDiscoveries).toHaveBeenCalledWith("DISCOVERY:\nsrc/a.ts | 10 | Bug A | major");
    // Should have posted to coordinator
    expect(mockPostDiscoveries).toHaveBeenCalledWith(
      "http://localhost:3100",
      "test-agent",
      [{ id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" }],
    );
    // Should have tried to claim
    expect(mockClaimNextTask).toHaveBeenCalled();
    // Exits done (all phases completed, pool drained after retries)
    expect(result.exitReason).toBe("done");
  });

  it("coordinator INJOIGNABLE en plein run → exitReason 'coordinator_unreachable', PAS 'done' (#151)", async () => {
    vi.useFakeTimers();

    // Phase discover OK : on poste une découverte, puis on entre en execute.
    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);
    mockPostDiscoveries.mockResolvedValue([
      { id: "t-1", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);

    // …puis le coordinator devient INJOIGNABLE : claim signale l'injoignabilité,
    // PAS une piscine vide. La boucle doit finir en erreur, pas en "done".
    mockClaimNextTask.mockResolvedValue("coordinator_unreachable");

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000); // dépasser les 3 retries × 10s
    }
    const result = await loopPromise;

    expect(result.exitReason).toBe("coordinator_unreachable");
    expect(result.exitReason).not.toBe("done"); // le faux vert est banni (#151)
  });

  it("coordinator FLAPPING (vide/injoignable alternés) → 'coordinator_unreachable' DÉTERMINISTE, jamais 'done' (#151)", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);
    mockPostDiscoveries.mockResolvedValue([
      { id: "t-1", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);

    // Le coordinator flappe : COMMENCE par une réponse « vide » (null) puis
    // alterne avec « injoignable ». Un seul compteur + flag => dès qu'une
    // injoignabilité survient dans la fenêtre, le verdict est ROUGE, quel que
    // soit l'ordre (avant : course non déterministe entre deux compteurs).
    let n = 0;
    mockClaimNextTask.mockImplementation(async () => (n++ % 2 === 0 ? null : "coordinator_unreachable"));

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const result = await loopPromise;

    expect(result.exitReason).toBe("coordinator_unreachable");
    expect(result.exitReason).not.toBe("done");
  });

  it("UN SEUL blip d'injoignabilité dans un drain propre → reste 'done' (pas de faux rouge, seuil ≥2, #151)", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);
    mockPostDiscoveries.mockResolvedValue([
      { id: "t-1", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);

    // Drain propre avec UN blip transitoire : vide, vide, injoignable(1×), vide…
    // 1 injoignabilité < seuil 2 -> le run est réellement drainé -> "done", pas
    // un faux rouge sur un simple hoquet du coordinator.
    const seq: Array<null | "coordinator_unreachable"> = [null, null, "coordinator_unreachable", null];
    let i = 0;
    mockClaimNextTask.mockImplementation(async () => (i < seq.length ? seq[i++] : null));

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);
    for (let k = 0; k < 7; k++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const result = await loopPromise;

    expect(result.exitReason).toBe("done");
  });

  it("découverte TROUVÉE mais AUCUN thread posté (write-path coordinator mort) → 'coordinator_unreachable', PAS 'done' (#184)", async () => {
    vi.useFakeTimers();

    // Le coordinator est LISIBLE (threads-active répondra vide) mais son ÉCRITURE
    // est morte : chaque POST /api/announce échoue, donc postDiscoveries enregistre
    // ZÉRO thread malgré 1 trouvaille. C'est le faux vert propre à #184 : la piscine
    // paraît « vide-mais-joignable » à la phase execute, qui sortait "done" — alors
    // que l'agent a TROUVÉ du travail et n'en a RIEN consigné.
    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);
    mockPostDiscoveries.mockResolvedValue([]); // 0 posté malgré 1 trouvé

    // Piscine vide-mais-joignable : claim rend null, PAS UNREACHABLE — le garde
    // #151 (unreachableStreak) est donc AVEUGLE ici, c'est bien #184 qui doit voir.
    mockClaimNextTask.mockResolvedValue(null);

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    const result = await loopPromise;

    expect(result.exitReason).toBe("coordinator_unreachable");
    expect(result.exitReason).not.toBe("done"); // faux vert banni (#184)
  });

  it("phase review : NOUVEAUX trouvés mais 0 posté (write-path mort) → 'coordinator_unreachable', PAS 'done' (#184)", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Find bugs", toolsMode: "read_only", loop: false },
        { name: "review", prompt: "Review:\n{{params.my_discoveries}}", toolsMode: "none", loop: false },
        { name: "execute", prompt: "Fix: {{params.current_task}}", toolsMode: "full", loop: true },
      ],
    });

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 42 | Bug A | critical",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 42, severity: "critical" },
    ]);
    mockSend.mockResolvedValueOnce({
      content: "REVIEW:\nNOUVEAU | Bug A",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "Bug A" }]);
    // La review a tenté de semer 1 nouveau thread et TOUT a échoué (write-path mort).
    mockProcessReviewActions.mockResolvedValue({ posted: 0, enriched: 0, skipped: 0, newAttempted: 1 });

    mockClaimNextTask.mockResolvedValue(null);

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    const result = await loopPromise;

    expect(result.exitReason).toBe("coordinator_unreachable");
    expect(result.exitReason).not.toBe("done"); // faux vert banni (#184)
  });

  it("semis raté MAIS l'agent réclame+complète du travail des pairs → coordinator prouvé writable → 'done', PAS faux rouge (#191)", async () => {
    vi.useFakeTimers();

    // L'agent trouve du travail mais TOUS ses POST announce échouent (blip
    // transitoire) → 0 semé → seedWriteFailed=true (#184). MAIS la piscine
    // contient du travail des pairs : le claim RÉUSSIT (claim-task UPDATE la
    // ligne = preuve que le coordinator accepte des écritures MAINTENANT), et
    // l'agent complète le fix. Le semis raté était donc transitoire, pas une
    // écriture morte : le run corrige réellement du code → "done", pas rouge.
    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);
    mockPostDiscoveries.mockResolvedValue([]); // semis raté (transitoire)

    // Piscine des pairs : un claim réussit, puis pool vide.
    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-peer", description: "Peer bug", file: "src/peer.ts", severity: "major" };
      return null;
    });
    // L'agent complète la tâche des pairs.
    mockSend.mockResolvedValueOnce({
      content: "DONE: fixed peer bug",
      toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1",
    });

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    const result = await loopPromise;

    // Le coordinator s'est prouvé writable (claim réussi) → le faux rouge est banni.
    expect(result.exitReason).toBe("done");
    expect(result.exitReason).not.toBe("coordinator_unreachable");
  });

  it("claims and executes tasks in work-stealing loop", async () => {
    vi.useFakeTimers();

    // Discovery phase
    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major\nsrc/b.ts | 20 | Bug B | minor",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });

    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts" },
      { id: "", description: "Bug B", file: "src/b.ts" },
    ]);
    mockPostDiscoveries.mockResolvedValue([
      { id: "t-1", description: "Bug A", file: "src/a.ts" },
      { id: "t-2", description: "Bug B", file: "src/b.ts" },
    ]);

    // Work-stealing: claim task 1, then task 2, then null
    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-1", description: "Bug A", file: "src/a.ts", severity: undefined };
      if (claimCall === 2) return { id: "t-2", description: "Bug B", file: "src/b.ts", severity: undefined };
      return null;
    });

    // Execute phases: LLM responds DONE for each task
    // mockSend already returned once for discovery, now returns for tasks
    mockSend
      .mockResolvedValueOnce({
        content: "DONE: fixed null check in a.ts",
        toolCalls: [],
        costUsd: 0.02,
        durationMs: 300,
        sessionId: "s1",
      })
      .mockResolvedValueOnce({
        content: "DONE: handled empty array in b.ts",
        toolCalls: [],
        costUsd: 0.02,
        durationMs: 300,
        sessionId: "s1",
      });

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);

    // Advance past EMPTY_WAIT_MS retries after both tasks complete
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const result = await loopPromise;

    // Should complete both tasks
    expect(mockCompleteTask).toHaveBeenCalledTimes(2);
    expect(mockCompleteTask).toHaveBeenCalledWith(
      "http://localhost:3100",
      "t-1",
      "test-agent",
      "fixed null check in a.ts",
    );
    expect(mockCompleteTask).toHaveBeenCalledWith(
      "http://localhost:3100",
      "t-2",
      "test-agent",
      "handled empty array in b.ts",
    );
    expect(result.exitReason).toBe("done");
  });

  it("grace period retries when pool is temporarily empty", async () => {
    vi.useFakeTimers();

    // Discovery phase: no discoveries
    mockSend.mockResolvedValueOnce({
      content: "No bugs found.",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    // Work-stealing: empty on first call, task appears on second (another agent posted discoveries)
    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return null;  // pool empty first time
      if (claimCall === 2) return { id: "t-late", description: "Late discovery", file: undefined, severity: undefined };
      return null;  // then empty again
    });

    // LLM response for the late task
    mockSend.mockResolvedValueOnce({
      content: "DONE: fixed late issue",
      toolCalls: [],
      costUsd: 0.02,
      durationMs: 300,
      sessionId: "s1",
    });

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);

    // Advance past the EMPTY_WAIT_MS (10s) timers — the loop will hit 3 retries
    // after the late task is done, then drain with retries
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const result = await loopPromise;

    // Should have claimed the late task
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).toHaveBeenCalledWith(
      "http://localhost:3100",
      "t-late",
      "test-agent",
      "fixed late issue",
    );
    expect(result.exitReason).toBe("done");
  });

  it("falls back to one-shot when no phases configured", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: Fixed the auth bug in one shot",
      toolCalls: [],
      costUsd: 0.05,
      durationMs: 1000,
      sessionId: "s1",
    });

    // Config WITHOUT phases field — should work like classic one-shot
    const result = await runAgentLoop(makeConfig(), silentLogger);

    expect(result.exitReason).toBe("done");
    expect(result.summary).toBe("Fixed the auth bug in one shot");
    expect(result.turnsCount).toBe(1);
    // Work-stealing functions should NOT be called
    expect(mockClaimNextTask).not.toHaveBeenCalled();
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockParseDiscoveries).not.toHaveBeenCalled();

    // One-shot mode calls send(config.prompt) with NO opts at the call site —
    // disallowedForMode() is never consulted on this path. AskUserQuestion
    // must still be blocked, which only holds if the guard lives in the
    // shared `send` wrapper rather than in per-phase option construction.
    expect(mockSend.mock.calls[0][1]?.disallowedTools).toContain("AskUserQuestion");
  });

  it("substitutes task description into execute prompt", async () => {
    vi.useFakeTimers();

    // Discovery
    mockSend.mockResolvedValueOnce({
      content: "No bugs found.",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    // One task to claim
    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-1", description: "Null pointer in auth.ts:42", file: undefined, severity: undefined };
      return null;
    });

    // Capture what prompt is sent for the task execution
    mockSend.mockResolvedValueOnce({
      content: "DONE: patched",
      toolCalls: [],
      costUsd: 0.02,
      durationMs: 300,
      sessionId: "s1",
    });

    const loopPromise = runAgentLoop(makePhasedConfig(), silentLogger);

    // Advance past EMPTY_WAIT_MS retries after the single task completes
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const result = await loopPromise;

    // The execute prompt is "Fix this: {{params.current_task}}" — should be substituted
    // mockSend call 0 = discovery prompt, call 1 = execute with task description
    expect(mockSend).toHaveBeenCalledTimes(2);
    const executePrompt = mockSend.mock.calls[1][0] as string;
    expect(executePrompt).toBe("Fix this: Null pointer in auth.ts:42");
    expect(result.exitReason).toBe("done");
  });

  it("runs review phase between discovery and execute", async () => {
    vi.useFakeTimers();

    // Config with 3 phases: discover, review, execute
    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Find bugs", toolsMode: "read_only", loop: false },
        { name: "review", prompt: "Review:\nMy discoveries:\n{{params.my_discoveries}}\nExisting threads:\n{{params.existing_threads}}", toolsMode: "none", loop: false },
        { name: "execute", prompt: "Fix: {{params.current_task}}", toolsMode: "full", loop: true },
      ],
    });

    // Discovery returns DISCOVERY: content
    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/auth.ts | 42 | Missing null check | critical",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });

    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Missing null check", file: "src/auth.ts", line: 42, severity: "critical" },
    ]);

    // fetchExistingThreads returns some threads
    mockFetchExistingThreads.mockResolvedValue("- [t-existing] Old bug in auth.ts");

    // Review returns REVIEW: NOUVEAU | Bug A
    mockSend.mockResolvedValueOnce({
      content: "REVIEW:\nNOUVEAU | Bug A",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });

    mockParseReviewActions.mockReturnValue([
      { type: "nouveau", description: "Bug A" },
    ]);
    mockProcessReviewActions.mockResolvedValue({ posted: 1, enriched: 0, skipped: 0, newAttempted: 1 });

    // Execute: claimNextTask returns one task then null
    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-new", description: "Bug A", file: undefined, severity: undefined };
      return null;
    });

    mockSend.mockResolvedValueOnce({
      content: "DONE: fixed Bug A",
      toolCalls: [],
      costUsd: 0.02,
      durationMs: 300,
      sessionId: "s1",
    });

    const loopPromise = runAgentLoop(config, silentLogger);

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }

    const result = await loopPromise;

    // Verify processReviewActions was called
    expect(mockProcessReviewActions).toHaveBeenCalledWith(
      "http://localhost:3100",
      "test-agent",
      "Test Agent",
      [{ type: "nouveau", description: "Bug A" }],
    );
    // Verify fetchExistingThreads was called
    expect(mockFetchExistingThreads).toHaveBeenCalledWith("http://localhost:3100");
    // Verify discoveries were NOT posted directly (review handles it)
    expect(mockPostDiscoveries).not.toHaveBeenCalled();
    // Verify the flow completes
    expect(result.exitReason).toBe("done");
  });

  // #101 — chaque sortie nominale dépareille unclaimTask avec
  // claimedThreadIds.delete(). Mais le bloc CLEANUP ne balayait pas ce qui
  // restait dans le set : une exception entre le claim et l'une de ces sorties
  // laissait le thread réservé sur le coordinator, assigné à un agent mort, et
  // aucun autre agent ne pouvait le voler.
  it("libère la tâche réclamée quand le tour explose avant toute sortie nominale", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        { name: "execute", prompt: "Fix: {{params.current_task}}", toolsMode: "full", loop: true },
      ],
    });

    mockClaimNextTask.mockImplementation(async () => {
      // Une seule tâche, puis plus rien — l'exception tombe pendant son
      // traitement, donc le second appel n'arrive jamais.
      return { id: "t-orpheline", description: "Bug A", file: undefined, severity: undefined };
    });

    mockSend.mockRejectedValue(new Error("boom pendant le traitement de la tâche"));

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    const result = await loopPromise;

    expect(result.exitReason).toBe("error");
    expect(mockUnclaimTask).toHaveBeenCalledWith(
      "http://localhost:3100",
      "t-orpheline",
      "test-agent",
    );
  });

  it("respects maxTurns during work-stealing loop", async () => {
    // Discovery
    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    // Infinite tasks — always returns one
    mockClaimNextTask.mockResolvedValue({
      id: "t-inf",
      description: "Infinite task",
      file: undefined,
      severity: undefined,
    });

    // LLM never says DONE — just keeps working
    mockSend.mockResolvedValue({
      content: "Still fixing...",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });

    const result = await runAgentLoop(makePhasedConfig({ maxTurns: 3 }), silentLogger);

    // Discovery takes 1 turn, execute takes 2 more turns = 3 total
    expect(result.turnsCount).toBeLessThanOrEqual(3);
    expect(result.exitReason).toBe("done"); // phases complete, not max_turns
  });

  it("passes effort-derived model and maxTurns to send() for discover phase", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 200,
      sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      phases: [
        {
          name: "discover",
          prompt: "Scan",
          toolsMode: "read_only",
          loop: false,
          effort: "low",
        },
        {
          name: "execute",
          prompt: "Fix: {{params.current_task}}",
          toolsMode: "full",
          loop: true,
          effort: "high",
        },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // First send() = discover phase. Should use low profile: haiku + 2 turns.
    const firstCall = mockSend.mock.calls[0];
    expect(firstCall[1]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      thinking: "none",
      maxTurns: 15,
    });
  });

  it("passes effort-derived model and maxTurns to send() for review phase", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "review",   prompt: "Review",  toolsMode: "none",      loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix",     toolsMode: "full",      loop: true,  effort: "high" },
      ],
    });

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/a.ts | 10 | Bug A | major",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Bug A", file: "src/a.ts", line: 10, severity: "major" },
    ]);
    mockFetchExistingThreads.mockResolvedValue("(aucun thread actif)");
    mockSend.mockResolvedValueOnce({
      content: "REVIEW:\nNOUVEAU | Bug A",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "Bug A" }]);
    mockProcessReviewActions.mockResolvedValue({ posted: 1, enriched: 0, skipped: 0, newAttempted: 1 });
    mockClaimNextTask.mockResolvedValue(null);

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // Second send() = review phase. Should use low profile.
    const secondCall = mockSend.mock.calls[1];
    expect(secondCall[1]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      thinking: "none",
      maxTurns: 15,
    });
  });

  it("auto-resolves missing effort based on tools_mode and loop", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        // effort omitted — auto resolves to low (read_only)
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false },
        { name: "execute",  prompt: "Fix",  toolsMode: "full",      loop: true },
      ],
    });

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockClaimNextTask.mockResolvedValue(null);

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // discover: tools_mode=read_only → auto → low → haiku, 2 turns
    expect(mockSend.mock.calls[0][1]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      thinking: "none",
      maxTurns: 15,
    });
  });

  it("upgrades effort from low to mid when task severity is critical (work-stealing)", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    // Task with critical severity prefix in description
    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) {
        return { id: "t-1", description: "critical: src/auth.ts:42 — null pointer", file: undefined, severity: undefined };
      }
      return null;
    });

    mockSend.mockResolvedValueOnce({
      content: "DONE: patched",
      toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1",
    });

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        // execute starts at low — critical nudges it up to mid (Sonnet).
        // Previously this went to high (Opus), but Opus burned its budget on
        // exploration before reaching DONE in the raid scenario.
        { name: "execute",  prompt: "Fix: {{params.current_task}}", toolsMode: "full", loop: true, effort: "low" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // Second send() = execute for task t-1. Should be nudged to mid (Sonnet, 16 turns).
    const executeCall = mockSend.mock.calls[1];
    expect(executeCall[1]).toMatchObject({
      model: "claude-sonnet-4-6",
      thinking: "think",
      maxTurns: 16,
    });
  });

  it("does not upgrade when task severity is not critical", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) {
        return { id: "t-1", description: "minor: src/a.ts — typo", file: undefined, severity: undefined };
      }
      return null;
    });

    mockSend.mockResolvedValueOnce({
      content: "DONE",
      toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1",
    });

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix: {{params.current_task}}", toolsMode: "full", loop: true, effort: "mid" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // minor severity → no upgrade, execute stays at mid (sonnet, 5 turns)
    const executeCall = mockSend.mock.calls[1];
    expect(executeCall[1]).toMatchObject({
      model: "claude-sonnet-4-6",
      thinking: "think",
      maxTurns: 16,
    });
  });

  it("keeps max level even when task severity is critical (no double-upgrade)", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) {
        return { id: "t-1", description: "critical: src/auth.ts — bug", file: undefined, severity: undefined };
      }
      return null;
    });

    mockSend.mockResolvedValueOnce({
      content: "DONE",
      toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1",
    });

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix: {{params.current_task}}", toolsMode: "full", loop: true, effort: "max" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // max stays max: opus with 60 turns
    const executeCall = mockSend.mock.calls[1];
    expect(executeCall[1]).toMatchObject({
      model: "claude-opus-4-6",
      thinking: "ultrathink",
      maxTurns: 60,
    });
  });

  it("per-phase overrides win over effort profile (single-pass)", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      phases: [
        {
          name: "discover",
          prompt: "Scan",
          toolsMode: "read_only",
          loop: false,
          effort: "low",                 // profile: haiku + none + 8
          model: "claude-opus-4-6",      // override model only
          thinking: "ultrathink",        // override thinking only
          // maxTurns NOT overridden — should stay at profile default (8)
        },
        { name: "execute",  prompt: "Fix", toolsMode: "full", loop: true, effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    expect(mockSend.mock.calls[0][1]).toMatchObject({
      model: "claude-opus-4-6",    // overridden
      thinking: "ultrathink",      // overridden
      maxTurns: 15,                // profile default (low)
    });
  });

  it("maxTurns=0 override is treated as unset (fallback to profile default)", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      phases: [
        {
          name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false,
          effort: "low",
          maxTurns: 0,  // nonsensical — should fall back to profile (15)
        },
        { name: "execute", prompt: "Fix", toolsMode: "full", loop: true, effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    expect(mockSend.mock.calls[0][1].maxTurns).toBe(15);
  });

  it("empty-string override falls back to effort profile value", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      phases: [
        {
          name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false,
          effort: "low",
          model: "",        // empty = do not override
          thinking: "",     // empty = do not override
        },
        { name: "execute",  prompt: "Fix", toolsMode: "full", loop: true, effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    expect(mockSend.mock.calls[0][1]).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      thinking: "none",
      maxTurns: 15,
    });
  });

  it("restricts per-phase allowedTools based on phase.toolsMode", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\n- finding 1",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockSend.mockResolvedValueOnce({
      content: "REVIEW:\nNOUVEAU | finding 1",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockFetchExistingThreads.mockResolvedValue("(aucun thread actif)");
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "finding 1" }]);
    mockProcessReviewActions.mockResolvedValue({ posted: 1, enriched: 0, skipped: 0, newAttempted: 1 });
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      allowedTools: [
        "mcp__coordinator__list_threads",
        "mcp__coordinator__post_to_thread",
        "Read",
        "Glob",
        "Grep",
        "Bash",
        "Edit",
        "Write",
      ],
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "review",   prompt: "Review", toolsMode: "none",      loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix",    toolsMode: "full",      loop: true,  effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // discover (read_only): MCP tools + read-only user tools (no Edit/Write)
    const discoverOpts = mockSend.mock.calls[0][1];
    expect(discoverOpts.allowedTools).toEqual([
      "mcp__coordinator__list_threads",
      "mcp__coordinator__post_to_thread",
      "Read",
      "Glob",
      "Grep",
      "Bash",
    ]);

    // review (none): only MCP tools — no user tools at all
    const reviewOpts = mockSend.mock.calls[1][1];
    expect(reviewOpts.allowedTools).toEqual([
      "mcp__coordinator__list_threads",
      "mcp__coordinator__post_to_thread",
    ]);
  });

  it("passes per-phase disallowedTools based on toolsMode", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\n- finding",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockSend.mockResolvedValueOnce({
      content: "REVIEW:\nNOUVEAU | finding",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockFetchExistingThreads.mockResolvedValue("(aucun thread actif)");
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "finding" }]);
    mockProcessReviewActions.mockResolvedValue({ posted: 1, enriched: 0, skipped: 0, newAttempted: 1 });
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      allowedTools: [
        "mcp__coordinator__list_threads",
        "Read", "Glob", "Grep", "Bash", "Edit", "Write",
      ],
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "review",   prompt: "Review", toolsMode: "none",      loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix",    toolsMode: "full",      loop: true,  effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // discover (read_only): block write tools — Bash COMPRIS (DF4). L'ancienne
    // version de ce test affirmait `not.toContain("Bash")`, ce qui enshrinait
    // le trou : `echo > f` sous --dangerously-skip-permissions ecrivait l'arbre
    // malgre le mode « lecture seule ». Bash est desormais bloque dur.
    const discoverBlocked = mockSend.mock.calls[0][1].disallowedTools;
    expect(discoverBlocked).toContain("Write");
    expect(discoverBlocked).toContain("Edit");
    expect(discoverBlocked).toContain("NotebookEdit");
    expect(discoverBlocked).toContain("Bash");
    expect(discoverBlocked).not.toContain("Read");
    // AskUserQuestion attend une réponse humaine qu'un run headless n'a pas,
    // et --dangerously-skip-permissions ne l'auto-approuve pas : seule une
    // règle de deny empêche l'agent de rester suspendu, tâche réclamée.
    expect(discoverBlocked).toContain("AskUserQuestion");

    // review (none): block ALL user-facing tools
    const reviewBlocked = mockSend.mock.calls[1][1].disallowedTools;
    expect(reviewBlocked).toContain("Read");
    expect(reviewBlocked).toContain("Bash");
    expect(reviewBlocked).toContain("Grep");
    expect(reviewBlocked).toContain("Edit");
    expect(reviewBlocked).toContain("Write");
    expect(reviewBlocked).toContain("Skill");  // meta tool also blocked
    expect(reviewBlocked).toContain("AskUserQuestion");
  });

  // DF4 / Defect 1 — un agent read-only NON phase (gardien, phare) tombe en
  // one-shot, dont les sends ne passent aucune option. Le verrou vit dans le
  // wrapper `send` : TOUT envoi d'un run read_only doit bloquer l'ecriture, y
  // compris les envois nus (one-shot, coordination). Sans le wrapper, l'agent
  // ecrivait l'arbre reel sous --dangerously-skip-permissions.
  it("un run read-only bloque l'ecriture sur un envoi one-shot nu", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: audit termine",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    // Pas de phases -> mode one-shot ; readOnly:true -> le wrapper doit bloquer.
    await runAgentLoop(makeConfig({ readOnly: true }), silentLogger);

    const oneShotBlocked = mockSend.mock.calls[0][1].disallowedTools;
    for (const t of ["Write", "Edit", "NotebookEdit", "Bash"]) {
      expect(oneShotBlocked, `${t} doit etre bloque sur l'envoi one-shot read-only`).toContain(t);
    }
  });

  it("un run NON read-only ne bloque PAS l'ecriture en one-shot", async () => {
    mockSend.mockResolvedValue({
      content: "DONE: corrige",
      toolCalls: [],
      costUsd: 0.01,
      durationMs: 100,
      sessionId: "s1",
    });

    await runAgentLoop(makeConfig({ readOnly: false }), silentLogger);

    const oneShotBlocked = mockSend.mock.calls[0][1].disallowedTools;
    expect(oneShotBlocked).not.toContain("Write");
    expect(oneShotBlocked).not.toContain("Bash");
  });

  it("disallowedTools blocks nested-agent and human-interaction tools in full mode", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      allowedTools: ["Read", "Edit"],
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "full", loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix",  toolsMode: "full", loop: true,  effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // Task / Agent spawn sub-sessions whose tool calls escape the outer turn
    // budget; AskUserQuestion hangs the turn on a human who isn't there.
    // Both stay blocked even in full mode — the permission bypass grants
    // neither, and only the deny list actually stops AskUserQuestion.
    const blocked = mockSend.mock.calls[0][1].disallowedTools;
    expect(blocked).toEqual(expect.arrayContaining(["Task", "Agent", "AskUserQuestion"]));
    expect(blocked).not.toContain("Read");
    expect(blocked).not.toContain("Edit");
  });

  it("re-runs discover/review when pool exhausts and maxDiscoverCycles > 1", async () => {
    vi.useFakeTimers();

    // Cycle 1: discover finds 1, review posts 1, execute claims 1, pool empty
    // Cycle 2: discover finds 1 more, review posts 1, execute claims 1, pool empty
    // Cycle 3: discover finds 0, no posts → stop (tasksDoneLastCycle === 0)
    // Claim call 1: t-1; calls 2-5: null (4 nulls → break cycle 1 execute);
    // call 6: t-2; calls 7+: null (break cycle 2 execute). Cycle 3 discover
    // finds nothing → break.
    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-1", description: "first task", file: undefined, severity: undefined };
      if (claimCall === 6) return { id: "t-2", description: "second task", file: undefined, severity: undefined };
      return null;
    });

    // discover+review+exec (cycle 1)
    mockSend.mockResolvedValueOnce({ content: "DISCOVERY:\nitem 1", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockSend.mockResolvedValueOnce({ content: "REVIEW:\nNOUVEAU | item 1", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockSend.mockResolvedValueOnce({ content: "DONE: fixed 1", toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1" });
    // discover+review+exec (cycle 2)
    mockSend.mockResolvedValueOnce({ content: "DISCOVERY:\nitem 2", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockSend.mockResolvedValueOnce({ content: "REVIEW:\nNOUVEAU | item 2", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockSend.mockResolvedValueOnce({ content: "DONE: fixed 2", toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1" });
    // discover+review (cycle 3 — no tasks to claim, stops)
    mockSend.mockResolvedValue({ content: "DISCOVERY:\n(aucune trouvaille)", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });

    mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);
    mockFetchExistingThreads.mockResolvedValue("(aucun thread actif)");
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "item" }]);
    mockProcessReviewActions.mockResolvedValue({ posted: 1, enriched: 0, skipped: 0, newAttempted: 1 });

    const config = makeConfig({
      maxDiscoverCycles: 3,
      maxTurns: 50,   // allow enough turns for 3 cycles (discover + review + task per cycle)
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "review",   prompt: "Review", toolsMode: "none",      loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix: {{params.current_task}}", toolsMode: "full", loop: true, effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(10_000);
    const result = await loopPromise;

    // 2 tasks completed across 2 cycles
    expect(mockCompleteTask).toHaveBeenCalledTimes(2);
    expect(result.exitReason).toBe("done");
  });

  it("unclaims task (does not mark complete) when response has no DONE: marker", async () => {
    vi.useFakeTimers();

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-abandoned", description: "task the LLM abandons", file: undefined, severity: undefined };
      return null;
    });

    mockSend.mockResolvedValueOnce({ content: "DISCOVERY:\nitem", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockSend.mockResolvedValueOnce({ content: "REVIEW:\nNOUVEAU | item", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    // Execute phase: LLM responds without DONE: — should unclaim, not complete
    mockSend.mockResolvedValueOnce({ content: "Je vais explorer le projet...", toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1" });

    mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);
    mockFetchExistingThreads.mockResolvedValue("(aucun thread actif)");
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "item" }]);
    mockProcessReviewActions.mockResolvedValue({ posted: 1, enriched: 0, skipped: 0, newAttempted: 1 });

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "review",   prompt: "Review", toolsMode: "none",      loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix", toolsMode: "full", loop: true, effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockUnclaimTask).toHaveBeenCalledWith(
      "http://localhost:3100",
      "t-abandoned",
      "test-agent",
    );
  });

  it("unclaims task and does not report success when still rate limited after retry", async () => {
    vi.useFakeTimers();

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-stuck", description: "task that stays rate limited", file: undefined, severity: undefined };
      return null;
    });

    // Discovery phase
    mockSend.mockResolvedValueOnce({ content: "DISCOVERY:\nitem", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);

    // Execute phase: first attempt rate limited, retry after wait still rate limited
    mockSend.mockResolvedValueOnce({ content: "", toolCalls: [], costUsd: 0, durationMs: 100, sessionId: "s1", rateLimited: true, rateLimitResetsAt: undefined });
    mockSend.mockResolvedValueOnce({ content: "", toolCalls: [], costUsd: 0, durationMs: 100, sessionId: "s1", rateLimited: true, rateLimitResetsAt: undefined });

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix",  toolsMode: "full",      loop: true,  effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    // Fallback rate-limit wait is 5min; advance well past it plus retry margins.
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(10_000);
    const result = await loopPromise;

    // The task must be released, not left claimed forever.
    expect(mockUnclaimTask).toHaveBeenCalledWith(
      "http://localhost:3100",
      "t-stuck",
      "test-agent",
    );
    expect(mockCompleteTask).not.toHaveBeenCalled();
    // A run that never got past a rate limit must not be stamped as a success.
    expect(result.exitReason).not.toBe("done");
  });

  it("passe par le garde-fou de falsifiabilité AUSSI après une reprise de rate limit", async () => {
    // Le chemin de reprise appelait completeTask directement : un DONE: arraché
    // après la pause était accepté sans preuve, `requireFailingTest` ou non.
    // Même cécité que celle qui a produit les 54 refus, dans l'autre sens —
    // là le garde-fou refusait à tort, ici il ne regardait pas du tout.
    vi.useFakeTimers();

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-retry", description: "tâche reprise après rate limit", file: undefined, severity: undefined };
      return null;
    });

    mockSend.mockResolvedValueOnce({ content: "DISCOVERY:\nitem", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);

    // Execute: rate limited, puis DONE: à la reprise.
    mockSend.mockResolvedValueOnce({ content: "", toolCalls: [], costUsd: 0, durationMs: 100, sessionId: "s1", rateLimited: true, rateLimitResetsAt: undefined });
    mockSend.mockResolvedValueOnce({ content: "DONE: patch livré", toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1" });

    mockVerifyFailingTest.mockResolvedValue({
      falsifiable: false,
      reason: "aucun fichier de test modifié — rien ne prouve le défaut",
      testFiles: [],
      sourceFiles: [],
    });

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix",  toolsMode: "full",      loop: true,  effort: "high", requireFailingTest: true },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    expect(mockVerifyFailingTest).toHaveBeenCalled();
    expect(mockCompleteTask).not.toHaveBeenCalled();
    expect(mockUnclaimTask).toHaveBeenCalledWith(
      "http://localhost:3100",
      "t-retry",
      "test-agent",
    );
  });

  it("does NOT cycle when maxDiscoverCycles is absent (default)", async () => {
    vi.useFakeTimers();

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) return { id: "t-1", description: "task", file: undefined, severity: undefined };
      return null;
    });

    mockSend.mockResolvedValueOnce({ content: "DISCOVERY:\nitem", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockSend.mockResolvedValueOnce({ content: "REVIEW:\nNOUVEAU | item", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" });
    mockSend.mockResolvedValueOnce({ content: "DONE: fixed", toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1" });
    mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);
    mockFetchExistingThreads.mockResolvedValue("(aucun thread actif)");
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "item" }]);
    mockProcessReviewActions.mockResolvedValue({ posted: 1, enriched: 0, skipped: 0, newAttempted: 1 });

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false, effort: "low" },
        { name: "review",   prompt: "Review", toolsMode: "none",      loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix", toolsMode: "full", loop: true, effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // Default = 1 cycle, so discover called exactly once
    expect(mockParseDiscoveries).toHaveBeenCalledTimes(1);
    expect(mockCompleteTask).toHaveBeenCalledTimes(1);
  });

  it("passes full session allowedTools unchanged for full mode", async () => {
    vi.useFakeTimers();

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);
    mockClaimNextTask.mockResolvedValue(null);

    const config = makeConfig({
      allowedTools: ["Read", "Edit", "mcp__coordinator__list_threads"],
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "full", loop: false, effort: "low" },
        { name: "execute",  prompt: "Fix",  toolsMode: "full", loop: true,  effort: "high" },
      ],
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // full mode → pass the session-level list through (no filter)
    const discoverOpts = mockSend.mock.calls[0][1];
    expect(discoverOpts.allowedTools).toEqual(["Read", "Edit", "mcp__coordinator__list_threads"]);
  });

  // promptweave aplatit `current_task` à l'assemblage : déclaré `default: ""`
  // dans behaviors/phase-execute.yaml, le bloc `{{#if params.current_task}}`
  // qui l'entoure est supprimé en entier et le marqueur n'existe plus dans le
  // prompt rendu. Le prompt ci-dessous est donc celui que l'agent reçoit
  // VRAIMENT. Mesuré : trois agents ont patché le même fichier faute de savoir
  // quelle tâche ils avaient réclamée.
  it("injecte la tâche réclamée quand le marqueur a disparu du prompt assemblé", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Scan", toolsMode: "read_only", loop: false },
        {
          name: "execute",
          // Prompt assemblé réel : plus aucun {{params.current_task}} dedans.
          prompt: "## Tâche assignée\n\nCorrige la vulnérabilité du fichier de ta tâche.",
          toolsMode: "full",
          loop: true,
        },
      ],
    });

    mockSend.mockResolvedValueOnce({
      content: "No bugs.",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([]);

    let claimCall = 0;
    mockClaimNextTask.mockImplementation(async () => {
      claimCall++;
      if (claimCall === 1) {
        return { id: "t-1", description: "src/render.ts:42 — XSS dans renderName()", file: undefined, severity: undefined };
      }
      return null;
    });

    mockSend.mockResolvedValueOnce({
      content: "DONE: échappement ajouté",
      toolCalls: [], costUsd: 0.02, durationMs: 300, sessionId: "s1",
    });

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // call 0 = discover, call 1 = execute
    const executePrompt = mockSend.mock.calls[1][0] as string;
    expect(executePrompt).toContain("src/render.ts:42 — XSS dans renderName()");
  });

  // Même aplatissement côté review : `{{params.my_discoveries}}` et
  // `{{params.existing_threads}}` sont déclarés `default: ""` dans
  // behaviors/phase-review.yaml et interpolés à VIDE à l'assemblage. Les deux
  // .replace() ne trouvaient rien : la phase censée dédoublonner NEW/DUPLICATE/
  // ENRICHES recevait deux listes vides.
  it("injecte discoveries et threads quand les marqueurs ont disparu du prompt de review", async () => {
    vi.useFakeTimers();

    const config = makeConfig({
      phases: [
        { name: "discover", prompt: "Find bugs", toolsMode: "read_only", loop: false },
        // Prompt assemblé réel : les deux marqueurs ont été aplatis.
        { name: "review", prompt: "## DATA À ANALYSER\n\nDédoublonne et réponds par REVIEW:.", toolsMode: "none", loop: false },
        { name: "execute", prompt: "Corrige.", toolsMode: "full", loop: true },
      ],
    });

    mockSend.mockResolvedValueOnce({
      content: "DISCOVERY:\nsrc/auth.ts | 42 | Missing null check | critical",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseDiscoveries.mockReturnValue([
      { id: "", description: "Missing null check", file: "src/auth.ts", line: 42, severity: "critical" },
    ]);
    mockFetchExistingThreads.mockResolvedValue("- [t-existing] Vieux bug dans auth.ts");

    mockSend.mockResolvedValueOnce({
      content: "REVIEW:\n(aucune action)",
      toolCalls: [], costUsd: 0.01, durationMs: 200, sessionId: "s1",
    });
    mockParseReviewActions.mockReturnValue([{ type: "nouveau", description: "Missing null check" }]);

    // Pool vide : la phase execute ne déclenche aucun send supplémentaire.
    mockClaimNextTask.mockResolvedValue(null);

    const loopPromise = runAgentLoop(config, silentLogger);
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
    await loopPromise;

    // call 0 = discover, call 1 = review
    const reviewPrompt = mockSend.mock.calls[1][0] as string;
    expect(reviewPrompt).toContain("DISCOVERY:\nsrc/auth.ts | 42 | Missing null check | critical");
    expect(reviewPrompt).toContain("- [t-existing] Vieux bug dans auth.ts");
  });

  // ── L'UNITÉ DE JUGEMENT EST LE THREAD, PAS LA TENTATIVE ──────────────────
  //
  // Run G3, après #142 et #143 : refus tombés de 29 à 1. Le dernier, ligne par
  // ligne dans le log réel :
  //
  //   l.77   [work-stealing] claimed thread=2a2548b3 : critical: preflight.ts
  //   essai 1  l'agent écrit src/orchestrator/preflight.ts ET
  //            tests/unit/preflight-auth.test.ts, sans jamais commiter
  //   l.196  WARN aborting task (no DONE: marker) subtype=error_max_turns
  //   l.197  [work-stealing] claimed thread=2a2548b3   <- MÊME thread, MÊME agent
  //   essai 2  le travail est déjà là : l'agent n'écrit RIEN, lance vitest, DONE:
  //   l.268  WARN DONE refusé — aucun fichier de test modifié {"testFiles":[]}
  //
  // Vérifié : la branche de l'agent ne portait AUCUN commit au-delà de la base.
  // Le travail de l'essai 1 n'existait donc que NON SUIVI, dans l'arbre.
  //
  // Cause : `taskBaseline()` était relevé à CHAQUE réclamation. Au second essai
  // son inventaire des non-suivis contenait DÉJÀ le test écrit au premier, qui
  // se faisait alors soustraire comme « préexistant » — la soustraction de #142
  // retournée contre le correctif qu'elle protégeait, sur un chemin plus étroit.
  // Un travail RÉELLEMENT FAIT était refusé puis jeté.
  describe("ligne de base par THREAD", () => {
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", args, { cwd, encoding: "utf8" });

    type Verdict = { falsifiable: boolean; reason: string; testFiles: string[]; sourceFiles: string[] };
    let repo: string;
    let realVerify: (...args: never[]) => Promise<Verdict>;

    beforeEach(async () => {
      repo = mkdtempSync(join(tmpdir(), "essaim-thread-base-"));
      git(repo, "init", "-q");
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      writeFileSync(join(repo, "base.js"), "export const a = 1;\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "base");
      // promptweave dépose `.mcp.json` dans CHAQUE worktree d'agent à sa
      // création, et il y reste NON SUIVI : c'est lui qui rend l'inventaire
      // des non-suivis indispensable (#142), et lui qu'on reproduit ici.
      writeFileSync(join(repo, ".mcp.json"), "{}\n");
      mkdirSync(join(repo, "tests", "unit"), { recursive: true });

      // Le VRAI garde-fou, sur ce VRAI dépôt : c'est son verdict qu'on mesure,
      // pas un mock qui dirait ce qu'on veut entendre.
      const actual = await vi.importActual<typeof import("../../src/agent-loop/falsifiability.js")>(
        "../../src/agent-loop/falsifiability.js",
      );
      realVerify = actual.verifyFailingTest as unknown as (...args: never[]) => Promise<Verdict>;
    });

    afterEach(() => rmSync(repo, { recursive: true, force: true }));

    /** Branche le vrai garde-fou et collecte ses verdicts, dans l'ordre. */
    function captureVerdicts(): Verdict[] {
      const verdicts: Verdict[] = [];
      mockVerifyFailingTest.mockImplementation(async (...args: unknown[]) => {
        const v = await realVerify(...(args as never[]));
        verdicts.push(v);
        return v;
      });
      return verdicts;
    }

    const discovery = { content: "DISCOVERY:\nitem", toolCalls: [], costUsd: 0.01, durationMs: 100, sessionId: "s1" };

    // `maxTurns` = le nombre EXACT d'envois scénarisés (1 découverte + 2
    // exécutions) : la boucle sort alors sur son propre gardien plutôt que
    // d'aller dormir MAX_EMPTY_RETRIES x 10 s sur un pool vide. Pas de faux
    // minuteurs, donc les `spawn` de git réels ne risquent pas d'être affamés.
    const phases = () => [
      { name: "discover", prompt: "Scan", toolsMode: "read_only" as const, loop: false, effort: "low" as const },
      { name: "execute", prompt: "Fix", toolsMode: "full" as const, loop: true, effort: "high" as const, requireFailingTest: true },
    ];

    it("voit le test de l'essai 1 quand le MÊME thread est réclamé une seconde fois", async () => {
      let claims = 0;
      mockClaimNextTask.mockImplementation(async () => {
        claims++;
        return claims <= 2
          ? { id: "t-2a2548b3", description: "critical: orchestrator/preflight.ts", file: undefined, severity: "critical" }
          : null;
      });

      mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);

      mockSend
        .mockResolvedValueOnce(discovery)
        // Essai 1 : l'agent écrit son test de régression… et manque de tours.
        // Rien n'est commité — exactement l'état constaté sur la branche G3.
        .mockImplementationOnce(async () => {
          writeFileSync(join(repo, "tests", "unit", "preflight-auth.test.ts"), "// repro\n");
          return { content: "je continue", toolCalls: [], costUsd: 0.02, durationMs: 100, sessionId: "s1", subtype: "error_max_turns" };
        })
        // Essai 2 : le travail est déjà là, l'agent n'écrit RIEN et conclut.
        .mockResolvedValueOnce({ content: "DONE: preflight corrigé + test", toolCalls: [], costUsd: 0.02, durationMs: 100, sessionId: "s1" });

      const verdicts = captureVerdicts();

      await runAgentLoop(makeConfig({ workspacePath: repo, maxTurns: 3, phases: phases() }), silentLogger);

      expect(verdicts).toHaveLength(1);
      // LE POINT DU TEST : le test de l'essai 1 est VU au second essai.
      expect(verdicts[0].testFiles).toEqual(["tests/unit/preflight-auth.test.ts"]);
      expect(verdicts[0].falsifiable).toBe(true);
      expect(mockCompleteTask).toHaveBeenCalledWith(
        "http://localhost:3100", "t-2a2548b3", "test-agent", expect.any(String),
      );
    });

    // RÉGRESSION — LA BASE MÉMORISÉE NE DOIT PAS PÉRIMER.
    //
    // Première rédaction : une Map<threadId, base>. Deux relectures
    // indépendantes l'ont cassée par exécution. L'entrée survit à l'abandon —
    // c'est voulu — mais aussi à tout ce qui se passe ENTRE les deux
    // tentatives. Ordonnancement mesuré : A réclamé (base S0), A abandonné,
    // B réclamé, B écrit son test et COMMITE, B complété, puis A re-réclamé.
    // `git diff S0 HEAD` remonte alors les fichiers de B, et A était ACCEPTÉ
    // sur la preuve de B sans avoir rien écrit — là où main refusait
    // correctement. Un emplacement UNIQUE rend ça impossible : la réclamation
    // de B écrase celle de A.
    it("ne crédite PAS un thread rouvert du travail commité entre-temps par un autre", async () => {
      let claims = 0;
      mockClaimNextTask.mockImplementation(async () => {
        claims++;
        if (claims === 1) return { id: "t-A", description: "defaut A", file: undefined, severity: undefined };
        if (claims === 2) return { id: "t-B", description: "defaut B", file: undefined, severity: undefined };
        if (claims === 3) return { id: "t-A", description: "defaut A", file: undefined, severity: undefined };
        return null;
      });

      mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);

      mockSend
        .mockResolvedValueOnce(discovery)
        // A, essai 1 : rien produit, plafonne.
        .mockResolvedValueOnce({ content: "je continue", toolCalls: [], costUsd: 0.02, durationMs: 100, sessionId: "s1", subtype: "error_max_turns" })
        // B : écrit source + test et COMMITE, comme phase-execute l'ordonne.
        .mockImplementationOnce(async () => {
          writeFileSync(join(repo, "base.js"), "export const a = 2;\n");
          writeFileSync(join(repo, "tests", "unit", "b.test.ts"), "// repro de B\n");
          git(repo, "add", "--", "base.js", "tests/unit/b.test.ts");
          git(repo, "commit", "-qm", "fix B + test");
          return { content: "DONE: B corrige", toolCalls: [], costUsd: 0.02, durationMs: 100, sessionId: "s1" };
        })
        // A, essai 2 : n'écrit RIEN et prétend avoir fini.
        .mockResolvedValueOnce({ content: "DONE: A corrige", toolCalls: [], costUsd: 0.02, durationMs: 100, sessionId: "s1" });

      const verdicts = captureVerdicts();

      await runAgentLoop(makeConfig({ workspacePath: repo, maxTurns: 4, phases: phases() }), silentLogger);

      // Deux verdicts : celui de B, puis celui de A au second essai.
      expect(verdicts).toHaveLength(2);
      // LE POINT DU TEST : A ne doit rien voir du test de B.
      expect(verdicts[1].testFiles).not.toContain("tests/unit/b.test.ts");
      expect(verdicts[1].testFiles).toEqual([]);
      expect(mockCompleteTask).not.toHaveBeenCalledWith(
        "http://localhost:3100", "t-A", "test-agent", expect.any(String),
      );
    });

    // GARDE-FOU CONTRE LA SUR-CORRECTION. Une ligne de base « par AGENT »,
    // relevée une seule fois au démarrage de la boucle, serait plus simple et
    // FAUSSE : l'agent enchaîne plusieurs tâches dans le MÊME worktree, et le
    // test écrit pour la tâche 1 créditerait la tâche 2 qui n'en a produit
    // aucun. Le garde-fou deviendrait complaisant — le défaut exact qu'il
    // existe pour attraper. La clé DOIT être le thread : ce cas échoue si on
    // la remplace par une base globale.
    it("ne crédite PAS un thread du test écrit pour le thread précédent", async () => {
      let claims = 0;
      mockClaimNextTask.mockImplementation(async () => {
        claims++;
        if (claims === 1) return { id: "t-un", description: "premier défaut", file: undefined, severity: undefined };
        if (claims === 2) return { id: "t-deux", description: "second défaut", file: undefined, severity: undefined };
        return null;
      });

      mockParseDiscoveries.mockReturnValue([{ id: "", description: "item", file: undefined, line: undefined, severity: undefined }]);

      mockSend
        .mockResolvedValueOnce(discovery)
        // Thread 1 : test écrit, DONE: — accepté.
        .mockImplementationOnce(async () => {
          writeFileSync(join(repo, "tests", "unit", "un.test.ts"), "// repro\n");
          return { content: "DONE: premier corrigé", toolCalls: [], costUsd: 0.02, durationMs: 100, sessionId: "s1" };
        })
        // Thread 2 : rien d'écrit, DONE: quand même — doit être REFUSÉ.
        .mockResolvedValueOnce({ content: "DONE: second corrigé", toolCalls: [], costUsd: 0.02, durationMs: 100, sessionId: "s1" });

      const verdicts = captureVerdicts();

      await runAgentLoop(makeConfig({ workspacePath: repo, maxTurns: 3, phases: phases() }), silentLogger);

      expect(verdicts).toHaveLength(2);
      expect(verdicts[0].falsifiable).toBe(true);
      expect(verdicts[0].testFiles).toEqual(["tests/unit/un.test.ts"]);
      expect(verdicts[1].falsifiable).toBe(false);
      expect(verdicts[1].testFiles).toEqual([]);
      expect(mockCompleteTask).toHaveBeenCalledTimes(1);
    });
  });
});



describe("FALSE_POSITIVE_PATTERN", () => {
  // Une résolution « ce n'en est pas un » n'a ni patch ni test : le garde-fou
  // de falsifiabilité doit la laisser passer. Mesuré sur un vrai swarm, où un
  // agent a correctement identifié le faux positif et s'est fait refuser.
  it("reconnaît ce qu'un agent écrit vraiment", async () => {
    const { FALSE_POSITIVE_PATTERN } = await import("../../src/agent-loop/agent-loop.js");
    // Sortie littérale d'un agent sentinelle : tiret cadratin, pas deux-points.
    expect(FALSE_POSITIVE_PATTERN.test(
      "FALSE_POSITIVE — `f.severity` and `f.fingerprint` are already sanitized",
    )).toBe(true);
    expect(FALSE_POSITIVE_PATTERN.test("FALSE_POSITIVE: pas contrôlable")).toBe(true);
    expect(FALSE_POSITIVE_PATTERN.test("false positive : allowlist stricte")).toBe(true);
  });

  it("ne s'active pas sur un vrai correctif", async () => {
    const { FALSE_POSITIVE_PATTERN } = await import("../../src/agent-loop/agent-loop.js");
    expect(FALSE_POSITIVE_PATTERN.test("Échappement ajouté sur f.title + test")).toBe(false);
  });
});
