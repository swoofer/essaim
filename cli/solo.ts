import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";
import { scanProject } from "../src/orchestrator/scanner.js";
import { listTemplates } from "../src/orchestrator/template-engine.js";
import { buildSoloPrompt } from "../src/bridge.js";
import { collect, parseSetParams } from "./params.js";

export function createSoloCommand(): Command {
  return new Command("solo")
    .description("Launch a single agent without orchestration")
    .argument("[template]", "Template to use (raid, melee, swarm, ...)")
    .option("-p, --project <path>", "Target project path", ".")
    .option("-t, --timeout <min>", "Timeout in minutes", "15")
    .option("--set <key=value>", "BCE parameter (repeatable)", collect, [])
    .option(
      "--coordinator-url <url>",
      "Use an external coordinator at this URL instead of starting one in-process",
    )
    .action(
      (
        template: string | undefined,
        opts: { project: string; timeout: string; set: string[]; coordinatorUrl?: string },
      ) => {
        // List templates if none specified
        const templates = listTemplates();
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

        const projectPath = resolve(opts.project);
        const context = scanProject(projectPath);

        // Build prompt with solo_mode=true injected automatically
        const setParams = parseSetParams(opts.set);
        const prompt = buildSoloPrompt(template, context, setParams, projectPath);

        console.log(`\nSolo mode: ${template}`);
        console.log(`  Project:  ${projectPath}`);
        console.log(`  Timeout:  ${opts.timeout} minutes`);
        console.log(`  Prompt:   ${prompt.length} chars`);
        console.log(`\nLaunching Claude Code...\n`);

        // Build claude args
        const args = ["-p", prompt];
        const mcpConfigPath = resolve(projectPath, ".mcp.json");
        if (existsSync(mcpConfigPath)) {
          args.push("--mcp-config", mcpConfigPath);
        }

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

