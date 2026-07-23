// src/security/strix-cli.ts — Strix HOST CLI invocation: pure argv/env builders + a fs-injectable
// reader for the `strix_runs/<run>/` artifact directory Strix writes on exit.
// Strix is `pip install strix-agent` → command `strix`, run on the HOST, which internally pulls +
// drives a Docker sandbox image. essaim never `docker run`s a Strix image directly (see
// docs/superpowers/specs/2026-07-23-strix-adapter-real-invocation-design.md).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedScope } from "./types.js";

// Pinned by DIGEST (never a bare tag). Multi-arch OCI index; resolves per-platform to amd64/arm64.
// Captured 2026-07-23 via `docker buildx imagetools inspect ghcr.io/usestrix/strix-sandbox`.
export const PINNED_STRIX_SANDBOX_IMAGE =
  "ghcr.io/usestrix/strix-sandbox@sha256:812c42ca0332a25e7a8d87c091a33b5fee722e5b13b370dda29a33e4e26968b6";

function defaultInstruction(scope: ResolvedScope): string {
  return `Scan the target. ${scope.mode === "diff" ? `Only changes since ${scope.diffBase}.` : "Full tree."}`;
}

/** Build the `strix` CLI argv (host command — NOT `docker run` argv). */
export function strixCliArgs(scope: ResolvedScope, opts?: { instruction?: string }): string[] {
  return [
    "-n",
    "-t",
    scope.targetPath,
    "-m",
    scope.scanMode,
    ...(scope.mode === "diff" && scope.diffBase ? ["--scope-mode", "diff", "--diff-base", scope.diffBase] : []),
    "--instruction",
    opts?.instruction ?? defaultInstruction(scope),
  ];
}

/**
 * Build the CHILD process env for the `strix` invocation. Adds STRIX_LLM/LLM_API_KEY only when
 * present in `secrets` — never invents values. Caller merges this over a copy of process.env
 * (essaim's own process.env is never mutated; see adapters/strix.ts).
 */
export function strixEnv(secrets: Record<string, string>, image: string = PINNED_STRIX_SANDBOX_IMAGE): Record<string, string> {
  const env: Record<string, string> = {
    STRIX_IMAGE: image,
    STRIX_RUNTIME_BACKEND: "docker",
  };
  if (secrets.STRIX_LLM !== undefined) env.STRIX_LLM = secrets.STRIX_LLM;
  if (secrets.LLM_API_KEY !== undefined) env.LLM_API_KEY = secrets.LLM_API_KEY;
  return env;
}

export interface FindNewestRunDeps {
  readdir?: (p: string) => string[];
  mtime?: (p: string) => number;
}

function defaultReaddir(p: string): string[] {
  return readdirSync(p, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function defaultMtime(p: string): number {
  return statSync(p).mtimeMs;
}

/** Find the newest subdirectory of `runsRoot` (Strix's `<cwd>/strix_runs`) by mtime. Null if none/unreadable. */
export function findNewestStrixRun(runsRoot: string, deps: FindNewestRunDeps = {}): string | null {
  const readdir = deps.readdir ?? defaultReaddir;
  const mtime = deps.mtime ?? defaultMtime;
  let names: string[];
  try {
    names = readdir(runsRoot);
  } catch {
    return null;
  }
  let best: { name: string; mtimeMs: number } | null = null;
  for (const name of names) {
    let mtimeMs: number;
    try {
      mtimeMs = mtime(join(runsRoot, name));
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) best = { name, mtimeMs };
  }
  return best ? join(runsRoot, best.name) : null;
}

export interface ReadRunArtifactsDeps {
  findRun?: typeof findNewestStrixRun;
  readFile?: (p: string) => string;
}

/** Read `vulnerabilities.json` + `findings.sarif` from the newest run under `<workdir>/strix_runs`. */
export function readStrixRunArtifacts(workdir: string, deps: ReadRunArtifactsDeps = {}): { vulnJson?: string; sarif?: string } {
  const findRun = deps.findRun ?? findNewestStrixRun;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const runDir = findRun(join(workdir, "strix_runs"));
  if (!runDir) return {};

  const out: { vulnJson?: string; sarif?: string } = {};
  try {
    out.vulnJson = readFile(join(runDir, "vulnerabilities.json"));
  } catch {
    /* not present/readable */
  }
  try {
    out.sarif = readFile(join(runDir, "findings.sarif"));
  } catch {
    /* not present/readable */
  }
  return out;
}
