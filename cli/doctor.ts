import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runDoctor, formatDoctorReport, type DoctorDeps } from "../src/orchestrator/doctor.js";
import { resolveClaudeBin } from "../src/agent-loop/claude-stream.js";
import { getCatalogRoots, getBundledRoot } from "./bce-resolver.js";

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
    // `useShell` DOIT refléter comment le binaire tourne au run, sinon la sonde
    // ment : claude est spawné SANS shell (claude-stream.ts) — le sonder avec
    // shell ferait passer un `.cmd` shim npm qui casse au run, et échouerait sur
    // un chemin CLAUDE_BIN à espace (le shell scinde à l'espace) que le run
    // lancerait sans souci. jq/curl passent par des hooks shell → shell:true.
    // On SONDE vraiment (--version) : un binaire présent mais cassé est un faux
    // OK, exactement ce que doctor doit attraper.
    probe(bin, versionArg, useShell) {
      try {
        const r = spawnSync(bin, [versionArg], {
          stdio: "ignore",
          timeout: 10_000,
          shell: useShell,
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
        // getBundledRoot ne vérifie que behaviors/presets/compositions ; on
        // confirme aussi templates/ — sans lui, un run échoue plus loin sur un
        // « Unknown template » opaque, pas ici. (Le message annonce templates/.)
        return existsSync(resolve(getBundledRoot(), "templates"));
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
