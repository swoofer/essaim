import { dirname, resolve } from "path";
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

let _root: string | null = null;

export function getCatalogRoot(): string {
  if (_root !== null) return _root;
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
        _root = dir;
        return _root;
      }
      dir = dirname(dir);
    }
  }
  throw new Error(
    `essaim: could not locate the bundled catalog (behaviors/, presets/, compositions/). ` +
      `Tried walking up from: ${candidates.join(", ")}.`,
  );
}

export function getBehaviorsDir(): string {
  return resolve(getCatalogRoot(), "behaviors");
}
export function getPresetsDir(): string {
  return resolve(getCatalogRoot(), "presets");
}
export function getCompositionsDir(): string {
  return resolve(getCatalogRoot(), "compositions");
}
export function getScriptsDir(): string {
  return resolve(getCatalogRoot(), "scripts");
}
export function getTemplatesDir(): string {
  return resolve(getCatalogRoot(), "templates");
}
