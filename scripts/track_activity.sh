#!/bin/bash
# BCE hook: track file activity
# Called by Claude Code as a PostToolUse hook.
# Claude Code passes hook input as JSON on stdin, not positional args.
# See: https://code.claude.com/docs/en/hooks.md
COORDINATOR_URL="${COORDINATOR_URL:-http://localhost:3100}"
AGENT_ID="${COORDINATOR_AGENT_ID:-unknown}"
AGENT_NAME="${COORDINATOR_AGENT_NAME:-unknown}"

# Auth: when COORDINATOR_TOKEN is set, send it as a bearer token (same
# convention as the TS side — see src/coordinator-auth.ts). Unset = no header.
AUTH_HEADER=()
if [ -n "${COORDINATOR_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer $COORDINATOR_TOKEN")
fi

# Returns success (0) if FILE_PATH looks like it may hold secrets, in which
# case its raw content must never be shipped to the coordinator — team-mode
# sends this payload to a different host. File-activity tracking still
# happens; only the content field is withheld.
is_sensitive_path() {
  local path="$1"
  local base path_lc base_lc
  base=$(basename -- "$path")
  path_lc=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
  base_lc=$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')

  case "$path_lc" in
    */.ssh/*|.ssh/*|*/.aws/*|.aws/*) return 0 ;;
  esac

  case "$base_lc" in
    .env|.env.*) return 0 ;;
    *.pem|*.key|*.p12|*.pfx|*.keystore) return 0 ;;
    id_rsa|id_rsa.*|id_dsa|id_dsa.*|id_ecdsa|id_ecdsa.*|id_ed25519|id_ed25519.*) return 0 ;;
    kubeconfig|*.kubeconfig) return 0 ;;
    credentials|credentials.*) return 0 ;;
    .netrc|.npmrc|.pypirc) return 0 ;;
    *secret*) return 0 ;;
  esac

  return 1
}

INPUT=$(cat 2>/dev/null)
if [ -z "$INPUT" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
case "$TOOL_NAME" in
  Edit|Write|NotebookEdit) ;;
  *) exit 0 ;;
esac

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // ""' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Normalize FILE_PATH to repo-relative, forward-slash form.
# In team-mode the coordinator is on a different machine and cannot
# resolve the agent's local repo root; only this client can.
if [ -n "$FILE_PATH" ] && [ "$FILE_PATH" != "null" ]; then
  # Prefer the SUPERPROJECT root when this file lives inside a submodule, so
  # paths reported to the coordinator are workspace-relative (relative to the
  # outer working tree, e.g. a nested multi-repo workspace) rather than
  # submodule-relative. Falls back to the repo toplevel in a normal checkout.
  REPO_ROOT=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && git rev-parse --show-superproject-working-tree 2>/dev/null)
  [ -z "$REPO_ROOT" ] && REPO_ROOT=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$REPO_ROOT" ] && [[ "$FILE_PATH" == "$REPO_ROOT"/* ]]; then
    FILE_PATH="${FILE_PATH#$REPO_ROOT/}"
  fi
  FILE_PATH="${FILE_PATH//\\//}"
fi

# v0.6: include file content in the payload if under 256 KB and not sensitive
SIZE=$(stat -c%s "$FILE_PATH" 2>/dev/null || stat -f%z "$FILE_PATH" 2>/dev/null || echo 999999)
if is_sensitive_path "$FILE_PATH"; then
  CONTENT="null"
elif [ "$SIZE" -lt 262144 ] && [ -f "$FILE_PATH" ]; then
  CONTENT=$(jq -Rs . < "$FILE_PATH" 2>/dev/null || echo "null")
else
  CONTENT="null"
fi

curl -s --max-time 1 -X POST "$COORDINATOR_URL/api/log-file" \
  "${AUTH_HEADER[@]}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg sid "$SESSION_ID" \
    --arg aid "$AGENT_ID" \
    --arg aname "$AGENT_NAME" \
    --arg tool "$TOOL_NAME" \
    --arg file "$FILE_PATH" \
    --argjson content "$CONTENT" \
    '{session_id: $sid, agent_id: $aid, agent_name: $aname, tool_name: $tool, file: $file, content: $content}')" \
  >/dev/null 2>&1 &

# v0.6: notify coordinator that this agent has stopped editing the file
curl -s --max-time 2 -X POST "$COORDINATOR_URL/api/working-files/stop" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg aid "$AGENT_ID" \
    --arg file "$FILE_PATH" \
    '{agent_id: $aid, file_path: $file}')" \
  >/dev/null 2>&1 || true
