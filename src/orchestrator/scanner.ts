import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import type { ProjectContext } from "./types.js";

interface LangDetection {
  language: string;
  test_command: string;
  extensions: string[];
}

export function detectLanguage(projectPath: string): LangDetection {
  if (fs.existsSync(path.join(projectPath, "package.json"))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf-8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = pkg.scripts || {};
      const isTS = fs.existsSync(path.join(projectPath, "tsconfig.json")) || deps.typescript;
      let testCmd = scripts.test || "npm test";
      if (deps.vitest) testCmd = "npx vitest run";
      else if (deps.jest) testCmd = "npx jest";
      return { language: isTS ? "typescript" : "javascript", test_command: testCmd, extensions: isTS ? [".ts", ".tsx"] : [".js", ".jsx"] };
    } catch {}
  }
  if (fs.existsSync(path.join(projectPath, "pyproject.toml")) || fs.existsSync(path.join(projectPath, "setup.py"))) {
    return { language: "python", test_command: "pytest", extensions: [".py"] };
  }
  if (fs.existsSync(path.join(projectPath, "go.mod"))) {
    return { language: "go", test_command: "go test ./...", extensions: [".go"] };
  }
  if (fs.existsSync(path.join(projectPath, "Cargo.toml"))) {
    return { language: "rust", test_command: "cargo test", extensions: [".rs"] };
  }
  if (fs.existsSync(path.join(projectPath, "pom.xml"))) {
    return { language: "java", test_command: "mvn test", extensions: [".java"] };
  }
  if (fs.existsSync(path.join(projectPath, "build.gradle")) || fs.existsSync(path.join(projectPath, "build.gradle.kts"))) {
    return { language: "java", test_command: "gradle test", extensions: [".java", ".kt"] };
  }
  return { language: "unknown", test_command: "echo 'no test command detected'", extensions: [] };
}

function isDir(full: string): boolean {
  try { return fs.statSync(full).isDirectory(); } catch { return false; }
}

function findDirs(projectPath: string, candidates: string[]): string[] {
  const direct = candidates.filter(d => isDir(path.join(projectPath, d)));
  if (direct.length > 0) return direct;
  // #159 — descente d'UN niveau pour les monorepos (pnpm/yarn/turbo : packages/*,
  // apps/*, libs/*). Le src/ vit dans les paquets, pas à la racine — sans ça un
  // monorepo pnpm rendait source_dirs VIDE et l'agent ne voyait aucun code.
  const nested: string[] = [];
  for (const w of ["packages", "apps", "libs"]) {
    const wroot = path.join(projectPath, w);
    if (!isDir(wroot)) continue;
    let pkgs: fs.Dirent[] = [];
    try { pkgs = fs.readdirSync(wroot, { withFileTypes: true }); } catch { continue; }
    for (const pkg of pkgs) {
      if (!pkg.isDirectory() || pkg.name.startsWith(".")) continue;
      for (const c of candidates) {
        const rel = path.join(w, pkg.name, c);
        if (isDir(path.join(projectPath, rel))) nested.push(rel);
      }
    }
  }
  return nested;
}

/**
 * Un chemin de SUPPORT DE TEST (à écarter du source montré aux agents), par
 * SEGMENT et non par substring (#159). `rel.includes("test")` écartait
 * `latest.ts` (la·test) et `inspector.ts` (in·spec·tor) — du code de production
 * rendu invisible. On écarte si un SEGMENT de répertoire est test/tests/spec/
 * __tests__, ou si le BASENAME est un test (séparateur exigé : `.test.`,
 * `_test.`, `-spec.`, `test_…` — jamais « test » collé dans un mot).
 */
function isTestPath(rel: string): boolean {
  const segs = rel.replace(/\\/g, "/").split("/");
  const base = segs.pop() ?? "";
  if (segs.some(s => s === "test" || s === "tests" || s === "spec" || s === "__tests__")) return true;
  return /[._-](test|spec)s?\.[^.]+$/.test(base) || /^test[._-]/.test(base);
}

