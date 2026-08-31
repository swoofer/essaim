import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { ensureEssaimGitignore } from "../../src/orchestrator/gitignore.js";

// #174 — après un run sur un dépôt neuf, `git status` ne doit pas être sali par
// les artefacts essaim (runs/, reports/, .claude/, .mcp.json), ancrés sur le
// dépôt cible depuis #158.
describe("ensureEssaimGitignore (#174)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("les artefacts d'un run ne salissent PAS git status", () => {
    dir = mkdtempSync(join(tmpdir(), "gi174-"));
    execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: dir });
    writeFileSync(join(dir, "src.ts"), "export const a = 1;\n");
    execSync("git add . && git commit -qm init", { cwd: dir });

    ensureEssaimGitignore(dir);

    // essaim dépose ses artefacts
    mkdirSync(join(dir, "runs", "r1"), { recursive: true }); writeFileSync(join(dir, "runs", "r1", "x"), "w");
    mkdirSync(join(dir, "reports"), { recursive: true }); writeFileSync(join(dir, "reports", "rep.md"), "r");
    mkdirSync(join(dir, ".claude"), { recursive: true }); writeFileSync(join(dir, ".claude", "settings.json"), "{}");
    writeFileSync(join(dir, ".mcp.json"), "{}");

    const status = execSync("git status --porcelain", { cwd: dir, encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    // aucune ligne ne mentionne un artefact essaim (le .gitignore lui-même, lui,
    // est un changement légitime que l'utilisateur commite)
    expect(status.some((l) => /runs\/|reports\/|\.claude\/|\.mcp\.json/.test(l))).toBe(false);
  });

  it("idempotent : deux appels ⇒ un seul bloc, couvrant les artefacts", () => {
    dir = mkdtempSync(join(tmpdir(), "gi174b-"));
    ensureEssaimGitignore(dir);
    ensureEssaimGitignore(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi.match(/essaim \(managed\)/g)?.length).toBe(1);
    expect(gi).toContain("runs/");
    expect(gi).toContain("reports/");
    expect(gi).toContain(".mcp.json");
  });

  it("préserve un .gitignore existant (append, pas écrasement)", () => {
    dir = mkdtempSync(join(tmpdir(), "gi174c-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n");
    ensureEssaimGitignore(dir);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules/"); // l'existant survit
    expect(gi).toContain("runs/");
  });
});
