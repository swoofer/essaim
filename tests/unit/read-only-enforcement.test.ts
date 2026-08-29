import { describe, it, expect } from "vitest";
import { buildProjectFromBce, buildSolo } from "../../src/bridge.js";
import { buildAllowedTools } from "../../src/orchestrator/agent-launcher.js";
import { disallowedForMode } from "../../src/agent-loop/agent-loop.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// DF4 — SÛRETÉ PAR CONSTRUCTION. Aucun agent dont l'intention declaree est
// « lecture seule » ne peut ecrire dans l'arbre de travail de l'utilisateur.
//
// Le danger, mesure : `essaim run gardien -p .` donne Write+Edit+Bash a un agent
// dont le cwd est l'arbre REEL (gardien est `workspace: shared`, pas de worktree).
// Cause racine, verifiee : `bridge.ts` ne positionnait JAMAIS `read_only`, donc
// `buildAllowedTools` retombait toujours sur CODE_TOOLS. Le behavior
// `read-only-mode` etait du texte de prompt sans aucun verrou d'outil.
//
// L'invariant N'EST PAS « workspace: shared => lecture seule » : migrate-phase2
// est `shared` et ECRIT deliberement (il n'inclut pas read-only-mode). Le signal
// correct est la presence du behavior read-only-mode, resolue par promptweave en
// `tools_mode: read_only`.

const REPO = join(__dirname, "..", "..");
const WRITE_TOOLS = ["Write", "Edit", "Bash", "NotebookEdit"];

const ctx = {
  path: REPO,
  language: "typescript",
  test_command: "pnpm test",
  modules: ["orchestrator", "security"],
  source_files: [],
};

/**
 * Presets LECTEURS PURS : read-only-mode ET PAS audit-output. Eux ne doivent
 * ecrire AUCUN fichier. Un preset avec audit-output (gardien, phare-*) ecrit son
 * livrable (AUDIT.md, tmp/audit/*) et n'est donc PAS ici — son ecriture
 * path-scopee est un chantier distinct (#1b), pas un leak.
 */
const readOnlyPresets = new Set(
  readdirSync(join(REPO, "presets"))
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => ({ name: f.replace(/\.yaml$/, ""), body: readFileSync(join(REPO, "presets", f), "utf8") }))
    .filter((p) => p.body.includes("read-only-mode") && !p.body.includes("audit-output"))
    .map((p) => p.name),
);

/**
 * Map idPrefix -> preset depuis le template. On NE mappe PAS par index :
 * `count: dynamic`/`per-module` produit N agents par definition, donc l'index
 * d'agent ne suit pas l'ordre des presets (revue = N auteurs puis N reviewers).
 * L'agent porte `role = idPrefix` (bridge.ts), c'est la cle fiable.
 */
function presetByRole(templateId: string): Map<string, string> {
  const raw = readFileSync(join(REPO, "templates", `${templateId}.yaml`), "utf8");
  const map = new Map<string, string>();
  const blocks = raw.split(/\n\s*-\s*(?=idPrefix:)/);
  for (const b of blocks) {
    const id = b.match(/idPrefix:\s*(\S+)/)?.[1];
    const preset = b.match(/preset:\s*(\S+)/)?.[1];
    if (id && preset) map.set(id, preset);
  }
  return map;
}

const templates = readdirSync(join(REPO, "templates"))
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => f.replace(/\.yaml$/, ""));

describe("DF4 — un agent read-only ne peut pas ecrire l'arbre de travail", () => {
  it("le catalogue declare bien des lecteurs purs (sinon le test ne prouve rien)", () => {
    expect(readOnlyPresets.size).toBeGreaterThan(0);
    expect(readOnlyPresets.has("debat")).toBe(true);
    // FRONTIERE #1b : gardien a read-only-mode MAIS audit-output — il ecrit son
    // AUDIT.md, donc il n'est PAS un lecteur pur. Le classer read_only casserait
    // son livrable (regression #34). Le verrou path-scope est un autre chantier.
    expect(readOnlyPresets.has("gardien")).toBe(false);
  });

  for (const tid of templates) {
    it(`${tid} : chaque agent d'un preset read-only n'a aucun outil d'ecriture`, () => {
      let project;
      try {
        project = buildProjectFromBce(tid, ctx, {}, REPO);
      } catch {
        // per-module sans modules, etc. — non pertinent pour cet invariant.
        return;
      }
      const roleToPreset = presetByRole(tid);
      project.agents.forEach((agent) => {
        const preset = roleToPreset.get(agent.role ?? "") ?? "";
        if (!readOnlyPresets.has(preset)) return;
        // WIRING : un preset read-only doit produire un agent read_only.
        expect(agent.read_only, `${tid}/${preset}: read_only devrait etre vrai`).toBe(true);
        // ENFORCEMENT : et donc aucun outil d'ecriture dans l'allowlist.
        const allowed = buildAllowedTools(agent).split(",");
        const leaks = WRITE_TOOLS.filter((t) => allowed.includes(t));
        expect(leaks, `${tid}/${preset} laisse fuir ${leaks.join(",")}`).toEqual([]);
      });
    });
  }

  it("migrate-phase2 (shared MAIS pas read-only) garde le droit d'ecrire", () => {
    const p = buildProjectFromBce("migrate-phase2", ctx, {}, REPO);
    // au moins un agent ecrit — sinon on aurait casse la migration
    const anyWriter = p.agents.some((a) => !a.read_only);
    expect(anyWriter).toBe(true);
  });

  it("solo d'un lecteur pur (debat) n'expose aucun outil d'ecriture", () => {
    const solo = buildSolo("debat", ctx, undefined, REPO);
    expect(solo.read_only).toBe(true);
    const allowed = buildAllowedTools({ tools: solo.mcpTools, read_only: solo.read_only } as never).split(",");
    expect(WRITE_TOOLS.filter((t) => allowed.includes(t))).toEqual([]);
  });

  it("solo d'un preset audit-output (gardien) GARDE l'ecriture — c'est son livrable (#34)", () => {
    const solo = buildSolo("gardien", ctx, undefined, REPO);
    expect(solo.read_only).toBe(false);
    const allowed = buildAllowedTools({ tools: solo.mcpTools, read_only: solo.read_only } as never).split(",");
    expect(allowed).toContain("Write");
  });

  // LE VRAI VERROU sous --dangerously-skip-permissions (chemin agent-loop) :
  // l'allowlist y est IGNOREE, seul --disallowedTools bloque. Un agent read_only
  // doit donc voir chaque outil d'ecriture dans son disallow, Bash COMPRIS —
  // sinon le mode one-shot de gardien pouvait ecrire l'arbre reel malgre une
  // allowlist propre. C'est l'artefact, pas le proxy.
  it("le mode read_only bloque DUR chaque outil d'ecriture (disallowedTools)", () => {
    const blocked = disallowedForMode("read_only");
    for (const t of WRITE_TOOLS) {
      expect(blocked, `${t} doit etre bloque dur en read_only`).toContain(t);
    }
  });

  it("le mode full ne bloque PAS l'ecriture (sinon on aurait casse les writers)", () => {
    const blocked = disallowedForMode("full");
    expect(blocked).not.toContain("Write");
    expect(blocked).not.toContain("Bash");
  });
});
