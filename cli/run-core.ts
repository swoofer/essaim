import { resolve } from "path";
import { scanProject } from "../src/orchestrator/scanner.js";
import { buildProject, listTemplates } from "../src/orchestrator/template-engine.js";
import { getCatalogRoots } from "./bce-resolver.js";
import { runProject } from "../src/orchestrator/orchestrator.js";
import { writeReport } from "../src/orchestrator/reporter.js";
import { loadConfig } from "./config.js";
import type { RunResult } from "../src/orchestrator/types.js";

/**
 * Options for a single scan → build → launch run.
 * Shared by `essaim run` and `essaim pipeline` so both use the exact same path.
 * `setParams` is already merged (--set + --set-file, set-file winning) by the caller.
 */
export interface ExecuteRunOptions {
  template: string;
  /** Project path (resolved internally). */
  project: string;
  agentCount?: number;
  timeout?: number;
  cleanup?: boolean;
  dryRun?: boolean;
  /** Already split/trimmed module list; [] triggers the "cannot be empty" error. */
  modules?: string[];
  setParams?: Record<string, Record<string, unknown>>;
  coordinatorUrl?: string;
  baseRef?: string;
  maxQuotaPct?: number;
  /** Catalogues externes (--catalog, répétable). */
  catalogs?: string[];
}

/**
 * Core of `essaim run`: scan the project, build the template into a MiniProject,
 * and launch it (or print the dry-run preview). Throws on pre-flight validation
 * failures (unknown template, non-git project, bad agent count, empty modules)
 * instead of calling process.exit, so callers (pipeline) can record the outcome.
 * Returns the RunResult, or undefined for a dry run.
 */
export async function executeRun(opts: ExecuteRunOptions): Promise<RunResult | undefined> {
  // Resolve projectPath before listing/validating templates so that
  // project-local .essaim/templates/ entries (new ids, not just catalog
  // overrides) are recognized at pre-flight.
  const projectPath = resolve(opts.project);

  const catalogs = opts.catalogs;
  const templates = listTemplates(projectPath, { catalogs });
  if (!templates.find((t) => t.id === opts.template)) {
    const available = templates.map((t) => t.id).join(", ");
    // Lister les catalogues consultés : sans ça, un catalogue oublié (ou mal
    // orthographié dans ESSAIM_CATALOG) ressort en « Unknown template » et on
    // cherche le bug dans le template, jamais dans la résolution.
    const roots = getCatalogRoots({ catalogs, projectPath }).join(", ");
    throw new Error(
      `Unknown template '${opts.template}'. Available: ${available}
Catalogues consultés : ${roots}`,
    );
  }

  const context = scanProject(projectPath);

  // --modules overrides the scanner's discovery.
  if (opts.modules !== undefined) {
    if (opts.modules.length === 0) {
      throw new Error("Error: --modules cannot be empty");
    }
    context.modules = opts.modules;
  }

  if (!context.has_git) {
    throw new Error("Error: project must be a git repository (needed for worktrees)");
  }
  if (!context.is_clean) {
    console.warn(
      "Warning: project has uncommitted changes. Worktrees will copy dirty state.",
    );
  }

  const agentCount = opts.agentCount;
  if (agentCount !== undefined && (isNaN(agentCount) || agentCount < 1)) {
    throw new Error("Error: --agents must be at least 1");
  }

  const setParams = opts.setParams ?? {};

  // Resolve coordinator URL: explicit value > COORDINATOR_URL env.
  // When none is set, runProject starts an in-process coordinator (Strategy A).
  loadConfig(); // ensure config warning is shown (side-effect only)
  const resolvedCoordinatorUrl = opts.coordinatorUrl ?? process.env.COORDINATOR_URL;

  // Build project — pass projectPath so .essaim/templates/ overrides apply
  const project = buildProject(
    opts.template,
    context,
    { agentCount, setParams, catalogs },
    projectPath,
  );

  if (opts.timeout !== undefined) {
    project.timeout_minutes = opts.timeout;
  }
  if (opts.baseRef) {
    project.workspace.baseRef = opts.baseRef;
    console.log(`Sandbox mode: worktrees will snapshot ${opts.baseRef} (not HEAD)`);
  }

  if (opts.dryRun) {
    console.log(`\n=== Dry Run: ${project.name} ===\n`);
    console.log("Agents:");
    for (const agent of project.agents) {
      console.log(`  ${agent.id.padEnd(25)} ${agent.name} (${agent.profile})`);
      console.log(`  ${"".padEnd(25)} Prompt: ${agent.prompt.length} chars`);
    }
    console.log(`\nWorkspace:  ${project.workspace.type}`);
    console.log(
      `Stagger:    ${project.stagger.mode}${project.stagger.delay ? ` [${project.stagger.delay.join("-")}s]` : ""}`,
    );
    console.log(`Timeout:    ${project.timeout_minutes || 15} minutes`);
    return undefined;
  }

  const result = await runProject(project, "with_coordinator", opts.cleanup, {
    maxQuotaPct: opts.maxQuotaPct,
    coordinatorUrl: resolvedCoordinatorUrl,
  });
  writeReport([result], "reports");
  return result;
}
