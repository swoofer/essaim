// src/orchestrator/gitignore.ts — garde le dépôt cible propre après un run (#174).
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const MARKER = "# --- essaim (managed) ---";
const BLOCK = [
  MARKER,
  "runs/",       // worktrees + artefacts par run (ancrés sur -p depuis #158)
  "reports/",    // rapports par run
  ".claude/",    // hooks / settings assemblés par run
  ".mcp.json",   // config MCP déposée par run
  "# --- end essaim ---",
].join("\n");

/**
 * Ajoute (idempotent, via marqueur) au `.gitignore` du dépôt les artefacts
 * qu'essaim écrit lors d'un run — runs/, reports/, .claude/, .mcp.json. Sans ça,
 * un run sur un dépôt neuf laissait `git status` sale (#174, corollaire de #158
 * qui ancre runs/reports sur -p). Best-effort : une écriture qui échoue (ou un
 * répertoire hors dépôt git) ne bloque JAMAIS le run.
 */
export function ensureEssaimGitignore(projectPath: string): void {
  try {
    const giPath = join(projectPath, ".gitignore");
    const existing = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
    if (existing.includes(MARKER)) return; // déjà patché
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(giPath, `${prefix}${BLOCK}\n`);
  } catch {
    /* best-effort : ne pas faire échouer un run sur une écriture .gitignore */
  }
}
