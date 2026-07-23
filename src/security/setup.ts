// src/security/setup.ts — idempotent security scaffolding for `essaim init --security`.
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { SECURITY_CONFIG_REL } from "./config.js";
import { createLogger } from "../logger.js";

const log = createLogger("security");

const CONFIG_TEMPLATE = `version: 1
engines: [strix]
scan_mode: quick
scope:
  mode: diff
  diff_base: ""
  exclude_paths: ["node_modules/**", "**/*fixtures*/**", "vendor/**"]
authorization:
  affirmed: false        # <-- set true (or pass --authorize) to affirm you own/are authorized to scan this repo
  authorized_by: ""      # name + engagement/ticket ref (audit)
`;

const ENV_TEMPLATE = `# Engine credentials for security scans — 0600, gitignored, NEVER committed.
# Fill values; passed only into the engine process's own env, never to disk or essaim's process.env.
# Strix prereqs (operator installs): pip install strix-agent (Python >=3.12) + a running Docker daemon.
LLM_API_KEY=
STRIX_LLM=anthropic/claude-sonnet-4-6

# Optional — route Strix through a custom OpenAI-compatible endpoint (e.g. a local proxy).
# NOTE: essaim's own fix-swarm already runs on your Claude subscription (claude -p); this is only
# for Strix's own scanning LLM. Using a subscription-backed proxy for a third-party tool may be
# against Anthropic's usage terms — verify before relying on it.
#   STRIX_LLM=openai/<model-name>
#   LLM_API_BASE=http://localhost:1234/v1     # adjust host/port to your proxy
# Optional tuning Strix honors: STRIX_REASONING_EFFORT=medium  LLM_TIMEOUT=300  PERPLEXITY_API_KEY=
`;

const GITIGNORE_BLOCK = [
  "# --- essaim security (managed) ---",
  ".essaim/security.yaml",
  ".security-env",
  "reports/security/",
  ".essaim/security/*", // ignore the DIR CONTENTS (with /*), so the negation below can re-include one file.
  "!.essaim/security/baseline.json", // baseline is committed (team shares suppressions)
  "# --- end essaim security ---",
].join("\n");

const GITIGNORE_MARKER = "# --- essaim security (managed) ---";

function writeIfAbsent(path: string, contents: string): void {
  if (existsSync(path)) {
    log.info(`${path} already exists -- skipped`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  log.info(`Wrote ${path}`);
}

export function setupSecurity(projectPath: string): void {
  writeIfAbsent(join(projectPath, SECURITY_CONFIG_REL), CONFIG_TEMPLATE);
  writeIfAbsent(join(projectPath, ".security-env"), ENV_TEMPLATE);

  const giPath = join(projectPath, ".gitignore");
  const existing = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  if (existing.includes(GITIGNORE_MARKER)) {
    log.info(".gitignore security block already present -- skipped");
    return;
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  appendFileSync(giPath, `${prefix}${GITIGNORE_BLOCK}\n`);
  log.info("Patched .gitignore with the essaim security block");
}
