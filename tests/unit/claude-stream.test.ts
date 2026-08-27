import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter, Readable } from "stream";
import {
  buildArgs,
  createStreamParser,
  createClaudeStream,
  BudgetExceededError,
  type StreamEvent,
} from "../../src/agent-loop/claude-stream.js";

// ── buildArgs ──────────────────────────────────────────────────────────

describe("buildArgs", () => {
  it("returns base flags for minimal options", () => {
    const args = buildArgs({ workspacePath: "/tmp" }, "hello", false);
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
  });

  it("includes all optional flags when provided", () => {
    const args = buildArgs({
      workspacePath: "/tmp",
      mcpConfigPath: "/etc/mcp.json",
      allowedTools: ["Read", "Write"],
      sessionId: "abc-123",
      model: "opus",
      systemPrompt: "You are helpful.",
      appendSystemPrompt: "Be concise.",
      maxBudgetUsd: 5,
      dangerouslySkipPermissions: true,
    }, "test prompt", false);
    expect(args).toContain("--mcp-config");
    expect(args).toContain("/etc/mcp.json");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Read,Write");
    expect(args).toContain("--session-id");
    expect(args).toContain("abc-123");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("uses --resume on subsequent turns", () => {
    const args = buildArgs({ workspacePath: "/tmp", sessionId: "s1" }, "next", true);
    expect(args).toContain("--resume");
    expect(args).toContain("s1");
    expect(args).not.toContain("--session-id");
  });

  it("omits flags for undefined optional values", () => {
    const args = buildArgs({ workspacePath: "/tmp", allowedTools: [] }, "hi", false);
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("includes --model from opts when sendOpts.model is not provided", () => {
    const args = buildArgs(
      { workspacePath: "/tmp", model: "claude-opus-4-6" },
      "prompt",
      false,
    );
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("claude-opus-4-6");
  });

  it("sendOpts.model takes priority over opts.model", () => {
    const args = buildArgs(
      { workspacePath: "/tmp", model: "claude-opus-4-6" },
      "prompt",
      false,
      { model: "claude-haiku-4-5-20251001" },
    );
    // --model should appear exactly once with the sendOpts value
    const modelIndexes = args
      .map((a, i) => (a === "--model" ? i : -1))
      .filter((i) => i !== -1);
    expect(modelIndexes).toHaveLength(1);
    expect(args[modelIndexes[0] + 1]).toBe("claude-haiku-4-5-20251001");
    expect(args).not.toContain("claude-opus-4-6");
  });

  it("sendOpts.model without opts.model still emits --model", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "prompt",
      false,
      { model: "claude-sonnet-4-6" },
    );
    expect(args).toContain("--model");
    const idx = args.indexOf("--model");
    expect(args[idx + 1]).toBe("claude-sonnet-4-6");
  });

  it("sendOpts.maxTurns still works alongside sendOpts.model", () => {
    const args = buildArgs(
      { workspacePath: "/tmp", model: "claude-opus-4-6", maxTurns: 50 },
      "prompt",
      false,
      { model: "claude-haiku-4-5-20251001", maxTurns: 2 },
    );
    const maxTurnsIdx = args.indexOf("--max-turns");
    expect(args[maxTurnsIdx + 1]).toBe("2");
    const modelIdx = args.indexOf("--model");
    expect(args[modelIdx + 1]).toBe("claude-haiku-4-5-20251001");
  });

  it("sendOpts.allowedTools overrides opts.allowedTools", () => {
    const args = buildArgs(
      { workspacePath: "/tmp", allowedTools: ["Read", "Bash", "Edit"] },
      "prompt",
      false,
      { allowedTools: ["Read", "Glob"] },
    );
    const idx = args.indexOf("--allowedTools");
    expect(args[idx + 1]).toBe("Read,Glob");
    // No duplicate --allowedTools flags
    const occurrences = args.filter((a) => a === "--allowedTools").length;
    expect(occurrences).toBe(1);
  });

  it("sendOpts.allowedTools without opts.allowedTools still emits --allowedTools", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "prompt",
      false,
      { allowedTools: ["mcp__coord__list_threads"] },
    );
    expect(args).toContain("--allowedTools");
    const idx = args.indexOf("--allowedTools");
    expect(args[idx + 1]).toBe("mcp__coord__list_threads");
  });

  it("opts.allowedTools is used when sendOpts.allowedTools is absent", () => {
    const args = buildArgs(
      { workspacePath: "/tmp", allowedTools: ["Read", "Bash"] },
      "prompt",
      false,
    );
    const idx = args.indexOf("--allowedTools");
    expect(args[idx + 1]).toBe("Read,Bash");
  });

  it("emits --disallowedTools when sendOpts.disallowedTools is provided", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "prompt",
      false,
      { disallowedTools: ["Read", "Write", "Bash"] },
    );
    const idx = args.indexOf("--disallowedTools");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("Read,Write,Bash");
  });

  it("omits --disallowedTools when disallowedTools is empty", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "prompt",
      false,
      { disallowedTools: [] },
    );
    expect(args).not.toContain("--disallowedTools");
  });

  it("allowedTools and disallowedTools coexist", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "prompt",
      false,
      { allowedTools: ["mcp__coord__list_threads"], disallowedTools: ["Read", "Edit"] },
    );
    expect(args.indexOf("--allowedTools")).toBeGreaterThan(-1);
    expect(args.indexOf("--disallowedTools")).toBeGreaterThan(-1);
  });

  it("appends 'ultrathink' to prompt when thinking=ultrathink", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "original prompt",
      false,
      { thinking: "ultrathink" },
    );
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toContain("original prompt");
    expect(args[pIdx + 1]).toContain("ultrathink");
  });

  it("appends 'think hard' (space form) when thinking=think-hard", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "foo",
      false,
      { thinking: "think-hard" },
    );
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toContain("think hard");
    // Must NOT leak the hyphenated internal form into the prompt
    expect(args[pIdx + 1]).not.toContain("think-hard");
  });

  it("does not modify prompt when thinking=none", () => {
    const args = buildArgs(
      { workspacePath: "/tmp" },
      "clean prompt",
      false,
      { thinking: "none" },
    );
    const pIdx = args.indexOf("-p");
    // "none" means no keyword appended — prompt stays as-is (modulo newline sanitization)
    expect(args[pIdx + 1]).toBe("clean prompt");
  });

  it("does not modify prompt when thinking is undefined", () => {
    const args = buildArgs({ workspacePath: "/tmp" }, "plain", false);
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toBe("plain");
  });
});

