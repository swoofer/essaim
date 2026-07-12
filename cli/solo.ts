import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { scanProject } from "../src/orchestrator/scanner.js";
import { listTemplates } from "../src/orchestrator/template-engine.js";
import { buildSolo } from "../src/bridge.js";
import { buildAllowedTools } from "../src/orchestrator/agent-launcher.js";
import type { AgentConfig } from "../src/orchestrator/types.js";
import { collect, parseSetParams, parseSetFileParams, buildParamTypeMap } from "./params.js";

/**
 * Build the argv for `claude -p`.
 *
 * Headless mode cannot answer a permission prompt: without an explicit
 * --allowedTools allowlist the agent's Write hits a prompt nobody can approve
 * and the artifact is silently never written (#34 — `solo gardien` produced its
 * audit in stdout but no AUDIT.md). `run` mode always passed an allowlist; solo
 * did not.
 *
 * Passing `tools` (even empty) rather than `mcpTools` is deliberate: it keeps
 * buildAllowedTools from falling back to the full coordinator tool list for a
 * solo agent that has no coordinator at all.
 */
export function buildSoloArgs(
  prompt: string,
  mcpTools: string[],
  mcpConfigPath: string | null,
): string[] {
  const args = ["-p", prompt];
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }
  args.push("--allowedTools", buildAllowedTools({ tools: mcpTools } as AgentConfig));
  return args;
}

export function createSoloCommand(): Command {
  return new Command("solo")
    .description("Launch a single agent without orchestration")
    .argument("[template]", "Template to use (raid, melee, swarm, ...)")
    .option("-p, --project <path>", "Target project path", ".")
    .option("-t, --timeout <min>", "Timeout in minutes", "15")
    .option("--set <key=value>", "BCE parameter (repeatable)", collect, [])
    .option("--set-file <behavior.param>=<path>", "BCE parameter, value read verbatim from a file (repeatable, wins over --set on conflict)", collect, [])
    .option(
      "--coordinator-url <url>",
      "Use an external coordinator at this URL instead of starting one in-process",
    )
    .action(
      (
        template: string | undefined,
        opts: {
          project: string;
          timeout: string;
          set: string[];
          setFile: string[];
          coordinatorUrl?: string;
        },
      ) => {
        // Resolve projectPath before listing/validating templates so that
        // project-local .essaim/templates/ entries (new ids, not just
        // catalog overrides) are recognized at pre-flight.
        const projectPath = resolve(opts.project);

        // List templates if none specified
        const templates = listTemplates(projectPath);
        if (!template) {
          console.log("\nAvailable templates:\n");
          for (const t of templates) {
            console.log(`  ${t.id.padEnd(14)} ${t.name}`);
            console.log(`  ${"".padEnd(14)} ${t.description}\n`);
          }
          console.log("Usage: essaim solo <template> [-p <path>]");
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

        const context = scanProject(projectPath);

        // Build prompt with solo_mode=true injected automatically
        const setParams = parseSetParams(opts.set, buildParamTypeMap());
        const setFileParams = parseSetFileParams(opts.setFile);
        for (const [behavior, values] of Object.entries(setFileParams)) {
          setParams[behavior] = { ...setParams[behavior], ...values };
        }
        const { prompt, mcpTools } = buildSolo(template, context, setParams, projectPath);

        const mcpConfigPath = resolve(projectPath, ".mcp.json");
        const args = buildSoloArgs(
          prompt,
          mcpTools,
          existsSync(mcpConfigPath) ? mcpConfigPath : null,
        );

        console.log(`\nSolo mode: ${template}`);
        console.log(`  Project:  ${projectPath}`);
        console.log(`  Timeout:  ${opts.timeout} minutes`);
        console.log(`  Prompt:   ${prompt.length} chars`);
        console.log(`  Tools:    ${args[args.indexOf("--allowedTools") + 1]}`);
        console.log(`\nLaunching Claude Code...\n`);

        const child = spawn("claude", args, {
          stdio: "inherit",
          cwd: projectPath,
        });

        // Timeout
        const timeoutMs = parseInt(opts.timeout, 10) * 60 * 1000;
        const timer = setTimeout(() => {
          console.error(
            `\nTimeout: ${opts.timeout} minutes exceeded. Killing agent.`,
          );
          child.kill();
        }, timeoutMs);

        process.on("SIGINT", () => child.kill("SIGINT"));
        process.on("SIGTERM", () => child.kill("SIGTERM"));
        child.on("exit", (code) => {
          clearTimeout(timer);
          process.exit(code ?? 0);
        });
      },
    );
}

