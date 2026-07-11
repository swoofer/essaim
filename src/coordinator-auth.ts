import { existsSync, readFileSync, writeFileSync } from "fs";

/**
 * Bearer token for a secured external coordinator (e.g. the k3s deployment).
 * Read from COORDINATOR_TOKEN. Absent/blank = auth disabled (local dev,
 * in-process coordinator) — every consumer degrades to today's behavior.
 */
export function coordinatorToken(): string | undefined {
  const t = process.env.COORDINATOR_TOKEN?.trim();
  return t ? t : undefined;
}

export function authHeaders(): Record<string, string> {
  const token = coordinatorToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Post-write patch for .mcp.json files produced by essaim or promptweave:
 * adds Authorization headers to every http server whose url ends in /mcp
 * (the coordinator), leaving other servers untouched.
 */
export function patchMcpJsonAuth(mcpJsonPath: string): void {
  const headers = authHeaders();
  if (Object.keys(headers).length === 0) return;
  if (!existsSync(mcpJsonPath)) return;
  let doc: { mcpServers?: Record<string, Record<string, unknown>> };
  try {
    doc = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
  } catch {
    return;
  }
  if (!doc.mcpServers) return;
  for (const server of Object.values(doc.mcpServers)) {
    if (server.type === "http" && typeof server.url === "string" && server.url.endsWith("/mcp")) {
      server.headers = { ...(server.headers as Record<string, string> | undefined), ...headers };
    }
  }
  writeFileSync(mcpJsonPath, JSON.stringify(doc, null, 2) + "\n");
}