// ── createStreamParser ─────────────────────────────────────────────────

describe("createStreamParser", () => {
  let emitter: EventEmitter;
  let readable: Readable;
  let events: StreamEvent[];

  beforeEach(() => {
    emitter = new EventEmitter();
    readable = new Readable({ read() {} });
    events = [];
    emitter.on("event", (e: StreamEvent) => events.push(e));
  });

  const tick = () => new Promise(r => process.nextTick(r));

  it("parses complete NDJSON lines", async () => {
    createStreamParser(emitter, readable);
    readable.push('{"type":"system","subtype":"init","session_id":"s1"}\n');
    readable.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n');
    await tick();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "system", subtype: "init", session_id: "s1" });
    expect(events[1]).toMatchObject({ type: "assistant" });
  });

  it("handles split chunks (partial lines)", async () => {
    createStreamParser(emitter, readable);
    readable.push('{"type":"sys');
    readable.push('tem","subtype":"init"}\n');
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "system", subtype: "init" });
  });

  it("flushes buffer on stream end", async () => {
    createStreamParser(emitter, readable);
    readable.push('{"type":"system","subtype":"init"}');
    await tick();
    expect(events).toHaveLength(0);
    readable.push(null);
    await tick();
    expect(events).toHaveLength(1);
  });

  it("ignores non-JSON lines", async () => {
    createStreamParser(emitter, readable);
    readable.push("not json at all\n");
    readable.push('{"type":"system","subtype":"init"}\n');
    await tick();
    expect(events).toHaveLength(1);
  });

  it("ignores blank lines", async () => {
    createStreamParser(emitter, readable);
    readable.push('\n\n{"type":"system","subtype":"init"}\n\n');
    await tick();
    expect(events).toHaveLength(1);
  });

  it("correctly decodes a multi-byte UTF-8 character split across raw Buffer chunks", async () => {
    createStreamParser(emitter, readable);
    // "café" — the "é" is 2 bytes (0xC3 0xA9) in UTF-8. Split those two bytes
    // across two separate Buffer chunks to simulate a TCP/pipe boundary landing
    // mid-codepoint.
    const prefix = Buffer.from('{"type":"system","subtype":"init","note":"caf', "utf8");
    const suffix = Buffer.from('"}\n', "utf8");
    const accent = Buffer.from("é", "utf8");
    readable.push(Buffer.concat([prefix, accent.subarray(0, 1)]));
    readable.push(Buffer.concat([accent.subarray(1), suffix]));
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "system", subtype: "init", note: "café" });
  });
});

// ── createClaudeStream (spawn-per-turn model) ────────────────────────

// Mock spawn to simulate claude -p behavior
function makeMockChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = { end: vi.fn(), write: vi.fn() };
  const proc = new EventEmitter() as EventEmitter & {
    stdin: typeof stdin; stdout: Readable; stderr: Readable; pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
}

