// tests/unit/release-package.test.ts
//
// package.json "files" et l'étape « Package tarball » de release-binaries.yml
// décrivent le MÊME catalogue, dans deux langues qui ne se parlent pas : npm
// lit la première, GitHub Actions la seconde. La v0.13.0 est partie avec
// templates/ présent dans "files" et absent du tarball — paquet npm sain,
// binaire incapable de lancer un seul swarm, et aucune étape rouge.
//
// Ce test ne regarde pas le contenu d'une archive (impossible sans exécuter le
// workflow) : il vérifie que les deux déclarations nomment les mêmes
// répertoires.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Répertoires de catalogue publiés par npm — hors dist/, qui est un produit du build. */
function dirsFromPackageJson(): string[] {
  const pkg = JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf-8"),
  ) as { files: string[] };
  return pkg.files
    .filter((f) => f.endsWith("/") && !f.startsWith("dist/"))
    .map((f) => f.slice(0, -1))
    .sort();
}

/** Le script shell de l'étape « Package tarball » du workflow des binaires. */
function packageStepScript(): string {
  const wf = parse(
    readFileSync(resolve(ROOT, ".github/workflows/release-binaries.yml"), "utf-8"),
  ) as { jobs: { build: { steps: Array<{ name?: string; run?: string }> } } };
  const step = wf.jobs.build.steps.find((s) => s.name === "Package tarball");
  if (!step?.run) {
    throw new Error("étape « Package tarball » introuvable dans release-binaries.yml");
  }
  return step.run;
}

// La guillemet fermante exclut les destinations de `cp`
// (`dist/${DIST_NAME}/behaviors/"`) et le binaire (`dist/${DIST_NAME}/"`).
const MKDIR_RE = /dist\/\$\{DIST_NAME\}\/([A-Za-z0-9_-]+)"/g;
const CP_RE = /^\s*cp -r ([A-Za-z0-9_-]+)\/\*/gm;

describe("release-binaries.yml empaquette exactement ce que package.json publie", () => {
  const attendus = dirsFromPackageJson();
  const script = packageStepScript();

  it("sait quels répertoires sont attendus", () => {
    // Un garde-fou qui compare deux listes vides est vert pour rien.
    expect(attendus).toContain("templates");
    expect(attendus.length).toBeGreaterThanOrEqual(5);
  });

  it("crée chaque répertoire dans le tarball", () => {
    const crees = [...script.matchAll(MKDIR_RE)].map((m) => m[1]!).sort();
    expect(crees).toEqual(attendus);
  });

  it("copie chaque répertoire dans le tarball", () => {
    const copies = [...script.matchAll(CP_RE)].map((m) => m[1]!).sort();
    expect(copies).toEqual(attendus);
  });
});
