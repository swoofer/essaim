// src/security/adapters/strix.ts — the one real EngineAdapter. Arm's-length via docker run.
import { randomUUID } from "node:crypto";
import type { EngineAdapter, EngineCapabilities, EngineRunResult, ResolvedScope } from "../types.js";
import { spawnCaptured, type SpawnFn } from "./base.js";
import { PINNED_STRIX_IMAGE, containerName, dockerMountArg, dockerRunArgs, dockerInspectArgs } from "../docker.js";
import { parseStrixReport, toFinding, StrixParseError } from "./strix-parse.js";
import { redact } from "../redact.js";
import { createLogger } from "../../logger.js";

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
  envFile?: string; // temp 0600 env-file with LLM_API_KEY/STRIX_LLM (written by the caller)
  instruction?: string;
}

function excerpt(s: string, n = 2000): string {
  const r = redact(s); // redact the FULL string first, then truncate the masked result
  return r.length > n ? r.slice(0, n) + "…[truncated]" : r;
}

export function createStrixAdapter(deps: StrixAdapterDeps): EngineAdapter {
  const image = deps.image ?? PINNED_STRIX_IMAGE;
  const name = containerName(deps.runId);

  return {
    capabilities: STRIX_CAPABILITIES,

    async healthCheck() {
      // Refuse the placeholder digest before touching docker at all — misdirecting the operator to
      // `docker pull` an unpinned/unverified image would be worse than a clear config error.
      if (image.includes("PLACEHOLDER_DIGEST")) {
        return {
          ok: false,
          detail:
            "Strix image digest is not pinned (PLACEHOLDER_DIGEST) — set a real, license-verified digest in src/security/docker.ts (PINNED_STRIX_IMAGE) before running a scan.",
        };
      }
      // Docker backend + pinned image both present. (Real invocation happens in run().)
      const fail = (e: Error) => ({ code: 1, stdout: "", stderr: e.message, timedOut: false });
      const info = await spawnCaptured("docker", ["info"], { spawnFn: deps.spawnFn }).catch(fail);
      if (info.code !== 0) {
        return { ok: false, detail: "Docker backend unavailable (docker info failed) — Strix cannot run" };
      }
      const inspect = await spawnCaptured("docker", dockerInspectArgs(image), { spawnFn: deps.spawnFn }).catch(fail);
      if (inspect.code !== 0) {
        return { ok: false, detail: `Strix image not present locally (${image}) — pull the pinned digest first` };
      }
      return { ok: true, detail: `docker ok; image ${image}` };
    },

    async run(scope: ResolvedScope, signal: AbortSignal): Promise<EngineRunResult> {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      const args = dockerRunArgs({
        image,
        containerName: name,
        mount: dockerMountArg(scope.targetPath),
        envFile: deps.envFile,
        target: "/src",
        scanMode: scope.scanMode,
        scopeMode: scope.mode,
        diffBase: scope.diffBase,
        instruction: deps.instruction ?? `Scan /src. ${scope.mode === "diff" ? `Only changes since ${scope.diffBase}.` : "Full tree."}`,
      });

      const finish = (partial: Partial<EngineRunResult>): EngineRunResult => ({
        engine: "strix",
        status: "error",
        findings: [],
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        ...partial,
      });

      let res;
      try {
        res = await spawnCaptured("docker", args, { signal, spawnFn: deps.spawnFn });
      } catch (err) {
        return finish({ status: "error", error: { kind: "unavailable", message: (err as Error).message, retriable: true } });
      }

      if (res.timedOut) {
        // best-effort container teardown
        await spawnCaptured("docker", ["kill", name], { spawnFn: deps.spawnFn }).catch(() => undefined);
        return finish({ status: "timeout", exitCode: res.code ?? undefined, stdoutExcerpt: excerpt(res.stdout), error: { kind: "timeout", message: "scan timed out", retriable: true } });
      }

      const stdoutExcerpt = excerpt(res.stdout);

      if (res.code === 0) {
        return finish({ status: "no_vulns", exitCode: 0, findings: [], stdoutExcerpt });
      }
      if (res.code === 2) {
        let raws;
        try {
          raws = parseStrixReport(res.stdout);
        } catch (err) {
          // zero-reads-as-fact guard: exit 2 but unparseable → error, NEVER a false clean.
          log.error("security: Strix exit=2 but report unparseable", { err: (err as Error).message });
          return finish({ status: "error", exitCode: 2, stdoutExcerpt, error: { kind: "parse", message: (err as Error).message, retriable: false } });
        }
        if (raws.length === 0) {
          return finish({ status: "error", exitCode: 2, stdoutExcerpt, error: { kind: "parse", message: "exit=2 (vulns) but zero findings parsed", retriable: false } });
        }
        const findings = raws.map((r) => toFinding(r, randomUUID()));
        return finish({ status: "vulns_found", exitCode: 2, findings, stdoutExcerpt });
      }
      // exit 1 or anything else
      return finish({ status: "error", exitCode: res.code ?? undefined, stdoutExcerpt, error: { kind: "crash", message: `Strix exited ${res.code}`, retriable: true } });
    },
  };
}
