import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Injecté par `bun build --define` au moment de compiler le binaire natif.
// Déclaré, jamais défini : tsc se contente de la déclaration, et `typeof` sur
// un identifiant absent ne jette pas — sous node/tsx la constante n'existe
// simplement pas et on retombe sur la recherche de package.json ci-dessous.
declare const __ESSAIM_VERSION__: string | undefined;

export function getVersion(): string {
  // Le binaire compilé n'a pas de package.json à côté de lui : sous
  // `bun --compile`, import.meta.url désigne le système de fichiers synthétique
  // de bun, donc AUCUN des deux candidats ci-dessous ne résout — y compris
  // quand la tarball place package.json à côté de l'exécutable. Sans cette
  // injection, `essaim --version` répond "0.0.0" sur les quatre plateformes.
  try {
    if (typeof __ESSAIM_VERSION__ === "string" && __ESSAIM_VERSION__) return __ESSAIM_VERSION__;
  } catch {}

  // dist/cli/version.js -> ../../package.json
  // cli/version.ts (tsx) -> ../package.json
  // Wrap fileURLToPath in the try as well — under Bun --compile, import.meta.url
  // may be a synthetic non-file URL that throws TypeError on fileURLToPath.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [resolve(here, "..", "package.json"), resolve(here, "..", "..", "package.json")]) {
      try {
        const json = JSON.parse(readFileSync(candidate, "utf-8")) as { version?: string };
        if (json.version) return json.version;
      } catch {}
    }
  } catch {}
  return "0.0.0";
}
