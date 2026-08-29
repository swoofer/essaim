import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { runDoctor, formatDoctorReport, type DoctorDeps } from "../src/orchestrator/doctor.js";
import { resolveClaudeBin } from "../src/agent-loop/claude-stream.js";
import { getCatalogRoots } from "./bce-resolver.js";

/** Test de port bloquant et synchrone : un mini-serveur via un sous-processus
 *  node (`node -e`). Synchrone parce que runDoctor l'est ; le bind local resout
 *  en quelques ms. Exit 0 = port libre, 1 = occupe. */
function probePortSync(port: number): boolean {
  const code = `const net=require('net');const s=net.createServer();s.once('error',()=>process.exit(1));s.once('listening',()=>s.close(()=>process.exit(0)));s.listen(${port},'127.0.0.1');`;
  const r = spawnSync(process.execPath, ["-e", code], { stdio: "ignore", timeout: 5_000 });
  return r.status === 0;
}

/** DoctorDeps câblées sur le vrai système. Séparées de runDoctor pour que la
 *  logique de diagnostic reste testable sans toucher au systeme. */
export function realDoctorDeps(projectPath?: string): DoctorDeps {
  return {
    // shell:true seulement sous win32 (claude/jq/curl peuvent etre des .cmd) ;
    // ailleurs on evite le shell. On SONDE vraiment le binaire (--version), on
    // ne se contente pas de le trouver : un binaire present mais casse est un
    // faux OK — exactement ce que doctor doit attraper.
    probe(bin, versionArg) {
      try {
        const r = spawnSync(bin, [versionArg], {
          stdio: "ignore",
          timeout: 10_000,
          shell: process.platform === "win32",
        });
        return r.status === 0;
      } catch {
        return false;
      }
    },
    resolveClaudeBin,
    portFree: probePortSync,
    catalogOk() {
      try {
        getCatalogRoots({ projectPath });
        return true;
      } catch {
        return false;
      }
    },
    platform: process.platform,
    coordinatorUrl: process.env.COORDINATOR_URL,
  };
}

export function createDoctorCommand(): Command {
  return new Command("doctor")
    .description("Vérifie les dépendances (Claude Code, catalogue, ports, jq/curl) avant un run")
    .option("-p, --project <path>", "Chemin du projet (pour localiser un catalogue de .essaim/)")
    .action((opts: { project?: string }) => {
      const report = runDoctor(realDoctorDeps(opts.project));
      console.log(formatDoctorReport(report));
      // Code de sortie non nul si un critique echoue : cablable dans un script.
      process.exit(report.ok ? 0 : 1);
    });
}