function listSourceFiles(projectPath: string, sourceDirs: string[], extensions: string[], max: number): string[] {
  const files: { path: string; mtime: number }[] = [];
  function walk(dir: string): void {
    if (files.length >= max * 2) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "__pycache__" || entry.name === "target" || entry.name === "vendor") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (extensions.length === 0 || extensions.some(ext => entry.name.endsWith(ext))) {
          const rel = path.relative(projectPath, full);
          if (!isTestPath(rel)) {
            try { files.push({ path: rel, mtime: fs.statSync(full).mtimeMs }); } catch {}
          }
        }
      }
    } catch {}
  }
  for (const sd of sourceDirs) walk(path.join(projectPath, sd));
  if (sourceDirs.length === 0) walk(projectPath);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, max).map(f => f.path);
}

function findModules(projectPath: string, sourceDirs: string[]): string[] {
  const modules: string[] = [];
  for (const sd of sourceDirs) {
    const full = path.join(projectPath, sd);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) modules.push(entry.name);
    }
  }
  return modules;
}

function computeApplicableTemplates(ctx: Omit<ProjectContext, "applicable_templates">): string[] {
  const templates: string[] = [];
  const hasSource = ctx.source_files.length > 0;
  const hasTests = ctx.test_dirs.length > 0;
  const hasReadme = fs.existsSync(path.join(ctx.path, "README.md")) || fs.existsSync(path.join(ctx.path, "readme.md"));
  if (hasSource) templates.push("melee", "carrefour", "maitre", "revue", "relais");
  if (hasTests) templates.push("chaine", "raid");
  const hasLargeFile = ctx.source_files.some(f => {
    try { return fs.readFileSync(path.join(ctx.path, f), "utf-8").split("\n").length > 200; } catch { return false; }
  });
  if (hasLargeFile) templates.push("debat");
  if (hasSource) templates.push("arene");
  if (ctx.source_files.length > 10) templates.push("swarm");
  if (hasReadme) templates.push("babel");
  templates.push("gardien");
  return templates;
}

export function scanProject(projectPath: string): ProjectContext {
  const absPath = path.resolve(projectPath);
  const lang = detectLanguage(absPath);
  const sourceDirs = findDirs(absPath, ["src", "lib", "app", "pkg", "internal", "cmd"]);
  const testDirs = findDirs(absPath, ["tests", "test", "__tests__", "spec"]);
  let hasGit = false;
  let isClean = true;
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: absPath, stdio: "pipe" });
    hasGit = true;
    const status = execSync("git status --porcelain", { cwd: absPath, encoding: "utf-8", stdio: "pipe" });
    // Ignore les artefacts qu'essaim écrit LUI-MÊME dans le dépôt cible (#158) :
    // runs/ (worktrees) et reports/ non suivis ne sont PAS du travail de
    // l'utilisateur. Sans ce filtre, le 2e run voyait le dépôt « sale » à cause
    // du run précédent et affichait un faux « uncommitted changes / dirty state »
    // (trompeur : les worktrees snapshotent HEAD, jamais l'arbre de travail).
    const ESSAIM_ARTIFACT = /^..\s+"?(runs|reports)\//;
    const meaningful = status.split("\n").filter((l) => l.trim() && !ESSAIM_ARTIFACT.test(l));
    isClean = meaningful.length === 0;
  } catch {}
  const sourceFiles = listSourceFiles(absPath, sourceDirs, lang.extensions, 50);
  const modules = findModules(absPath, sourceDirs);
  const partial = { path: absPath, language: lang.language, source_dirs: sourceDirs, test_dirs: testDirs, test_command: lang.test_command, source_files: sourceFiles, has_git: hasGit, is_clean: isClean, modules };
  return { ...partial, applicable_templates: computeApplicableTemplates(partial) };
}


