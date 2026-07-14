import { dirname, resolve, delimiter } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

// Compute the start dir, surviving Bun --compile (where import.meta.url is
// synthetic and fileURLToPath throws TypeError). Mirror the Project 2 pattern
// from getDashboardDir() at src/serve-http.ts.
let SCRIPT_DIR: string;
try {
  SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
} catch {
  SCRIPT_DIR = process.cwd();
}

// Cached: the BUNDLED root only. Never the resolved list — an agent-loop, a
// pipeline step or the next test would otherwise inherit the catalogs of the
// previous call and assemble prompts from a catalog nobody chose.
let _bundledRoot: string | null = null;

/** The catalog shipped with essaim itself. */
export function getBundledRoot(): string {
  if (_bundledRoot !== null) return _bundledRoot;
  // Walk up looking for a directory that contains all 3 catalog dirs.
  // tsx dev:        starts at cli/        → walks up 1 level → repo root
  // node from dist: starts at dist/cli/   → walks up 2 levels → repo root
  // Bun --compile:  starts at process.cwd() or dirname(execPath) → expects
  //                 catalog dirs as siblings of the binary
  const candidates = [SCRIPT_DIR, dirname(process.execPath), process.cwd()];
  for (const start of candidates) {
    let dir = start;
    while (dir !== dirname(dir)) {
      if (
        existsSync(resolve(dir, "behaviors")) &&
        existsSync(resolve(dir, "presets")) &&
        existsSync(resolve(dir, "compositions"))
      ) {
        _bundledRoot = dir;
        return _bundledRoot;
      }
      dir = dirname(dir);
    }
  }
  throw new Error(
    `essaim: could not locate the bundled catalog (behaviors/, presets/, compositions/). ` +
      `Tried walking up from: ${candidates.join(", ")}.`,
  );
}

/** @deprecated Prefer getCatalogRoots() — this only ever sees the bundled catalog. */
export function getCatalogRoot(): string {
  return getBundledRoot();
}

export interface CatalogOptions {
  /** Explicit catalogs (`--catalog`, repeatable). */
  catalogs?: string[];
  /** Project whose `.essaim/` catalog should be layered on top, if it has one. */
  projectPath?: string;
}

function requireCatalog(path: string): string {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    // A catalog the user NAMED must never degrade into a silent no-op: the
    // typo would simply be ignored, and the failure would resurface two screens
    // later as an opaque "Unknown template".
    throw new Error(`essaim: catalogue introuvable — ${abs}`);
  }
  return abs;
}

/**
 * Catalog roots, in precedence order — **the last one wins**.
 *
 *   bundled  <  ESSAIM_CATALOG  <  --catalog  <  <project>/.essaim
 *
 * From the most general to the most local. The explicit flag beats the ambient
 * environment (an env var set months ago must not quietly outrank what the user
 * just typed), and a project's own `.essaim/` beats everything.
 */
export function getCatalogRoots(opts: CatalogOptions = {}): string[] {
  const roots = [getBundledRoot()];

  // path.delimiter, never a hardcoded ':' — that would cut "C:\..." in half on
  // Windows, where this is developed.
  const fromEnv = (process.env.ESSAIM_CATALOG ?? "")
    .split(delimiter)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const c of [...fromEnv, ...(opts.catalogs ?? [])]) {
    roots.push(requireCatalog(c));
  }

  if (opts.projectPath) {
    const local = resolve(opts.projectPath, ".essaim");
    if (existsSync(local)) roots.push(local);
  }

  return roots;
}

const subdir = (name: string) => (opts: CatalogOptions = {}): string[] =>
  getCatalogRoots(opts).map((r) => resolve(r, name)).filter(existsSync);

/** Every existing `behaviors/` dir across the catalogs, in precedence order. */
export const getBehaviorsDirs = subdir("behaviors");
/** Every existing `templates/` dir across the catalogs, in precedence order. */
export const getTemplatesDirs = subdir("templates");
/** Every existing `scripts/` dir across the catalogs, in precedence order. */
export const getScriptsDirs = subdir("scripts");

export function getBehaviorsDir(): string {
  return resolve(getBundledRoot(), "behaviors");
}
export function getPresetsDir(): string {
  return resolve(getBundledRoot(), "presets");
}
export function getCompositionsDir(): string {
  return resolve(getBundledRoot(), "compositions");
}
export function getScriptsDir(): string {
  return resolve(getBundledRoot(), "scripts");
}
export function getTemplatesDir(): string {
  return resolve(getBundledRoot(), "templates");
}
