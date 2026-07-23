// src/agent-loop/child-env.ts — build a spawned claude child's env from an explicit ALLOWLIST
// instead of spreading process.env, so engine secrets (LLM_API_KEY, STRIX_LLM, …) never leak into
// agent processes/hooks. options.env always wins.

// Exact keys the claude child + essaim rely on.
const ALLOW_EXACT = new Set([
  "PATH", "Path", "PATHEXT",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR",
  "SYSTEMROOT", "SystemDrive", "WINDIR", "COMSPEC", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "CommonProgramFiles",
  "LANG", "LC_ALL", "SHELL", "TERM", "USER", "USERNAME", "LOGNAME",
  "DEBUG", "LOG_LEVEL", "NODE_ENV",
  // Proxy config — the claude child may need it to reach the Anthropic API on corp networks.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  // TLS/Node runtime config — corp proxy CA trust, Node runtime flags, XDG dirs, custom module paths.
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NODE_PATH",
]);

// Prefix families that belong to claude / anthropic / essaim / the coordinator (not engines).
const ALLOW_PREFIX = ["ANTHROPIC_", "CLAUDE_", "COORDINATOR_", "ESSAIM_", "AWS_", "NVM_", "FNM_", "VOLTA_", "ASDF_"];

function isAllowed(key: string): boolean {
  if (ALLOW_EXACT.has(key)) return true;
  return ALLOW_PREFIX.some((p) => key.startsWith(p));
}

export function buildChildEnv(parentEnv: NodeJS.ProcessEnv, optionsEnv: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v !== undefined && isAllowed(k)) out[k] = v;
  }
  // options.env always wins (explicit per-agent overrides like COORDINATOR_AGENT_ID).
  return { ...out, ...optionsEnv };
}
