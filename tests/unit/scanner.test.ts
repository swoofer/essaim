import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { scanProject } from "../../src/orchestrator/scanner.js";

const TMP = `/tmp/test-scanner-${Date.now()}`;

function makeProject(files: Record<string, string>): string {
  const dir = path.join(TMP, Math.random().toString(36).slice(2));
  fs.mkdirSync(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  execSync("git init && git config user.email 'test@test.com' && git config user.name 'Test' && git add . && git commit -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

afterEach(() => { try { fs.rmSync(TMP, { recursive: true }); } catch {} });

describe("scanProject", () => {
  it("detects TypeScript project with vitest", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ devDependencies: { vitest: "^4.0.0", typescript: "^5.0.0" }, scripts: { test: "vitest run" } }),
      "tsconfig.json": "{}",
      "src/auth.ts": "export const x = 1;",
      "src/users.ts": "export const y = 2;",
      "tests/auth.test.ts": "test('x', () => {});",
    });
    const ctx = scanProject(dir);
    expect(ctx.language).toBe("typescript");
    expect(ctx.test_command).toContain("vitest");
    expect(ctx.source_dirs).toContain("src");
    expect(ctx.test_dirs).toContain("tests");
    expect(ctx.source_files.length).toBeGreaterThanOrEqual(2);
    expect(ctx.has_git).toBe(true);
    expect(ctx.is_clean).toBe(true);
  });

  it("detects Python project with pytest", () => {
    const dir = makeProject({
      "pyproject.toml": '[project]\\nname = "myapp"',
      "src/main.py": "def hello(): pass",
      "tests/test_main.py": "def test_hello(): pass",
    });
    const ctx = scanProject(dir);
    expect(ctx.language).toBe("python");
    expect(ctx.test_command).toContain("pytest");
  });

  it("detects Go project", () => {
    const dir = makeProject({
      "go.mod": "module example.com/app\\ngo 1.21",
      "pkg/auth/auth.go": "package auth",
    });
    const ctx = scanProject(dir);
    expect(ctx.language).toBe("go");
    expect(ctx.test_command).toBe("go test ./...");
    expect(ctx.source_dirs).toContain("pkg");
  });

  it("returns unknown for unrecognized project", () => {
    const dir = makeProject({ "README.md": "hello" });
    const ctx = scanProject(dir);
    expect(ctx.language).toBe("unknown");
  });

  it("detects dirty git state", () => {
    const dir = makeProject({ "src/a.ts": "1" });
    fs.writeFileSync(path.join(dir, "src/b.ts"), "2");
    const ctx = scanProject(dir);
    expect(ctx.has_git).toBe(true);
    expect(ctx.is_clean).toBe(false);
  });

  it("computes applicable templates", () => {
    const dir = makeProject({
      "package.json": JSON.stringify({ devDependencies: { vitest: "1", typescript: "^5.0.0" }, scripts: { test: "vitest" } }),
      "tsconfig.json": "{}",
      "src/a.ts": "x", "src/b.ts": "x", "src/c.ts": "x",
      "tests/a.test.ts": "t",
      "README.md": "# App",
    });
    const ctx = scanProject(dir);
    expect(ctx.applicable_templates).toContain("melee");
    expect(ctx.applicable_templates).toContain("babel");
    expect(ctx.applicable_templates).toContain("arene");
  });
});


describe("scanProject — is_clean ignore les artefacts essaim (#158)", () => {
  it("runs/ et reports/ non suivis ne salissent PAS le dépôt ; un vrai fichier, si", () => {
    const dir = makeProject({ "src/a.ts": "export const a = 1;\n" }); // dépôt propre, commité
    // essaim écrit SES artefacts (non suivis) dans le dépôt cible (#158) — ce ne
    // sont pas du travail utilisateur, is_clean doit rester vrai.
    fs.mkdirSync(path.join(dir, "runs", "run1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "runs", "run1", "w.txt"), "worktree");
    fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
    fs.writeFileSync(path.join(dir, "reports", "report-x.md"), "# r");
    expect(scanProject(dir).is_clean).toBe(true);

    // un VRAI fichier non suivi de l'utilisateur, lui, salit bien le dépôt
    fs.writeFileSync(path.join(dir, "user-wip.txt"), "en cours");
    expect(scanProject(dir).is_clean).toBe(false);
  });
});

describe("scanner — exclusion par segment + descente monorepo (#159)", () => {
  it("source_files : latest.ts/inspector.ts VISIBLES (exclusion par segment, pas substring)", () => {
    const dir = makeProject({
      "src/latest.ts": "export const a = 1;\n",      // « la·test » : PAS un test
      "src/inspector.ts": "export const b = 2;\n",   // « in·spec·tor » : PAS un test
      "src/foo.test.ts": "// vrai test\n",           // écarté (basename .test.)
      "tests/helper.ts": "export const h = 1;\n",    // écarté (segment tests/)
    });
    const files = scanProject(dir).source_files.map(f => f.replace(/\\/g, "/"));
    expect(files).toContain("src/latest.ts");
    expect(files).toContain("src/inspector.ts");
    expect(files).not.toContain("src/foo.test.ts");
    expect(files.some(f => f.startsWith("tests/"))).toBe(false);
  });

  it("monorepo pnpm : descente d'UN niveau ⇒ source_dirs non vide", () => {
    const dir = makeProject({
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
      "packages/pkg-a/src/index.ts": "export const a = 1;\n",
      "packages/pkg-b/src/main.ts": "export const b = 2;\n",
    });
    const dirs = scanProject(dir).source_dirs.map(d => d.replace(/\\/g, "/"));
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toContain("packages/pkg-a/src");
    expect(dirs).toContain("packages/pkg-b/src");
  });

  it("modules DÉDUPLIQUÉS sur un monorepo (sous-dossier partagé) — sinon collision d'IDs", () => {
    // Deux paquets ayant chacun un `components/` : sans dédup, context.modules
    // aurait deux « components » → per-module fabrique deux agents au même id.
    const dir = makeProject({
      "packages/pkg-a/src/components/a.ts": "export const a = 1;\n",
      "packages/pkg-b/src/components/b.ts": "export const b = 2;\n",
    });
    const modules = scanProject(dir).modules;
    expect(modules.filter(m => m === "components")).toHaveLength(1);
  });
});
