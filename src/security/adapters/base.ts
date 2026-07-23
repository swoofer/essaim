// src/security/adapters/base.ts — capture a subprocess's stdout/stderr/exit, with abort→kill.
import { spawn as nodeSpawn } from "node:child_process";
import { createLogger } from "../../logger.js";

const log = createLogger("security");

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

// Minimal child shape we depend on (EventEmitter + readable stdio + kill).
export interface ChildLike {
  stdout: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  stderr: { on(ev: "data", cb: (chunk: Buffer | string) => void): void } | null;
  on(ev: "close", cb: (code: number | null) => void): void;
  on(ev: "error", cb: (err: Error) => void): void;
  kill(signal?: string): void;
}

export type SpawnFn = (command: string, args: string[], opts: { cwd?: string }) => ChildLike;

const defaultSpawnFn: SpawnFn = (command, args, opts) =>
  nodeSpawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] }) as unknown as ChildLike;

/** Spawn a command, capture output, honor an AbortSignal (kill + timedOut). Rejects only on spawn error. */
export function spawnCaptured(
  command: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal; spawnFn?: SpawnFn } = {},
): Promise<SpawnResult> {
  const spawnFn = opts.spawnFn ?? defaultSpawnFn;
  return new Promise<SpawnResult>((resolve, reject) => {
    const child = spawnFn(command, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const onAbort = () => {
      timedOut = true;
      log.warn(`security: aborting subprocess ${command} (timeout/kill-switch)`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
