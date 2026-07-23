import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter, Readable } from "stream";

// ── Mock claude-stream's binary resolver so launchAgent reuses it ──────
vi.mock("../../src/agent-loop/claude-stream.js", () => ({
  resolveClaudeBin: vi.fn(() => "/resolved/path/to/claude"),
}));

function makeMockChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
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

import { waitForProcess, launchAgent } from "../../src/orchestrator/agent-launcher.js";
import type { AgentConfig } from "../../src/orchestrator/types.js";

describe("waitForProcess", () => {
  it("resolves with a failed result when spawn emits an error (does not hang or throw)", async () => {
    const child = makeMockChild();
    const p = waitForProcess(child as unknown as import("child_process").ChildProcess);

    child.emit("error", new Error("spawn claude ENOENT"));

    const result = await p;
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("spawn claude ENOENT");
  });

  it("still resolves normally on close", async () => {
    const child = makeMockChild();
    const p = waitForProcess(child as unknown as import("child_process").ChildProcess);

    child.emit("close", 0);

    const result = await p;
    expect(result.code).toBe(0);
  });

  it("does not resolve twice if both error and close fire", async () => {
    const child = makeMockChild();
    const p = waitForProcess(child as unknown as import("child_process").ChildProcess);

    child.emit("error", new Error("spawn claude ENOENT"));
    child.emit("close", null);

    const result = await p;
    // The error path wins — code stays non-zero, not overwritten by the
    // later close(null) → code:0 coercion.
    expect(result.code).not.toBe(0);
  });
});

describe("launchAgent", () => {
  beforeEach(() => {
    mockChildren = [];
    vi.clearAllMocks();
  });

  it("spawns the resolved claude binary instead of a bare 'claude' string", async () => {
    const { spawn } = await import("child_process");
    const agent: AgentConfig = {
      id: "a1",
      name: "Agent One",
      prompt: "do work",
    } as AgentConfig;

    launchAgent(agent, "/workspace", "http://localhost:3100", null);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(bin).toBe("/resolved/path/to/claude");
  });
});