let mockChildren: ReturnType<typeof makeMockChild>[] = [];

vi.mock("child_process", () => ({
  spawn: vi.fn(() => {
    const child = makeMockChild();
    mockChildren.push(child);
    return child;
  }),
}));

vi.mock("crypto", () => ({
  randomUUID: () => "test-uuid-1234",
}));

describe("createClaudeStream (spawn-per-turn)", () => {
  beforeEach(() => {
    mockChildren = [];
    vi.clearAllMocks();
  });

  it("creates a client with session ID", () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });
    expect(client.isAlive()).toBe(true);
    expect(client.sessionId).toBe("test-uuid-1234");
    client.close();
  });

  it("send() spawns claude -p and resolves on result", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("Hello");

    // A child should have been spawned
    expect(mockChildren).toHaveLength(1);
    const child = mockChildren[0];

    // Simulate claude response
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"system","subtype":"init","session_id":"sess-1"}\n');
    child.stdout.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}}\n');
    child.stdout.push('{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":500,"session_id":"sess-1"}\n');
    child.stdout.push(null);

    const resp = await p;
    expect(resp.content).toBe("Hi!");
    expect(resp.costUsd).toBe(0.01);
    expect(resp.sessionId).toBe("sess-1");
    expect(client.sessionId).toBe("sess-1");

    client.close();
  });

  it("multi-turn spawns separate processes with --resume", async () => {
    const { spawn } = await import("child_process");
    const client = createClaudeStream({ workspacePath: "/tmp" });

    // Turn 1
    const p1 = client.send("Turn 1");
    const child1 = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child1.stdout.push('{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":100,"session_id":"s1"}\n');
    child1.stdout.push(null);
    child1.emit("close", 0);
    await p1;

    // Turn 2 — should spawn a NEW process
    const p2 = client.send("Turn 2");
    expect(mockChildren).toHaveLength(2);

    const child2 = mockChildren[1];
    await new Promise(r => process.nextTick(r));
    child2.stdout.push('{"type":"result","subtype":"success","cost_usd":0.02,"duration_ms":200,"session_id":"s1"}\n');
    child2.stdout.push(null);
    child2.emit("close", 0);
    await p2;

    // Second spawn should use --resume
    expect(spawn).toHaveBeenCalledTimes(2);
    const secondArgs = (spawn as ReturnType<typeof vi.fn>).mock.calls[1][1] as string[];
    expect(secondArgs).toContain("--resume");

    client.close();
  });

  it("throws BudgetExceededError", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("expensive");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"result","subtype":"error_max_budget_usd"}\n');
    child.stdout.push(null);

    await expect(p).rejects.toThrow(BudgetExceededError);
    client.close();
  });

  it("extracts token usage from result event", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("Hello");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"system","subtype":"init","session_id":"s-tok"}\n');
    child.stdout.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}\n');
    child.stdout.push('{"type":"result","subtype":"success","cost_usd":0.05,"duration_ms":500,"session_id":"s-tok","usage":{"input_tokens":2345,"output_tokens":1234,"cache_read_input_tokens":1500,"cache_creation_input_tokens":800}}\n');
    child.stdout.push(null);

    const resp = await p;
    expect(resp.tokens).toEqual({
      inputTokens: 2345,
      outputTokens: 1234,
      cacheReadTokens: 1500,
      cacheCreationTokens: 800,
    });

    client.close();
  });

  it("resolves with partial content on non-success result subtype (e.g. error_max_turns)", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("long task");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"system","subtype":"init","session_id":"s-max"}\n');
    child.stdout.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial answer"}]}}\n');
    child.stdout.push('{"type":"result","subtype":"error_max_turns","cost_usd":0.05,"duration_ms":3000,"session_id":"s-max"}\n');
    child.stdout.push(null);

    const resp = await p;
    expect(resp.content).toBe("partial answer");
    expect(resp.costUsd).toBe(0.05);
    expect(resp.sessionId).toBe("s-max");
    expect(resp.durationMs).toBe(3000);

    client.close();
  });

  it("resolves even on unknown result subtype (forward-compat)", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("test");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"result","subtype":"totally_new_subtype","session_id":"s1"}\n');
    child.stdout.push(null);

    const resp = await p;
    expect(resp.sessionId).toBe("s1");
    client.close();
  });

  it("rejects if process exits with error code", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("crash");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.emit("close", 1);

    await expect(p).rejects.toThrow("Claude exited code 1");
    client.close();
  });

  it("rejects send() if client is closed", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });
    client.close();
    expect(client.isAlive()).toBe(false);
    await expect(client.send("nope")).rejects.toThrow("closed");
  });

  it("close() SIGKILLs the running claude child (F1: no zombies)", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });
    const p = client.send("long task");
    await new Promise(r => process.nextTick(r));
    const child = mockChildren[0];
    // Simulate a running child (no exitCode yet).
    (child as unknown as { exitCode: number | null }).exitCode = null;

    client.close();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    // Simulate child death to let the send promise settle.
    child.emit("close", 137);
    await expect(p).rejects.toThrow();
  });

  it("abortSignal firing SIGKILLs the child and rejects send with AbortError", async () => {
    const controller = new AbortController();
    const client = createClaudeStream({ workspacePath: "/tmp", abortSignal: controller.signal });
    const p = client.send("long task").catch((e) => e);
    await new Promise(r => process.nextTick(r));
    const child = mockChildren[0];
    (child as unknown as { exitCode: number | null }).exitCode = null;

    controller.abort();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.emit("close", 137);
    const err = await p;
    expect(err).toBeInstanceOf(Error);
  });

  it("send() on a client whose abortSignal is pre-aborted rejects with AbortError", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createClaudeStream({ workspacePath: "/tmp", abortSignal: controller.signal });
    await expect(client.send("nope")).rejects.toThrow();
    expect(client.isAlive()).toBe(false);
  });

  it("scrubs engine secrets from the env handed to the spawned claude child (buildChildEnv applied)", async () => {
    process.env.LLM_API_KEY = "sk-engine-secret";
    process.env.STRIX_LLM = "x";
    process.env.ANTHROPIC_API_KEY = "sk-ant-keep";
    try {
      const { spawn } = await import("child_process");
      const client = createClaudeStream({ workspacePath: "/tmp" });

      const p = client.send("Hello");
      await new Promise((r) => process.nextTick(r));
      const child = mockChildren[0];
      child.stdout.push('{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":100,"session_id":"s1"}\n');
      child.stdout.push(null);
      await p;

      expect(spawn).toHaveBeenCalledTimes(1);
      const opts = (spawn as ReturnType<typeof vi.fn>).mock.calls[0][2] as { env: Record<string, string | undefined> };
      const env = opts.env;
      expect(env.LLM_API_KEY).toBeUndefined();
      expect(env.STRIX_LLM).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-keep");
      expect(env.PATH ?? env.Path).toBeTruthy();

      client.close();
    } finally {
      delete process.env.LLM_API_KEY;
      delete process.env.STRIX_LLM;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("compte les compact_boundary et somme les tokens avant/après", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("long task");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"system","subtype":"init","session_id":"s-compact"}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":150000,"post_tokens":42000}}\n');
    child.stdout.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":148000,"post_tokens":40000}}\n');
    child.stdout.push('{"type":"result","subtype":"error_max_turns","cost_usd":0.05,"duration_ms":3000,"session_id":"s-compact"}\n');
    child.stdout.push(null);

    const resp = await p;
    expect(resp.compaction).toEqual({ count: 2, preTokens: 298000, postTokens: 82000 });
    // C'est la CONJONCTION qui lève l'ambiguïté : error_max_turns AVEC
    // compaction = fenêtre de contexte pleine, pas plafond de tours trop bas.
    expect(resp.subtype).toBe("error_max_turns");
    // Le contenu collecté avant la compaction n'est pas perdu.
    expect(resp.content).toBe("partial");

    client.close();
  });

  it("compte une compaction même quand le payload n'a pas la forme supposée", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("hello");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    // Trois formes hostiles : aucun metadata, metadata non-objet, tokens non-numériques.
    child.stdout.push('{"type":"system","subtype":"compact_boundary"}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":"pas-un-objet"}\n');
    child.stdout.push('{"type":"system","subtype":"compact_boundary","compact_metadata":{"pre_tokens":"beaucoup","post_tokens":null}}\n');
    child.stdout.push('{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":100,"session_id":"s1"}\n');
    child.stdout.push(null);

    const resp = await p;
    // Le compteur reste juste quelle que soit la forme ; seuls les tokens tombent à 0.
    expect(resp.compaction).toEqual({ count: 3, preTokens: 0, postTokens: 0 });

    client.close();
  });

  it("expose compaction à zéro quand aucun compact_boundary n'arrive", async () => {
    const client = createClaudeStream({ workspacePath: "/tmp" });

    const p = client.send("court");
    const child = mockChildren[0];
    await new Promise(r => process.nextTick(r));
    child.stdout.push('{"type":"result","subtype":"success","cost_usd":0.01,"duration_ms":100,"session_id":"s1"}\n');
    child.stdout.push(null);

    const resp = await p;
    // Champ toujours présent : l'appelant n'a jamais à tester undefined.
    expect(resp.compaction).toEqual({ count: 0, preTokens: 0, postTokens: 0 });

    client.close();
  });
});

