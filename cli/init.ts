import { Command } from "commander";
import { resolve } from "path";
import { setupProject } from "../src/orchestrator/orchestrator.js";

export function createInitCommand(): Command {
  return new Command("init")
    .description("Setup coordination in a project")
    .argument("[path]", "Project path", ".")
    .option("--url <url>", "Coordinator URL", "http://localhost:3100")
    .option("--name <name>", "Agent name", process.env.USER || "developer")
    .option("--modules <list>", "Comma-separated modules", "")
    .option("--security", "Also scaffold security config + .gitignore")
    .action((pathArg: string, opts: { url: string; name: string; modules: string; security?: boolean }) => {
      const projectPath = resolve(pathArg);
      setupProject(projectPath, opts);
      if (opts.security) {
        // dynamic import keeps the security module out of the base init path
        import("../src/security/setup.js")
          .then(({ setupSecurity }) => setupSecurity(projectPath))
          .catch((err) => {
            console.error(`Security setup failed: ${err instanceof Error ? err.message : err}`);
            process.exitCode = 1;
          });
      }
    });
}

