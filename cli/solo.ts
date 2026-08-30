import { Command } from "commander";
import { resolve } from "path";
import { existsSync } from "fs";
import { spawn, type ChildProcess } from "child_process";
import { scanProject } from "../src/orchestrator/scanner.js";
import { listTemplates } from "../src/orchestrator/template-engine.js";
import { buildSolo } from "../src/bridge.js";
import { buildAllowedTools } from "../src/orchestrator/agent-launcher.js";
import { resolveClaudeBin } from "../src/agent-loop/claude-stream.js";
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
  readOnly = false,
): string[] {
  const args = ["-p", prompt];
  if (mcpConfigPath) {
    args.push("--mcp-config", mcpConfigPath);
  }
  // solo n'utilise PAS --dangerously-skip-permissions : en headless `-p`, un
  // outil hors allowlist est refuse. L'allowlist EST donc le verrou ici, et
  // read_only en retire Write/Edit/Bash (DF4). Le read_only vient du preset
  // (buildSolo le derive de la presence du behavior read-only-mode).
  args.push("--allowedTools", buildAllowedTools({ tools: mcpTools, read_only: readOnly } as AgentConfig));
  return args;
}

export interface SoloLaunchDeps {
  spawn: (cmd: string, args: string[], opts: { stdio: "inherit"; cwd: string }) => ChildProcess;
  resolveClaudeBin: () => string;
  exit: (code: number) => void;
  /** Enregistre un handler de signal ; injecté pour ne pas polluer process en test. */
  onSignal?: (sig: "SIGINT" | "SIGTERM", cb: () => void) => void;
}

/**
 * Lance `claude -p` pour un run solo et gère timeout / erreurs / signaux (#150).
 * Extrait du `.action` pour être testable. Garanties du chantier :
 *  - claude absent/non lançable -> UNE ligne d'erreur ACTIONNABLE sur stderr +
 *    exit 1, jamais un stack trace nu (spawn peut lever EINVAL SYNCHRONE pour un
 *    .cmd, ou émettre 'error' ENOENT en async — les deux sont attrapés) ;
 *  - ZÉRO octet écrit sur stdout ici : stdout reste réservé à la sortie de
 *    l'agent (stdio: "inherit"). Les diagnostics vont sur stderr ;
 *  - le binaire vient de resolveClaudeBin (honore CLAUDE_BIN).
 */
export function launchSolo(args: string[], cwd: string, timeoutMin: number, deps: SoloLaunchDeps): void {
  const claudeBin = deps.resolveClaudeBin();
  const fail = (msg: string) => {
    console.error(
      `Impossible de lancer claude (${claudeBin}) : ${msg}. ` +
        `Installez Claude Code, ou définissez CLAUDE_BIN vers un vrai claude.`,
    );
    deps.exit(1);
  };
  let child: ChildProcess;
  try {
    child = deps.spawn(claudeBin, args, { stdio: "inherit", cwd });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e)); // spawn(.cmd) sans shell = EINVAL synchrone
    return;
  }

  const timer = setTimeout(() => {
    console.error(`\nTimeout: ${timeoutMin} minutes exceeded. Killing agent.`);
    child.kill();
  }, timeoutMin * 60 * 1000);

  const onSignal = deps.onSignal ?? ((s, cb) => { process.on(s, cb); });
  onSignal("SIGINT", () => child.kill("SIGINT"));
  onSignal("SIGTERM", () => child.kill("SIGTERM"));

  child.on("error", (err: NodeJS.ErrnoException) => {
    clearTimeout(timer);
    fail(err.message); // ex. ENOENT : claude absent du PATH
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    deps.exit(code ?? 0);
  });
}

export function createSoloCommand(): Command {
  return new Command("solo")
    .description("Launch a single agent without orchestration")
    .argument("[template]", "Template to use (raid, melee, swarm, ...)")
    .option("-p, --project <path>", "Target project path", ".")
    .option("-t, --timeout <min>", "Timeout in minutes", "15")
        .option("--catalog <path>", "Catalogue externe (behaviors/presets/compositions/templates) — répétable, le dernier gagne", collect, [])
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
          catalog: string[];
        },
      ) => {
        // Resolve projectPath before listing/validating templates so that
        // project-local .essaim/templates/ entries (new ids, not just
        // catalog overrides) are recognized at pre-flight.
        const projectPath = resolve(opts.project);

        // List templates if none specified
        const templates = listTemplates(projectPath, { catalogs: opts.catalog });
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
        const setParams = parseSetParams(opts.set, buildParamTypeMap({ catalogs: opts.catalog, projectPath }));
        const setFileParams = parseSetFileParams(opts.setFile);
        for (const [behavior, values] of Object.entries(setFileParams)) {
          setParams[behavior] = { ...setParams[behavior], ...values };
        }
        const { prompt, mcpTools, read_only } = buildSolo(template, context, setParams, projectPath, opts.catalog);

        const mcpConfigPath = resolve(projectPath, ".mcp.json");
        const args = buildSoloArgs(
          prompt,
          mcpTools,
          existsSync(mcpConfigPath) ? mcpConfigPath : null,
          read_only,
        );

        // Diagnostics sur STDERR : stdout est réservé à la sortie de l'agent, donc
        // « 0 octet de prompt sur stdout » quand claude est absent (#150). On
        // n'imprime que la LONGUEUR du prompt, jamais son contenu.
        console.error(`\nSolo mode: ${template}`);
        console.error(`  Project:  ${projectPath}`);
        console.error(`  Timeout:  ${opts.timeout} minutes`);
        console.error(`  Prompt:   ${prompt.length} chars`);
        console.error(`  Tools:    ${args[args.indexOf("--allowedTools") + 1]}`);
        console.error(`\nLaunching Claude Code...\n`);

        launchSolo(args, projectPath, parseInt(opts.timeout, 10), {
          spawn,
          resolveClaudeBin, // honore CLAUDE_BIN
          exit: (code) => process.exit(code),
        });
      },
    );
}

