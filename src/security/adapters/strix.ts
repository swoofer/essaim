// src/security/adapters/strix.ts — the one real EngineAdapter. Spawns the HOST `strix` CLI
// (pip install strix-agent), which internally pulls + drives a Docker sandbox image. Reads the
// machine-readable artifacts Strix writes to `<cwd>/strix_runs/<run>/` on exit.
import type { EngineAdapter, EngineCapabilities, EngineRunResult, ResolvedScope } from "../types.js";
import { spawnCaptured, type SpawnFn } from "./base.js";
import { PINNED_STRIX_SANDBOX_IMAGE, strixCliArgs, strixEnv, readStrixRunArtifacts } from "../strix-cli.js";
import { parseStrixVulnerabilitiesJson, parseStrixSarif, reconcileStrixFindings } from "./strix-parse.js";
import { redact } from "../redact.js";
import { createLogger } from "../../logger.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const log = createLogger("security");

export const STRIX_CAPABILITIES: EngineCapabilities = {
  id: "strix",
  displayName: "Strix (usestrix/strix)",
  modes: ["sast", "diff"],
  requiresRunningTarget: false,
  supportsDiffScope: true,
  transport: "process",
  license: "Apache-2.0",
};

export interface StrixAdapterDeps {
  runId: string;
  image?: string;
  spawnFn?: SpawnFn;
  secrets?: Record<string, string>; // STRIX_LLM/LLM_API_KEY — flows to the CHILD env only, never disk/argv.
  instruction?: string;
  workdirRoot?: string; // default os.tmpdir()
  makeWorkdir?: () => string; // default mkdtempSync(join(workdirRoot, "essaim-strix-"))
  readRun?: (workdir: string) => { vulnJson?: string; sarif?: string }; // default readStrixRunArtifacts
  cleanup?: (workdir: string) => void; // default rmSync(workdir, {recursive, force})
}

function excerpt(s: string, n = 2000): string {
  const r = redact(s); // redact the FULL string first, then truncate the masked result
  return r.length > n ? r.slice(0, n) + "…[truncated]" : r;
}

export function createStrixAdapter(deps: StrixAdapterDeps): EngineAdapter {
  const image = deps.image ?? PINNED_STRIX_SANDBOX_IMAGE;
  const workdirRoot = deps.workdirRoot ?? tmpdir();
  const makeWorkdir = deps.makeWorkdir ?? (() => mkdtempSync(join(workdirRoot, "essaim-strix-")));
  const readRun = deps.readRun ?? readStrixRunArtifacts;
  const cleanup = deps.cleanup ?? ((workdir: string) => rmSync(workdir, { recursive: true, force: true }));

  return {
    capabilities: STRIX_CAPABILITIES,

    async healthCheck() {
      // Defensive: refuse an obviously-placeholder digest before spawning anything. The real pinned
      // digest (default) won't trigger this.
      if (image.includes("PLACEHOLDER")) {
        return {
          ok: false,
          detail:
            "Strix sandbox image digest is not pinned (PLACEHOLDER) — set a real, license-verified digest (PINNED_STRIX_SANDBOX_IMAGE in src/security/strix-cli.ts) before running a scan.",
        };
      }
      const fail = (e: Error) => ({ code: 1, stdout: "", stderr: e.message, timedOut: false });

      const version = await spawnCaptured("strix", ["--version"], { spawnFn: deps.spawnFn }).catch(fail);
      if (version.code !== 0) {
        return { ok: false, detail: "Strix CLI not found — install with: pip install strix-agent (Python ≥3.12)" };
      }

      const info = await spawnCaptured("docker", ["info"], { spawnFn: deps.spawnFn }).catch(fail);
      if (info.code !== 0) {
        return { ok: false, detail: "Docker backend unavailable (docker info failed) — Strix sandbox cannot run" };
      }

      // Do NOT hard-fail on a missing sandbox image — Strix pulls it on first run.
      return { ok: true, detail: `strix cli ok; docker ok; sandbox ${image}` };
    },

    async run(scope: ResolvedScope, signal: AbortSignal): Promise<EngineRunResult> {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();

      const finish = (partial: Partial<EngineRunResult>): EngineRunResult => ({
        engine: "strix",
        status: "error",
        findings: [],
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        ...partial,
      });

      const workdir = makeWorkdir();
      const env = { ...process.env, ...strixEnv(deps.secrets ?? {}, image) };
      const args = strixCliArgs(scope, { instruction: deps.instruction });

      try {
        let res;
        try {
          res = await spawnCaptured("strix", args, { cwd: workdir, signal, spawnFn: deps.spawnFn, env });
        } catch (err) {
          return finish({ status: "error", error: { kind: "unavailable", message: (err as Error).message, retriable: true } });
        }

        if (res.timedOut) {
          return finish({
            status: "timeout",
            exitCode: res.code ?? undefined,
            stdoutExcerpt: excerpt(res.stdout),
            error: { kind: "timeout", message: "scan timed out", retriable: true },
          });
        }

        const stdoutExcerpt = excerpt(res.stdout);

        if (res.code === 0) {
          return finish({ status: "no_vulns", exitCode: 0, findings: [], stdoutExcerpt });
        }

        if (res.code === 2) {
          const artifacts = readRun(workdir);

          let jsonFindings: ReturnType<typeof parseStrixVulnerabilitiesJson> = [];
          let sarifFindings: ReturnType<typeof parseStrixSarif> = [];
          let jsonThrew = false;
          let sarifThrew = false;

          if (artifacts.vulnJson) {
            try {
              jsonFindings = parseStrixVulnerabilitiesJson(artifacts.vulnJson);
            } catch (err) {
              jsonThrew = true;
              log.error("security: Strix vulnerabilities.json unparseable", { err: (err as Error).message });
            }
          }
          if (artifacts.sarif) {
            try {
              sarifFindings = parseStrixSarif(artifacts.sarif);
            } catch (err) {
              sarifThrew = true;
              log.error("security: Strix findings.sarif unparseable", { err: (err as Error).message });
            }
          }

          const bothMissing = !artifacts.vulnJson && !artifacts.sarif;
          const bothThrew = jsonThrew && sarifThrew;
          const reconciled = reconcileStrixFindings(jsonFindings, sarifFindings);

          // Zero-reads-as-fact guard: exit 2 (vulns) but no usable artifacts → error, NEVER a false clean.
          if (bothMissing || bothThrew || reconciled.length === 0) {
            return finish({
              status: "error",
              exitCode: 2,
              stdoutExcerpt,
              error: { kind: "parse", message: "exit=2 (vulns) but no parseable artifacts in strix_runs", retriable: false },
            });
          }

          return finish({ status: "vulns_found", exitCode: 2, findings: reconciled, stdoutExcerpt });
        }

        // exit 1 or anything else
        return finish({ status: "error", exitCode: res.code ?? undefined, stdoutExcerpt, error: { kind: "crash", message: `Strix exited ${res.code}`, retriable: true } });
      } finally {
        try {
          cleanup(workdir);
        } catch {
          /* best-effort */
        }
      }
    },
  };
}

