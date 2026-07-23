// src/security/secrets.ts — read engine secrets lazily from the operator's secrets file. The
// resulting map is handed to the adapter, which passes it into the CHILD process env only
// (see adapters/strix.ts / strix-cli.ts::strixEnv). Secrets are NEVER placed in essaim's own
// process.env, argv, prompts, threads, logs, or on disk (no more env-file: the child env channel
// replaces it).
import { readFileSync, existsSync } from "node:fs";

/** Parse a dotenv-style file into a map. Returns {} when no path is given or the file is absent. */
export function resolveEngineSecrets(secretsFile?: string): Record<string, string> {
  if (!secretsFile || !existsSync(secretsFile)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(secretsFile, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}
