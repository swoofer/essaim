// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ThreadStatus =
  | "announced"
  | "waiting"
  | "working"
  | "resolving"
  | "resolved"
  | "cancelled";

export interface WorkDescription {
  subject: string;
  plan?: string;
  targetModules: string[];
  targetFiles: string[];
  dependsOnFiles?: string[];
  exportsAffected?: string[];
}

export interface AnnounceResult {
  threadId: string;
  status: "auto_resolved" | "open";
  expectedRespondents: string[];
  context: string;
}

export interface ThreadState {
  threadId: string;
  status: ThreadStatus;
  expectedRespondents: string[];
  respondedAgents: string[];
  round: number;
  decideRequested: boolean;
  work: WorkDescription;
}

// â”€â”€ Protocol actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ProtocolAction =
  | { type: "announce"; work: WorkDescription }
  | { type: "wait_responses"; threadId: string; timeoutMs: number }
  | { type: "ask_llm_respond"; threadId: string; context: string }
  | { type: "ask_llm_decide"; threadId: string; responses: string }
  | { type: "propose_resolution"; threadId: string }
  | { type: "wait_approvals"; threadId: string; timeoutMs: number }
  | { type: "work" }
  | { type: "done"; summary: string };

// â”€â”€ Protocol interface â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type Phase = "idle" | "announcing" | "waiting" | "working" | "resolving";

export interface CoordinationProtocol {
  // Start coordination for a piece of work
  startWork(work: WorkDescription): void;

  // Feed events from the coordinator/MQTT into the protocol
  onAnnounceResult(result: AnnounceResult): void;
  onThreadMessage(threadId: string, agentId: string, content: string): void;
  onResolutionProposed(threadId: string): void;
  onApproval(threadId: string, agentId: string): void;
  onContestation(threadId: string, agentId: string, reason: string): void;
  onTimeout(threadId: string): void;

  // After the agent-loop gets an ask_llm_decide action and the LLM
  // responds, call one of these to advance the state machine.
  decideContinue(): void;
  decideYield(): void;
  // The LLM wants to revise its plan instead of continuing or yielding —
  // updates the thread's plan and re-opens the current round for a fresh
  // set of responses (same reset as onContestation).
  decideAdjust(newPlan: string): void;

  // After work is done, transition to resolution
  workDone(): void;

  // Get the next action the agent-loop should take
  nextAction(): ProtocolAction | null;

  // Current state
  getThreadState(threadId: string): ThreadState | null;
  readonly currentThreadId: string | null;
  readonly phase: Phase;
}

// â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MAX_ROUNDS = 3;
const RESPONSE_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 20_000;

