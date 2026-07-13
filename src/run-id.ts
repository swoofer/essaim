import { randomUUID } from "crypto";

/**
 * Identifier of the current essaim run, shared by every agent of the swarm.
 *
 * Threads announced with it are scoped to this run: a shared coordinator (where
 * /api/reset is 403-forbidden by design) otherwise keeps showing the threads of
 * an ABORTED earlier run to the next run's agents (#32).
 *
 * Same shape as coordinator-auth: read from the environment, absent = disabled,
 * so a run without it degrades to exactly today's behaviour (un-scoped threads,
 * visible to everyone).
 */
export function currentRunId(): string | undefined {
  const id = process.env.ESSAIM_RUN_ID?.trim();
  return id ? id : undefined;
}

/**
 * Mint the run id and publish it to the environment, so in-process agent loops
 * AND `claude -p` subprocesses (which inherit env) all stamp the same run.
 * Idempotent: an id already set (a runner, a CI job, a parent essaim) wins.
 */
export function ensureRunId(templateId: string): string {
  const existing = currentRunId();
  if (existing) return existing;
  const id = `${templateId}-${randomUUID().slice(0, 8)}`;
  process.env.ESSAIM_RUN_ID = id;
  return id;
}
