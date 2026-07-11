import { Command } from "commander";
import { resolve } from "path";
import { scanProject } from "../src/orchestrator/scanner.js";
import {
  buildProject,
  listTemplates,
} from "../src/orchestrator/template-engine.js";
import { runProject } from "../src/orchestrator/orchestrator.js";
import { writeReport } from "../src/orchestrator/reporter.js";
import { collect, parseSetParams } from "./params.js";
import { loadConfig } from "./config.js";

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
    .option("--set <key=value>", "BCE parameter (repeatable)", collect, [])
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
          url?: string;
          coordinatorUrl?: string;
          baseRef?: string;
          maxQuotaPct?: string;
        },
      ) => {
        // List templates if none specified
        const templates = listTemplates();
        if (!template) {
          console.log("\nAvailable templates:\n");
          for (const t of templates) {
            console.log(`  ${t.id.padEnd(14)} ${t.name}`);
            console.log(`  ${"".padEnd(14)} ${t.description}\n`);
          }
          console.log("Usage: essaim run <template> [-p <path>]");
          return;
        }

        // Validate template
        if (!templates.find((t) => t.id === template)) {
          const available = templates.map((t) => t.id).join(", ");
          console.error(
            `Unknown template '${template}'. Available: ${available}`,
          );
          process.exit(1);
        }

        const projectPath = resolve(opts.project);
        const context = scanProject(projectPath);

        // --modules overrides the scanner's discovery. Use when the project
        // structure doesn't match scanner expectations (e.g. modules are
        // src/features/<slice> not src/<top>) or when you want to run a
        // template on a specific subset of modules (e.g. Phase 2 batch V1
        // targeting only `shared` + `auth`).
        if (opts.modules) {
          const overrides = opts.modules.split(",").map((s) => s.trim()).filter(Boolean);
          if (overrides.length === 0) {
            console.error("Error: --modules cannot be empty");
            process.exit(1);
          }
          context.modules = overrides;
        }

        if (!context.has_git) {
          console.error(
            "Error: project must be a git repository (needed for worktrees)",
          );
          process.exit(1);
        }
        if (!context.is_clean) {
          console.warn(
            "Warning: project has uncommitted changes. Worktrees will copy dirty state.",
          );
        }

        // Parse options
        const agentCount = opts.agents ? parseInt(opts.agents, 10) : undefined;
        if (agentCount !== undefined && (isNaN(agentCount) || agentCount < 1)) {
          console.error("Error: --agents must be at least 1");
          process.exit(1);
        }

        const setParams = parseSetParams(opts.set);

        // Resolve coordinator URL: --coordinator-url > --url > COORDINATOR_URL env.
        // When none is set explicitly, runProject will start an in-process
        // coordinator (Strategy A). The loadConfig() default is intentionally
        // excluded here so that bare `essaim run` triggers Strategy A rather
        // than assuming an external server at localhost:3100.
        loadConfig(); // ensure config warning is shown (side-effect only)
        if (opts.url && !opts.coordinatorUrl) {
          console.warn("⚠️  --url is deprecated; use --coordinator-url instead");
        }
        const resolvedCoordinatorUrl =
          opts.coordinatorUrl ??
          opts.url ??
          process.env.COORDINATOR_URL;

        // Build project — pass projectPath so .essaim/templates/ overrides apply
        const project = buildProject(template, context, {
          agentCount,
          setParams,
        }, projectPath);

        // Apply overrides
        if (opts.timeout) {
          project.timeout_minutes = parseInt(opts.timeout, 10);
        }
        if (opts.baseRef) {
          project.workspace.baseRef = opts.baseRef;
          console.log(`Sandbox mode: worktrees will snapshot ${opts.baseRef} (not HEAD)`);
        }

        if (opts.dryRun) {
          console.log(`\n=== Dry Run: ${project.name} ===\n`);
          console.log("Agents:");
          for (const agent of project.agents) {
            console.log(
              `  ${agent.id.padEnd(25)} ${agent.name} (${agent.profile})`,
            );
            console.log(
              `  ${"".padEnd(25)} Prompt: ${agent.prompt.length} chars`,
            );
          }
          console.log(`\nWorkspace:  ${project.workspace.type}`);
          console.log(
            `Stagger:    ${project.stagger.mode}${project.stagger.delay ? ` [${project.stagger.delay.join("-")}s]` : ""}`,
          );
          console.log(
            `Timeout:    ${project.timeout_minutes || 15} minutes`,
          );
          return;
        }

        const result = await runProject(
          project,
          "with_coordinator",
          opts.cleanup,
          {
            maxQuotaPct: opts.maxQuotaPct ? Number(opts.maxQuotaPct) : undefined,
            coordinatorUrl: resolvedCoordinatorUrl,
          },
        );
        writeReport([result], "reports");
        // Force exit to release the in-process coordinator's HTTP server
        // (startServer does not expose a .close() handle).
        process.exit(0);
      },
    );
}

