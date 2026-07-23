import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport } from "../../src/orchestrator/reporter.js";
import type { RunResult } from "../../src/orchestrator/types.js";

function baseResult(over: Partial<RunResult> = {}): RunResult {
  return {
    project_id: "p", project_name: "proj", mode: "with_coordinator", duration_ms: 1000,
    coordinator_metrics: {
      agents_count: 1, duration_total_ms: 1000, threads_opened: 0, threads_resolved_consensus: 0,
      threads_auto_resolved: 0, messages_exchanged: 0, conflicts_by_layer: {}, introspections_triggered: 0,
      introspections_concerned: 0, avg_resolution_time_ms: 0, hot_files: [],
    },
    agent_results: [], custom_metrics: {}, ...over,
  };
}

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeReport — security section", () => {
  it("renders a Moteur de sécurité section when RunResult.security is present", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-"));
    const result = baseResult({
      security: {
        engine: "strix", status: "vulns_found",
        findingsBySeverity: { critical: 0, high: 2, medium: 1, low: 0, info: 0 },
        ingested: 3, verified: 2, reopened: 1, falsePositives: 0, degraded: false,
        durationMs: 142000, exitCode: 2, engineVersion: "1.3.1", license: "Apache-2.0",
        imageDigest: "sha256:abc", outOfScopeDropped: 4, suppressed: 1,
      },
    });
    const md = readFileSync(writeReport([result], dir), "utf8");
    expect(md).toContain("### Moteur de sécurité"); // nested under the project block
    expect(md).toContain("strix");
    expect(md).toContain("Apache-2.0");
    expect(md).toContain("2 verified");
    expect(md).toContain("1 reopened");
    expect(md).toContain("high");
  });

  it("omits the section entirely for a non-security run", () => {
    dir = mkdtempSync(join(tmpdir(), "rep-"));
    const md = readFileSync(writeReport([baseResult()], dir), "utf8");
    expect(md).not.toContain("Moteur de sécurité");
  });
});
