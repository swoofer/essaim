import { Command } from "commander";
import { resolve } from "path";
import { listTemplates } from "../src/orchestrator/template-engine.js";
import { collect } from "./params.js";

export function createListCommand(): Command {
  return new Command("list")
    .description("List available templates")
    // Sans ces deux options, `list` n'affiche que les templates bundlés — il dirait
    // donc ne pas savoir faire ce que `run` sait faire. Une divergence entre ce que
    // l'outil annonce et ce qu'il exécute est un piège en soi.
    .option("-p, --project <path>", "Project path (pour voir les templates de son .essaim/)")
    .option("--catalog <path>", "Catalogue externe — répétable, le dernier gagne", collect, [])
    .action((opts: { project?: string; catalog: string[] }) => {
      const templates = listTemplates(
        opts.project ? resolve(opts.project) : undefined,
        { catalogs: opts.catalog },
      );
      console.log("\nTemplates disponibles:\n");
      for (const t of templates) {
        console.log(`  ${t.id.padEnd(14)} ${t.name}`);
        console.log(`  ${"".padEnd(14)} ${t.description}\n`);
      }
    });
}
