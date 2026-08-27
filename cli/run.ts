import { Command } from "commander";
import { listTemplates } from "../src/orchestrator/template-engine.js";
import { resolve } from "path";
import { collect, parseSetParams, parseSetFileParams, buildParamTypeMap } from "./params.js";
import { executeRun } from "./run-core.js";
import type { RunResult } from "../src/orchestrator/types.js";

/**
 * Code de sortie de `essaim run` : 1 seulement si TOUS les agents ont échoué.
 *
 * Une défaillance partielle est le régime normal d'un essaim — un rapport réel
 * a montré 2 agents sur 4 en exit 1 pendant que les deux autres livraient leur
 * diff. Sortir non nul là-dessus rendrait la commande inutilisable en CI.
 *
 * Deux garde-fous :
 * - `undefined` = dry-run (executeRun ne retourne rien), donc 0 ;
 * - zéro agent = 0, parce que `[].every()` vaut `true` et signalerait à tort
 *   un échec pour un run qui n'a jamais eu l'intention de lancer un agent.
 *
 * Le prédicat lit `exit_code` et non `exit_reason` : un agent jamais démarré
 * (orchestrator.ts:574-575) a bien exit_code 1 mais aucun exit_reason.
 * Attention au sens exact de « échec » : exit_code vaut 1 dès que
 * exitReason !== "done" (orchestrator.ts:532), ce qui inclut "max_turns"
 * (budget de tours épuisé, agent-loop.ts:1337) et "yielded" (retrait
 * délibéré pendant la coordination, agent-loop.ts:910) — des issues où du
 * travail a pu être livré. On sort quand même 1 : le contrat est « aucun
 * agent n'a terminé proprement », pas « tout a planté ». C'est exactement
 * ce que la colonne Raison sert à désambiguïser.
 *
 * Cette fonction ne concerne QUE `essaim run`. `essaim security` garde son
 * propre contrat (securityExitCode, cli/security.ts:90) et `essaim pipeline`
 * le sien (pipeline.ts:108) — voir l'étape de vérification.
 */
export function runExitCode(result: RunResult | undefined): 0 | 1 {
  if (!result || result.agent_results.length === 0) return 0;
  return result.agent_results.every((a) => a.exit_code !== 0) ? 1 : 0;
}

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

        let result: RunResult | undefined;
        try {
          result = await executeRun({
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
        const code = runExitCode(result);
        if (code !== 0) {
          console.error(
            `Aucun agent n'a terminé proprement : les ${result?.agent_results.length ?? 0} agents ont un exit_code non nul — voir la colonne Raison du rapport (error, process_died, mais aussi max_turns ou yielded).`,
          );
        }
        // Force exit to release the in-process coordinator's HTTP server
        // (startServer does not expose a .close() handle).
        process.exit(code);
      },
    );
}

