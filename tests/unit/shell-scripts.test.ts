// tests/unit/shell-scripts.test.ts
//
// Les hooks d'essaim sont du shell, et leurs tests l'étaient aussi — mais
// personne ne les lançait : `npm test` appelle vitest, qui ne connaît que
// tests/**/*.test.ts. tests/track_activity_secret_filtering.test.sh dormait
// donc depuis sa création, et le défaut de normalisation de chemin (#100) a pu
// vivre sans que rien ne s'en aperçoive.
//
// Ce fichier fait le pont : chaque tests/*.test.sh devient un cas vitest, donc
// tourne en CI comme le reste.
import { describe, it, expect } from "vitest";
import { execFileSync, execFileSync as run } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const TESTS_DIR = resolve(import.meta.dirname, "..");
const SCRIPTS = readdirSync(TESTS_DIR).filter((f) => f.endsWith(".test.sh"));

function bashAvailable(): boolean {
  try {
    execFileSync("bash", ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_BASH = bashAvailable();

describe("scripts shell", () => {
  it("trouve au moins un test shell à lancer", () => {
    // Garde contre le faux vert : si le glob cassait, le describe ci-dessous
    // serait vide et passerait sans rien exercer.
    expect(SCRIPTS.length).toBeGreaterThan(0);
  });

  for (const script of SCRIPTS) {
    it.skipIf(!HAS_BASH)(script, () => {
      // Sortie capturée puis rattachée à l'échec : sans ça, un test shell qui
      // rate ne dit que « exit 1 » et il faut le relancer à la main pour savoir
      // lequel de ses cas est tombé.
      let output = "";
      let failed = false;
      try {
        output = run("bash", [join(TESTS_DIR, script)], { encoding: "utf-8", stdio: "pipe" });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        failed = true;
      }
      expect(failed ? output : "").toBe("");
    });
  }
});
