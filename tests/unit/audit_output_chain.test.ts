// tests/unit/audit_output_chain.test.ts
//
// #177 — vérifie que le hook pre-tool-use ASSEMBLÉ de gardien est composé pour
// que le deny du guard path-scope soit réellement délivré. C'est le pendant
// statique du test comportemental tests/audit_output_guard.test.sh (qui, lui,
// exécute le guard directement et tourne sur les deux plateformes CI).
//
// On n'EXÉCUTE PAS le wrapper assemblé ici : lancer un wrapper bash multi-script
// via spawnSync n'est pas portable (ubuntu vs Windows Git-Bash divergent sur les
// pipes/exec bits — un premier essai le faisait échouer en CI). On asserte donc
// la COMPOSITION du wrapper, qui est ce qui garantit la délivrance du deny :
//
//   1. le stdin est bufferisé UNE fois puis REDONNÉ au guard (promptweave >= 0.5.1
//      corrige le drain de pipe : sans ça, activity-tracking order 50 faisait
//      `cat` et le guard order 60 lisait EOF -> fail-closed sur tout, ou pire).
//   2. le guard est invoqué NON bloquant (`|| true`) : son refus voyage par le
//      JSON stdout (permissionDecision), PAS par l'exit code — que le wrapper
//      collapse (`|| exit 1`) ou avale (`|| true`). Un `|| exit 1` ici = faux vert.
//   3. check-interrupt (déprécié) est ABSENT : il écrivait sur stdout et aurait
//      pollué le JSON du deny (revue sécurité).
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { buildProjectFromBce } from "../../src/bridge.js";

const REPO = join(__dirname, "..", "..");
const ctx = { path: REPO, language: "typescript", test_command: "pnpm test", modules: ["orchestrator"], source_files: [] };

function gardienPreToolHook(): string {
  const agent = buildProjectFromBce("gardien", ctx, {}, REPO).agents[0];
  return (agent.hooks ?? {})["pre-tool-use"] ?? "";
}

describe("#177 — le hook pre-tool-use assemblé de gardien délivre le deny du guard", () => {
  it("bufferise stdin et le REDONNE au guard (anti-drain, promptweave >= 0.5.1)", () => {
    const hook = gardienPreToolHook();
    // le buffer est capturé une fois…
    expect(hook).toMatch(/__BCE_HOOK_STDIN="\$\(cat/);
    // …et rejoué DEVANT le guard (le guard ne lit donc jamais un pipe drainé).
    expect(hook).toMatch(/printf '%s' "\$__BCE_HOOK_STDIN" \| "\$BCE_SCRIPTS_DIR\/audit_output_guard\.sh"/);
  });

  it("invoque le guard avec les chemins d'audit déclarés (AUDIT.md)", () => {
    const hook = gardienPreToolHook();
    expect(hook).toContain("audit_output_guard.sh");
    expect(hook).toContain("AUDIT.md"); // params.paths sérialisé en arg
  });

  it("invoque le guard en NON bloquant (deny via stdout, pas via exit code)", () => {
    const hook = gardienPreToolHook();
    // La ligne du guard finit par `|| true` (non bloquant). Un `|| exit 1`
    // (bloquant) collapserait un exit 2 en 1 et perdrait le refus -> faux vert.
    expect(hook).toMatch(/audit_output_guard\.sh"[^\n]*\|\| true/);
    expect(hook).not.toMatch(/audit_output_guard\.sh"[^\n]*\|\| exit 1/);
  });

  it("N'inclut PLUS check-interrupt (source de pollution du stdout du guard)", () => {
    expect(gardienPreToolHook()).not.toContain("check_interrupt");
  });
});
