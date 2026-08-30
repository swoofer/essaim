import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createWorkspaces, cleanupWorkspaces, resetBase } from "../../src/orchestrator/workspace.js";
import type { AgentConfig, WorkspaceResult } from "../../src/orchestrator/types.js";

function testAgent(partial: Partial<AgentConfig> & Pick<AgentConfig, "id" | "name" | "profile">): AgentConfig {
  return {
    prompt: "",
    hooks: {},
    envVars: {},
    mcpTools: [],
    ...partial,
  };
}

const TMP_DIR = path.resolve("/tmp/test-workspace-" + Date.now());
const SANDBOX_DIR = path.join(TMP_DIR, "sandbox");
let lastWorkspace: WorkspaceResult | null = null;

function setupGitRepo(): void {
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  execSync("git init && git config user.email 'test@test.com' && git config user.name 'Test'", { cwd: SANDBOX_DIR });
  fs.writeFileSync(path.join(SANDBOX_DIR, "file.txt"), "hello");
  execSync("git add . && git commit -m 'init'", { cwd: SANDBOX_DIR });
}

beforeEach(() => { lastWorkspace = null; setupGitRepo(); });
afterEach(() => {
  if (lastWorkspace) cleanupWorkspaces(lastWorkspace);
  try { fs.rmSync(TMP_DIR, { recursive: true }); } catch {}
});

describe("createWorkspaces", () => {
  it("creates N worktrees for worktree type", () => {
    const agents = [
      testAgent({ id: "alpha", name: "Alpha", profile: "codeur" }),
      testAgent({ id: "bravo", name: "Bravo", profile: "codeur" }),
      testAgent({ id: "charlie", name: "Charlie", profile: "codeur" }),
    ];
    const result = createWorkspaces({ type: "worktree", base: SANDBOX_DIR }, agents, TMP_DIR);
    lastWorkspace = result;
    expect(result.type).toBe("worktree");
    expect(result.paths.size).toBe(3);
    for (const [id, wsPath] of result.paths) {
      expect(fs.existsSync(wsPath)).toBe(true);
      expect(fs.existsSync(path.join(wsPath, "file.txt"))).toBe(true);
    }
  });

  it("returns same path for shared type", () => {
    const agents = [
      testAgent({ id: "alpha", name: "Alpha", profile: "codeur" }),
      testAgent({ id: "bravo", name: "Bravo", profile: "codeur" }),
    ];
    const result = createWorkspaces({ type: "shared", base: SANDBOX_DIR }, agents, TMP_DIR);
    expect(result.type).toBe("shared");
    const paths = [...result.paths.values()];
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0]).toBe(SANDBOX_DIR);
  });

  it("returns base path for none type", () => {
    const result = createWorkspaces(
      { type: "none" },
      [testAgent({ id: "a", name: "A", profile: "communicant" })],
      TMP_DIR
    );
    expect(result.type).toBe("none");
    expect(result.paths.size).toBe(1);
  });
});

// ── #56 — ESSAIM_RESET_BASE nomme le répertoire à détruire ──────────────────
//
// resetBase lance `git checkout -- .` + `git clean -fd`. Le contrat booléen
// `=1` autorisait l'opération sans dire SUR QUOI : le répertoire visé venait
// d'ailleurs (workspace.base, défaut cwd), donc un `-p` distrait suffisait à
// perdre son travail non commité. Aucune heuristique ne rattrape ça — refuser
// quand la base vaut le cwd casse l'usage recommandé (`cd /tmp/sandbox &&
// essaim run -p .`). Nommer le chemin est la seule autorisation sans faux
// positif ni faux négatif : on ne peut pas détruire ce qu'on n'a pas nommé.
describe("resetBase — ESSAIM_RESET_BASE (#56)", () => {
  const ORIGINAL = process.env.ESSAIM_RESET_BASE;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ESSAIM_RESET_BASE;
    else process.env.ESSAIM_RESET_BASE = ORIGINAL;
  });

  /** Salit le bac à sable : un fichier suivi modifié + un fichier non suivi. */
  function dirty(): void {
    fs.writeFileSync(path.join(SANDBOX_DIR, "file.txt"), "MODIFIÉ");
    fs.writeFileSync(path.join(SANDBOX_DIR, "untracked.txt"), "x");
  }

  function isClean(): boolean {
    return (
      fs.readFileSync(path.join(SANDBOX_DIR, "file.txt"), "utf-8") === "hello" &&
      !fs.existsSync(path.join(SANDBOX_DIR, "untracked.txt"))
    );
  }

  it("ne touche à rien quand la variable est absente", () => {
    delete process.env.ESSAIM_RESET_BASE;
    dirty();

    resetBase(SANDBOX_DIR);

    expect(isClean()).toBe(false);
  });

  it("refuse l'ancien contrat booléen =1", () => {
    process.env.ESSAIM_RESET_BASE = "1";
    dirty();

    expect(() => resetBase(SANDBOX_DIR)).toThrow(/resetBase refused/);
    expect(isClean()).toBe(false);
  });

  it("refuse quand la variable nomme un AUTRE répertoire", () => {
    process.env.ESSAIM_RESET_BASE = path.join(TMP_DIR, "ailleurs");
    dirty();

    expect(() => resetBase(SANDBOX_DIR)).toThrow(/resetBase refused/);
    expect(isClean()).toBe(false);
  });

  it("nomme les deux chemins dans le refus, pour que l'erreur soit actionnable", () => {
    process.env.ESSAIM_RESET_BASE = "1";

    expect(() => resetBase(SANDBOX_DIR)).toThrow(new RegExp(SANDBOX_DIR.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&")));
  });

  it("réinitialise quand la variable nomme exactement la base", () => {
    process.env.ESSAIM_RESET_BASE = SANDBOX_DIR;
    dirty();

    resetBase(SANDBOX_DIR);

    expect(isClean()).toBe(true);
  });

  it("accepte une forme non normalisée du même chemin", () => {
    // Un opérateur qui copie-colle avec une barre finale, ou passe par `.`,
    // désigne bien le même répertoire — refuser là-dessus serait du zèle.
    process.env.ESSAIM_RESET_BASE = path.join(SANDBOX_DIR, ".") + path.sep;
    dirty();

    resetBase(SANDBOX_DIR);

    expect(isClean()).toBe(true);
  });
});

