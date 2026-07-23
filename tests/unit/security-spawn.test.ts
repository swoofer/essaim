import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawnCaptured, type SpawnFn } from "../../src/security/adapters/base.js";

// A controllable fake child, mirroring the claude-stream.test.ts pattern.
function fakeChild() {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const proc = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (sig?: string) => void;
    killed: boolean;
  };
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
  };
  return proc;
}

describe("spawnCaptured", () => {
  it("collects stdout/stderr and resolves with the exit code", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child as never;
    const p = spawnCaptured("docker", ["run"], { spawnFn });
    // drive output then close
    await new Promise((r) => process.nextTick(r));
    child.stdout.push("hello ");
    child.stdout.push("world");
    child.stdout.push(null);
    child.stderr.push(null);
    child.emit("close", 0);
    const res = await p;
    expect(res).toEqual({ code: 0, stdout: "hello world", stderr: "", timedOut: false });
  });

  it("marks timedOut and kills the child when the signal aborts", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child as never;
    const ac = new AbortController();
    const p = spawnCaptured("docker", ["run"], { signal: ac.signal, spawnFn });
    await new Promise((r) => process.nextTick(r));
    ac.abort();
    // adapter kills the child; simulate the resulting close
    child.emit("close", null);
    const res = await p;
    expect(res.timedOut).toBe(true);
    expect(child.killed).toBe(true);
  });

  it("rejects only when spawn itself errors", async () => {
    const child = fakeChild();
    const spawnFn: SpawnFn = () => child as never;
    const p = spawnCaptured("docker", ["run"], { spawnFn });
    await new Promise((r) => process.nextTick(r));
    child.emit("error", new Error("ENOENT: docker not found"));
    await expect(p).rejects.toThrow(/docker not found/);
  });
});