// â”€â”€ Implementation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function createCoordinationProtocol(agentId: string): CoordinationProtocol {
  let phase: Phase = "idle";
  let currentThreadId: string | null = null;
  let pendingWork: WorkDescription | null = null;

  const threads = new Map<string, ThreadState>();
  const actionQueue: ProtocolAction[] = [];
  const messageBuffer = new Map<string, Array<{ agentId: string; content: string }>>();

  // We store agentId for future use (e.g. filtering own messages)
  const _selfId = agentId;

  function enqueue(action: ProtocolAction): void {
    actionQueue.push(action);
  }

  function getThread(threadId: string): ThreadState | null {
    return threads.get(threadId) ?? null;
  }

  function allRespondentsReplied(thread: ThreadState): boolean {
    return thread.expectedRespondents.every((r) =>
      thread.respondedAgents.includes(r),
    );
  }

  function formatResponses(threadId: string): string {
    const msgs = messageBuffer.get(threadId) ?? [];
    return msgs.map((m) => `[${m.agentId}]: ${m.content}`).join("\n");
  }

  // Shared by onContestation and decideAdjust: reopen the current thread
  // for a new round of responses (bump round, clear respondents/decision
  // flag, go back to "waiting").
  function resetForNewRound(thread: ThreadState): void {
    thread.round += 1;
    thread.respondedAgents = [];
    thread.decideRequested = false;
    thread.status = "waiting";
    phase = "waiting";
    messageBuffer.set(thread.threadId, []);
    enqueue({ type: "wait_responses", threadId: thread.threadId, timeoutMs: RESPONSE_TIMEOUT_MS });
  }

  return {
    get phase() {
      return phase;
    },

    get currentThreadId() {
      return currentThreadId;
    },

    startWork(work: WorkDescription): void {
      if (phase !== "idle") {
        throw new Error(`Cannot start work while in phase "${phase}"`);
      }
      phase = "announcing";
      pendingWork = work;
      enqueue({ type: "announce", work });
    },

    onAnnounceResult(result: AnnounceResult): void {
      if (phase !== "announcing") return;

      const thread: ThreadState = {
        threadId: result.threadId,
        status: "announced",
        expectedRespondents: result.expectedRespondents,
        respondedAgents: [],
        round: 1,
        decideRequested: false,
        work: pendingWork ?? { subject: "", targetModules: [], targetFiles: [] },
      };
      pendingWork = null;
      threads.set(result.threadId, thread);
      messageBuffer.set(result.threadId, []);
      currentThreadId = result.threadId;

      if (result.status === "auto_resolved" || result.expectedRespondents.length === 0) {
        thread.status = "working";
        phase = "working";
        enqueue({ type: "work" });
      } else {
        thread.status = "waiting";
        phase = "waiting";
        enqueue({ type: "wait_responses", threadId: result.threadId, timeoutMs: RESPONSE_TIMEOUT_MS });
      }
    },

    onThreadMessage(threadId: string, fromAgentId: string, content: string): void {
      const thread = getThread(threadId);
      if (!thread || phase !== "waiting") return;

      // Record the message
      const msgs = messageBuffer.get(threadId) ?? [];
      msgs.push({ agentId: fromAgentId, content });
      messageBuffer.set(threadId, msgs);

      // Track respondent
      if (!thread.respondedAgents.includes(fromAgentId)) {
        thread.respondedAgents.push(fromAgentId);
      }

      // If all respondents replied, ask the LLM to decide — but only once
      // per round, so a duplicate/replayed message doesn't re-enqueue it.
      if (allRespondentsReplied(thread) && !thread.decideRequested) {
        thread.decideRequested = true;
        enqueue({
          type: "ask_llm_decide",
          threadId,
          responses: formatResponses(threadId),
        });
      }
    },

    onResolutionProposed(threadId: string): void {
      const thread = getThread(threadId);
      if (!thread) return;

      thread.status = "resolving";
      thread.respondedAgents = [];
      phase = "resolving";
      enqueue({ type: "wait_approvals", threadId, timeoutMs: APPROVAL_TIMEOUT_MS });
    },

    onApproval(threadId: string, fromAgentId: string): void {
      const thread = getThread(threadId);
      if (!thread || phase !== "resolving") return;

      if (!thread.respondedAgents.includes(fromAgentId)) {
        thread.respondedAgents.push(fromAgentId);
      }

      if (allRespondentsReplied(thread)) {
        thread.status = "resolved";
        phase = "idle";
        currentThreadId = null;
        enqueue({ type: "done", summary: `Thread ${threadId} resolved after round ${thread.round}` });
      }
    },

    onContestation(threadId: string, _fromAgentId: string, _reason: string): void {
      const thread = getThread(threadId);
      if (!thread || phase !== "resolving") return;

      if (thread.round >= MAX_ROUNDS) {
        thread.status = "resolved";
        phase = "idle";
        currentThreadId = null;
        enqueue({
          type: "done",
          summary: `Thread ${threadId} auto-resolved after ${MAX_ROUNDS} rounds (max reached)`,
        });
        return;
      }

      // Back to waiting for a new round
      resetForNewRound(thread);
    },

    onTimeout(threadId: string): void {
      const thread = getThread(threadId);
      if (!thread) return;

      if (phase === "waiting") {
        enqueue({
          type: "ask_llm_decide",
          threadId,
          responses: formatResponses(threadId),
        });
      } else if (phase === "resolving") {
        thread.status = "resolved";
        phase = "idle";
        currentThreadId = null;
        enqueue({
          type: "done",
          summary: `Thread ${threadId} resolved (approval timeout, round ${thread.round})`,
        });
      }
    },

    decideContinue(): void {
      if (phase !== "waiting" || !currentThreadId) return;
      const thread = getThread(currentThreadId);
      if (!thread) return;

      thread.status = "working";
      phase = "working";
      enqueue({ type: "work" });
    },

    decideYield(): void {
      if (phase !== "waiting" || !currentThreadId) return;
      const thread = getThread(currentThreadId);
      if (!thread) return;

      thread.status = "cancelled";
      phase = "idle";
      currentThreadId = null;
      enqueue({ type: "done", summary: `Yielded on thread ${thread.threadId}` });
    },

    decideAdjust(newPlan: string): void {
      if (phase !== "waiting" || !currentThreadId) return;
      const thread = getThread(currentThreadId);
      if (!thread) return;

      thread.work.plan = newPlan;
      resetForNewRound(thread);
    },

    workDone(): void {
      if (phase !== "working" || !currentThreadId) return;
      const thread = getThread(currentThreadId);
      if (!thread) return;

      enqueue({ type: "propose_resolution", threadId: currentThreadId });
    },

    nextAction(): ProtocolAction | null {
      return actionQueue.shift() ?? null;
    },

    getThreadState(threadId: string): ThreadState | null {
      return getThread(threadId);
    },
  } satisfies CoordinationProtocol;
}

