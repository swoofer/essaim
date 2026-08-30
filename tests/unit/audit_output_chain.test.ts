// tests/unit/audit_output_chain.test.ts
//
// Acceptance #177 par la VRAIE chaîne de hooks assemblée (pas le guard en
// isolation). La revue sécurité a montré que tester le guard seul RATE le bug
// critique : dans la chaîne pre-tool-use, activity-tracking (order 50) fait
// `INPUT=$(cat)` et draine le pipe stdin avant le guard (order 60), qui lisait
// EOF et autorisait tout. Corrigé en amont (promptweave >= 0.5.2 : buffer stdin
// redistribué à chaque hook). CE test échoue sur 0.5.1 (stdin drainé -> le guard
// fail-closed refuse même AUDIT.md) et passe sur 0.5.2 — il verrouille donc à la
// fois le fix promptweave ET l'acceptance.
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectFromBce } from "../../src/bridge.js";

const REPO = join(__dirname, "..", "..");
const SCRIPTS = join(REPO, "scripts");
const ctx = { path: REPO, language: "typescript", test_command: "pnpm test", modules: ["orchestrator"], source_files: [] };

// Le hook pre-tool-use assemblé de gardien, $BCE_SCRIPTS_DIR pointé vers scripts/.
function gardienPreToolHook(): string {
  const agent = buildProjectFromBce("gardien", ctx, {}, REPO).agents[0];
  const raw = (agent.hooks ?? {})["pre-tool-use"] ?? "";
  return raw.replace(/\$BCE_SCRIPTS_DIR/g, SCRIPTS.replace(/\\/g, "/"));
}

// Exécute la chaîne assemblée avec un Write sur `file` (absolu) ; rend la sortie.
function runChain(hookPath: string, cwd: string, file: string): string {
  const input = JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } });
  const r = spawnSync("bash", [hookPath], {
    input, cwd, encoding: "utf-8",
    // coordinator injoignable -> les hooks activity/interrupt échouent vite (|| true)
    env: { ...process.env, COORDINATOR_URL: "http://127.0.0.1:1" },
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

describe("#177 — chaîne pre-tool-use assemblée : le guard path-scope reste actif", () => {
  let hookPath: string;
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "e177chain-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    mkdirSync(join(repo, "src"), { recursive: true });
    hookPath = join(repo, "pre-tool-use.sh");
    writeFileSync(hookPath, gardienPreToolHook());
    chmodSync(hookPath, 0o755);
  });

  it("AUTORISE l'écriture de AUDIT.md (le livrable) — échoue si stdin est drainé (promptweave < 0.5.2)", () => {
    const out = runChain(hookPath, repo, join(repo, "AUDIT.md"));
    // Pas de deny -> autorisé. Sur 0.5.1 (stdin drainé) le guard fail-closed
    // refuserait, faisant échouer ce test : c'est le verrou du fix promptweave.
    expect(out).not.toContain('"permissionDecision":"deny"');
  });

  it("REFUSE une écriture hors scope (src/x.ts) via la chaîne réelle, en JSON PROPRE", () => {
    const out = runChain(hookPath, repo, join(repo, "src/x.ts")).trim();
    expect(out).toContain('"permissionDecision":"deny"');
    // Le deny doit être du JSON PARSABLE : un hook informatif (ex. la bannière
    // check-interrupt) qui préfixerait du texte casserait le parse -> deny perdu
    // -> fuite (revue sécurité). On exige donc un stdout intégralement JSON.
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("le hook pre-tool-use assemblé N'inclut PLUS check-interrupt (source de pollution du stdout du guard)", () => {
    expect(gardienPreToolHook()).not.toContain("check_interrupt");
  });
});
