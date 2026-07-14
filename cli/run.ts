import { Command } from "commander";
import { listTemplates } from "../src/orchestrator/template-engine.js";
import { resolve } from "path";
import { collect, parseSetParams, parseSetFileParams, buildParamTypeMap } from "./params.js";
import { executeRun } from "./run-core.js";

export function createRunCommand(): Command {
  return new Command("run")
    .description("Launch coordinated agents via a template")
    .argument("[template]", "Template to run (raid, melee, swarm, ...)")
    .option("-p, --project <path>", "Target project path", ".")
    .option("-n, --agents <count>", "Number of agents per dynamic role")
    .option("-t, --timeout <min>", "Timeout in minutes")
    .option("--cleanup", "Remove worktrees after execution")
    .option("--dry-run", "Preview agents and prompts without launching")
    .option("--modules <list>", "Comma-separated module list, overrides scanner discovery. Required for templates using count: 'per-module' when the project layout doesn't match the scanner's expectations.")
        .option("--catalog <path>", "Catalogue externe (behaviors/presets/compositions/templates) — répétable, le dernier gagne", collect, [])
    .option("--set <key=value>", "BCE parameter (repeatable)", collect, [])
    .option("--set-file <behavior.param>=<path>", "BCE parameter, value read verbatim from a file (repeatable, wins over --set on conflict)", collect, [])
    .option("--url <url>", "Coordinator URL (override config, deprecated: use --coordinator-url)")
    .option(
      "--coordinator-url <url>",
      "Use an external coordinator at this URL instead of starting one in-process",
    )
    .option("--base-ref <ref>", "Git ref for worktree snapshot (tag, branch, sha) — use for sandbox testing against a fixed codebase")
    .option("--max-quota-pct <pct>", "Abort pre-flight if Anthropic quota utilization is at/above this % (default 95, also reads MAX_QUOTA_PCT env)")
    .action(
      async (
        template: string | undefined,
        opts: {
          project: string;
          agents?: string;
          timeout?: string;
          cleanup?: boolean;
          dryRun?: boolean;
          modules?: string;
          set: string[];
          setFile: string[];
          url?: string;
          coordinatorUrl?: string;
          baseRef?: string;
          maxQuotaPct?: string;
          catalog: string[];
        },
      ) => {
        // List templates if none specified. Resolve projectPath first so that
        // project-local .essaim/templates/ entries are recognized at pre-flight.
        if (!template) {
          const projectPath = resolve(opts.project);
          const templates = listTemplates(projectPath, { catalogs: opts.catalog });
          console.log("\nAvailable templates:\n");
          for (const t of templates) {
            console.log(`  ${t.id.padEnd(14)} ${t.name}`);
            console.log(`  ${"".padEnd(14)} ${t.description}\n`);
          }
          console.log("Usage: essaim run <template> [-p <path>]");
          return;
        }

        // Merge --set + --set-file (set-file wins on conflict).
        const setParams = parseSetParams(opts.set, buildParamTypeMap({ catalogs: opts.catalog, projectPath: resolve(opts.project) }));
        const setFileParams = parseSetFileParams(opts.setFile);
        for (const [behavior, values] of Object.entries(setFileParams)) {
          setParams[behavior] = { ...setParams[behavior], ...values };
        }

        // Resolve coordinator URL: --coordinator-url > --url (deprecated).
        // The COORDINATOR_URL env fallback is applied inside executeRun.
        if (opts.url && !opts.coordinatorUrl) {
          console.warn("⚠️  --url is deprecated; use --coordinator-url instead");
        }

        try {
          await executeRun({
            template,
            project: opts.project,
            agentCount: opts.agents ? parseInt(opts.agents, 10) : undefined,
            timeout: opts.timeout ? parseInt(opts.timeout, 10) : undefined,
            cleanup: opts.cleanup,
            dryRun: opts.dryRun,
            modules: opts.modules
              ? opts.modules.split(",").map((s) => s.trim()).filter(Boolean)
              : undefined,
            setParams,
            coordinatorUrl: opts.coordinatorUrl ?? opts.url,
            baseRef: opts.baseRef,
            maxQuotaPct: opts.maxQuotaPct ? Number(opts.maxQuotaPct) : undefined,
            catalogs: opts.catalog,
          });
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }

        if (opts.dryRun) {
          return;
        }
        // Force exit to release the in-process coordinator's HTTP server
        // (startServer does not expose a .close() handle).
        process.exit(0);
      },
    );
}

