import { describe, it, expect } from "vitest";
import { phaseSummary } from "../../cli/run-core.js";

// #168 — le dry-run imprime modèle, effort et plafond de tours PAR PHASE, dérivés
// exactement comme la boucle réelle (resolveEffort + EFFORT_PROFILES).
describe("phaseSummary — dry-run par phase (#168)", () => {
  it("execute (loop, full, effort auto) ⇒ opus + 20 tours", () => {
    const line = phaseSummary({ name: "execute", toolsMode: "full", loop: true });
    expect(line).toContain("execute");
    expect(line).toContain("opus"); // loop+full ⇒ high ⇒ opus
    expect(line).toContain("20");   // maxTurns high
  });

  it("discover (read_only, one-shot) ⇒ haiku (low effort)", () => {
    const line = phaseSummary({ name: "discover", toolsMode: "read_only", loop: false });
    expect(line).toContain("haiku");
  });

  it("un override model de phase gagne sur le profil d'effort", () => {
    const line = phaseSummary({ name: "execute", toolsMode: "full", loop: true, model: "custom-x" });
    expect(line).toContain("custom-x");
    expect(line).not.toContain("opus");
  });
});
