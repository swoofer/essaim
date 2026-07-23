// src/security/scan.ts — fan out across engine adapters; never throw for engine failure.
import type { AdapterRegistry, EngineId, EngineRunResult, Finding, ResolvedScope } from "./types.js";
import { createRegistry } from "./registry.js";
import { createStrixAdapter } from "./adapters/strix.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

export interface ScanResult {
  results: EngineRunResult[];
  findings: Finding[];
  degraded: boolean;
}

/** Register the v1 engines (Strix). Widen here as engines ship. */
export function createDefaultRegistry(deps: { runId: string; envFile?: string }): AdapterRegistry {
  const reg = createRegistry();
  reg.register(createStrixAdapter({ runId: deps.runId, envFile: deps.envFile }));
  return reg;
}

const SUCCESS = new Set<EngineRunResult["status"]>(["no_vulns", "vulns_found"]);

export async function runSecurityScan(
  registry: AdapterRegistry,
  engineIds: EngineId[],
  scope: ResolvedScope,
  signal: AbortSignal,
): Promise<ScanResult> {
  const adapters = registry.resolve(engineIds); // throws on unknown engine (fail-closed config error)
  const settled = await Promise.allSettled(adapters.map((a) => a.run(scope, signal)));

  const results: EngineRunResult[] = [];
  const findings: Finding[] = [];
  let degraded = false;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      const r = s.value;
      results.push(r);
      findings.push(...r.findings);
      if (!SUCCESS.has(r.status)) {
        degraded = true;
        log.warn(`security: engine ${r.engine} degraded (status=${r.status})`);
      }
    } else {
      // adapter.run() should never reject; if it does, treat as a degraded error result.
      degraded = true;
      const id = adapters[i].capabilities.id;
      log.error(`security: engine ${id} threw`, { err: String(s.reason) });
      results.push({
        engine: id,
        status: "error",
        findings: [],
        startedAt: "",
        finishedAt: "",
        durationMs: 0,
        error: { kind: "crash", message: String(s.reason), retriable: true },
      });
    }
  }
  return { results, findings, degraded };
}