// ── Le run N+1 ne détruit plus le livrable du run N ─────────────────────────
//
// Sans `--cleanup`, le worktree EST le livrable : l'orchestrateur journalise
// « Worktrees preserved » et publie les branches dans le rapport. Tant que le
// nom de branche ne contenait que l'id d'agent — stable par template — le run
// suivant du même template retrouvait ces branches dans
// `git worktree list --porcelain`, exécutait `git worktree remove --force` sur
// le répertoire du run précédent, puis `git branch -D` sur sa branche.
// Comparer un run N à un run N+1 était impossible par construction.
describe("createWorkspaces — isolation entre deux runs successifs", () => {
  const ORIGINAL_RUN_ID = process.env.ESSAIM_RUN_ID;

  afterEach(() => {
    if (ORIGINAL_RUN_ID === undefined) delete process.env.ESSAIM_RUN_ID;
    else process.env.ESSAIM_RUN_ID = ORIGINAL_RUN_ID;
  });

  /** Branches locales du bac à sable, sans le marqueur `*` / `+` de git. */
  function localBranches(): string[] {
    return execSync("git branch --list", { cwd: SANDBOX_DIR, encoding: "utf-8" })
      .split("\n")
      .map((line) => line.replace(/^[*+\s]+/, "").trim())
      .filter(Boolean);
  }

  it("deux runs du même template gardent chacun leur branche et leur worktree", () => {
    const agents = [testAgent({ id: "agent-chasseur-1", name: "Chasseur 1", profile: "codeur" })];

    process.env.ESSAIM_RUN_ID = "raid-aaaaaaaa";
    const ws1 = createWorkspaces(
      { type: "worktree", base: SANDBOX_DIR },
      agents,
      path.join(TMP_DIR, "run-1"),
    );
    const worktree1 = ws1.paths.get("agent-chasseur-1")!;
    expect(fs.existsSync(path.join(worktree1, "file.txt"))).toBe(true);

    process.env.ESSAIM_RUN_ID = "raid-bbbbbbbb";
    const ws2 = createWorkspaces(
      { type: "worktree", base: SANDBOX_DIR },
      agents,
      path.join(TMP_DIR, "run-2"),
    );
    lastWorkspace = ws2;

    // 1. le livrable du run 1 a survécu au run 2
    expect(fs.existsSync(path.join(worktree1, "file.txt"))).toBe(true);

    // 2. les deux branches coexistent, chacune portant son runId
    const noms = localBranches();
    expect(noms.filter((b) => b.includes("raid-aaaaaaaa"))).toHaveLength(1);
    expect(noms.filter((b) => b.includes("raid-bbbbbbbb"))).toHaveLength(1);

    // 3. et ce sont bien deux noms différents pour le MÊME agent
    expect(ws2.branches.get("agent-chasseur-1")).not.toBe(ws1.branches.get("agent-chasseur-1"));

    cleanupWorkspaces(ws1);

    // 4. #158 — le nettoyage retire le WORKTREE de ws1 mais GARDE sa branche :
    //    c'est le livrable de l'agent (le rapport « Récupérer » propose un
    //    `git cherry-pick` dessus, #163). Seul le worktree part ; la branche du
    //    run 1 survit, et celle du run 2 (jamais nettoyé) aussi.
    expect(fs.existsSync(worktree1)).toBe(false); // worktree retiré
    expect(localBranches()).toContain(ws1.branches.get("agent-chasseur-1")!); // branche GARDÉE
    expect(localBranches()).toContain(ws2.branches.get("agent-chasseur-1")!);
  });
});

