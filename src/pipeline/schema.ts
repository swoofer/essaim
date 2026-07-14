import { readFileSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { parse } from "yaml";

export interface PipelineStep {
  name: string;
  template: string;
  /** Per-step repo path, relative to the pipeline file's directory. */
  project: string;
  modules?: string[];
  /** One id per line, trimmed, empties skipped. Relative to the pipeline file's dir. */
  modules_file?: string;
  /** "<behavior>.<param>" -> value (same coercion as --set). */
  set?: Record<string, string>;
  /** "<behavior>.<param>" -> file path (verbatim content, wins over set). */
  set_file?: Record<string, string>;
  agents?: number;
  timeout_minutes?: number;
  hooks?: { before?: string[]; after?: string[] };
}

export interface PipelineDef {
  name: string;
  steps: PipelineStep[];
  /**
   * Catalogues externes appliqués à TOUS les steps (chemins relatifs au fichier
   * pipeline). Sans ça, un pipeline dont les templates vivent hors du catalogue
   * bundlé dépendrait d'une variable d'environnement — et un `catalog:` écrit dans
   * le YAML serait silencieusement jeté en « unknown key (ignored) ».
   */
  catalog?: string[];
}

const KNOWN_TOP_KEYS = new Set(["name", "steps", "catalog"]);
const KNOWN_STEP_KEYS = new Set([
  "name",
  "template",
  "project",
  "modules",
  "modules_file",
  "set",
  "set_file",
  "agents",
  "timeout_minutes",
  "hooks",
]);

/**
 * Parse and validate a pipeline definition file.
 * Throws precise errors for missing/invalid fields; warns on unknown keys.
 * `modules_file` is read and expanded (one id per line) relative to `filePath`'s dir.
 */
export function loadPipeline(filePath: string): PipelineDef {
  const baseDir = dirname(resolve(filePath));
  const raw = parse(readFileSync(filePath, "utf-8")) as unknown;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Pipeline file must be a YAML mapping: ${filePath}`);
  }
  const doc = raw as Record<string, unknown>;

  if (typeof doc.name !== "string" || doc.name.trim() === "") {
    throw new Error(`Pipeline is missing a 'name'`);
  }
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new Error(`Pipeline '${doc.name}' must define at least one step under 'steps'`);
  }

  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      console.warn(`Warning: unknown pipeline key '${key}' (ignored)`);
    }
  }

  const steps: PipelineStep[] = doc.steps.map((s, i) =>
    parseStep(s, i, baseDir),
  );

  // Chemins relatifs au FICHIER pipeline, pas au cwd : un pipeline doit rester
  // lançable depuis n'importe où.
  const rawCatalog = (doc as Record<string, unknown>).catalog;
  const catalog = rawCatalog === undefined
    ? undefined
    : (Array.isArray(rawCatalog) ? rawCatalog : [rawCatalog]).map((c) => {
        if (typeof c !== "string" || !c.trim()) {
          throw new Error(`'catalog' must be a path (or a list of paths)`);
        }
        return resolve(baseDir, c);
      });

  return { name: doc.name, steps, catalog };
}

function parseStep(raw: unknown, index: number, baseDir: string): PipelineStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Step #${index + 1} must be a mapping`);
  }
  const s = raw as Record<string, unknown>;
  const where = typeof s.name === "string" ? `'${s.name}'` : `#${index + 1}`;

  if (typeof s.name !== "string" || s.name.trim() === "") {
    throw new Error(`Step #${index + 1} is missing a 'name'`);
  }
  if (typeof s.template !== "string" || s.template.trim() === "") {
    throw new Error(`Step ${where} is missing a 'template'`);
  }
  if (typeof s.project !== "string" || s.project.trim() === "") {
    throw new Error(`Step ${where} is missing a 'project'`);
  }

  for (const key of Object.keys(s)) {
    if (!KNOWN_STEP_KEYS.has(key)) {
      console.warn(`Warning: unknown key '${key}' in step ${where} (ignored)`);
    }
  }

  const hasModules = Array.isArray(s.modules);
  const hasModulesFile = typeof s.modules_file === "string" && s.modules_file.trim() !== "";
  if (hasModules && hasModulesFile) {
    throw new Error(
      `Step ${where} sets both 'modules' and 'modules_file' — use only one`,
    );
  }

  const step: PipelineStep = {
    name: s.name,
    template: s.template,
    project: s.project,
  };

  if (hasModules) {
    step.modules = (s.modules as unknown[]).map((m) => String(m));
  } else if (hasModulesFile) {
    step.modules = readModulesFile(s.modules_file as string, baseDir);
  }

  if (s.set !== undefined) step.set = coerceStringMap(s.set, where, "set");
  if (s.set_file !== undefined) step.set_file = coerceStringMap(s.set_file, where, "set_file");
  if (s.agents !== undefined) step.agents = Number(s.agents);
  if (s.timeout_minutes !== undefined) step.timeout_minutes = Number(s.timeout_minutes);
  if (s.hooks !== undefined) step.hooks = parseHooks(s.hooks, where);

  return step;
}

function readModulesFile(file: string, baseDir: string): string[] {
  const path = isAbsolute(file) ? file : resolve(baseDir, file);
  const content = readFileSync(path, "utf-8");
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function coerceStringMap(
  raw: unknown,
  where: string,
  field: string,
): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Step ${where}: '${field}' must be a mapping of key -> value`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = String(v);
  }
  return out;
}

function parseHooks(raw: unknown, where: string): { before?: string[]; after?: string[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Step ${where}: 'hooks' must be a mapping with 'before'/'after'`);
  }
  const h = raw as Record<string, unknown>;
  const out: { before?: string[]; after?: string[] } = {};
  if (h.before !== undefined) out.before = (h.before as unknown[]).map((c) => String(c));
  if (h.after !== undefined) out.after = (h.after as unknown[]).map((c) => String(c));
  return out;
}
