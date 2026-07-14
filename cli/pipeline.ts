import { Command } from "commander";
import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, resolve, join } from "path";
import { loadPipeline, type PipelineDef } from "../src/pipeline/schema.js";
import {
  runPipelineDef,
  type PipelineDeps,
  type PipelineShared,
  type StepOutcome,
} from "../src/pipeline/runner.js";
import { executeRun } from "./run-core.js";
import { uniqueReportBase } from "../src/orchestrator/reporter.js";
import { parseSetParams, parseSetFileParams, buildParamTypeMap } from "./params.js";

export function createPipelineCommand(): Command {
  return new Command("pipeline")
    .description("Run a sequence of template runs across per-step repos (see #36)")
    .requiredOption("-f, --file <path>", "Pipeline YAML file")
    .option(
      "--coordinator-url <url>",
      "Use an external coordinator at this URL, shared across all steps",
    )
    .option("--max-quota-pct <pct>", "Abort a step's pre-flight at/above this quota %")
    .option("--dry-run", "Preview each step without launching agents")
    .action(
      async (opts: {
        file: string;
        coordinatorUrl?: string;
        maxQuotaPct?: string;
        dryRun?: boolean;
      }) => {
        const filePath = resolve(opts.file);
        const pipelineDir = dirname(filePath);

        let def: PipelineDef;
        try {
          def = loadPipeline(filePath);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
          return;
        }

        // Resolve per-step project paths relative to the pipeline file's dir so
        // that both executeRun (cwd/scan) and hook cwds are absolute.
        const resolvedDef: PipelineDef = {
          name: def.name,
          steps: def.steps.map((s) => ({
            ...s,
            project: resolve(pipelineDir, s.project),
          })),
        };

        const shared: PipelineShared = {
          coordinatorUrl: opts.coordinatorUrl,
          maxQuotaPct: opts.maxQuotaPct ? Number(opts.maxQuotaPct) : undefined,
          dryRun: opts.dryRun,
        };

        const deps: PipelineDeps = {
          runStep: async (step, sh) => {
            // Merge set + set_file (set_file wins). set_file paths are relative
            // to the pipeline file's dir.
            const setParams = parseSetParams(
              Object.entries(step.set ?? {}).map(([k, v]) => `${k}=${v}`),
              buildParamTypeMap(),
            );
            const setFileParams = parseSetFileParams(
              Object.entries(step.set_file ?? {}).map(
                ([k, v]) => `${k}=${resolve(pipelineDir, v)}`,
              ),
            );
            for (const [behavior, values] of Object.entries(setFileParams)) {
              setParams[behavior] = { ...setParams[behavior], ...values };
            }

            await executeRun({
              template: step.template,
              project: step.project, // already absolute
              agentCount: step.agents,
              timeout: step.timeout_minutes,
              modules: step.modules,
              setParams,
              coordinatorUrl: sh.coordinatorUrl,
              maxQuotaPct: sh.maxQuotaPct,
              dryRun: sh.dryRun,
              catalogs: def.catalog,
            });
          },
          execHook: (cmd, cwd) => {
            const r = spawnSync(cmd, { shell: true, cwd, encoding: "utf-8" });
            const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
            // A spawn error (e.g. shell missing) surfaces as status null → treat non-zero.
            const code = r.status ?? (r.error ? 1 : 0);
            return { code, output };
          },
          log: (msg) => console.log(msg),
        };

        console.log(`\n=== Pipeline: ${resolvedDef.name} (${resolvedDef.steps.length} steps) ===\n`);
        const { outcomes, ok } = await runPipelineDef(resolvedDef, shared, deps);

        const reportPath = writePipelineReport(resolvedDef.name, pipelineDir, outcomes);
        console.log(`\nPipeline report: ${reportPath}`);
        console.log(ok ? "Pipeline OK" : "Pipeline FAILED");

        process.exit(ok ? 0 : 1);
      },
    );
}

function writePipelineReport(
  pipelineName: string,
  pipelineDir: string,
  outcomes: StepOutcome[],
): string {
  const outDir = join(pipelineDir, "reports");
  mkdirSync(outDir, { recursive: true });
  // Two steps finishing in the same millisecond used to overwrite each other's
  // report — the timestamp alone is not a unique name.
  const base = uniqueReportBase(outDir, `pipeline-${pipelineName}-${Date.now()}`, [".md"]);
  const mdPath = join(outDir, `${base}.md`);

  const total = outcomes.reduce((a, o) => a + o.durationMs, 0);
  const okCount = outcomes.filter((o) => o.status === "ok").length;
  const failCount = outcomes.filter((o) => o.status === "failed").length;
  const skipCount = outcomes.filter((o) => o.status === "skipped").length;

  let md = `# Pipeline Report — ${pipelineName}\n\n*${new Date().toISOString()}*\n\n`;
  md += `| Step | Status | Duration | Hook failures |\n`;
  md += `|------|--------|----------|---------------|\n`;
  for (const o of outcomes) {
    const hooks = o.hookFailures.length ? o.hookFailures.map((h) => `\`${h}\``).join(", ") : "-";
    md += `| ${o.name} | ${statusLabel(o.status)} | ${(o.durationMs / 1000).toFixed(1)}s | ${hooks} |\n`;
  }
  md += `\n**Totals:** ${okCount} ok, ${failCount} failed, ${skipCount} skipped — ${(total / 1000).toFixed(1)}s\n`;

  const failed = outcomes.filter((o) => o.status === "failed" && o.error);
  if (failed.length > 0) {
    md += `\n## Failures\n\n`;
    for (const o of failed) {
      md += `### ${o.name}\n\n\`\`\`\n${o.error}\n\`\`\`\n\n`;
    }
  }

  writeFileSync(mdPath, md);
  return mdPath;
}

function statusLabel(s: StepOutcome["status"]): string {
  if (s === "ok") return "OK";
  if (s === "failed") return "FAILED";
  return "skipped";
}
