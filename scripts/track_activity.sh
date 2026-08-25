#!/bin/bash
# BCE hook: track file activity
# Called by Claude Code as a PostToolUse hook.
# Claude Code passes hook input as JSON on stdin, not positional args.
# See: https://code.claude.com/docs/en/hooks.md
COORDINATOR_URL="${COORDINATOR_URL:-http://127.0.0.1:3100}"
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

# Normalize a path to repo-relative, forward-slash form.
# In team-mode the coordinator is on a different machine and cannot resolve the
# agent's local repo root; only this client can.
#
# Kept as a function so tests can source it without triggering the hook's
# stdin/curl side effects — see tests/track_activity_path_normalization.test.sh.
normalize_file_path() {
  local p="$1"
  [ -z "$p" ] && { printf '%s' "$p"; return; }

  # Backslashes first, so `dirname` and the comparisons below see one form.
  p="${p//\\//}"

  local dir base dir_real root root_real super guard
  dir=$(dirname "$p")
  base=$(basename "$p")

  # Both sides are resolved through the SAME `cd` + `pwd -P`, and that is the
  # whole point. Comparing the raw strings cannot work under Git Bash: the hook
  # is handed `/tmp/x/repo/src/foo.ts` (MSYS form) while `git rev-parse` answers
  # `C:/Users/…/Temp/x/repo` (Windows form). Different namespaces for the same
  # directory — the prefix test never matched, the strip never happened, and the
  # coordinator received an ABSOLUTE path it cannot match against anything.
  # That made conflict detection silently blind on Windows, backslashes or not
  # (#100, wider than reported).
  dir_real=$(cd "$dir" 2>/dev/null && pwd -P) || dir_real=""
  [ -z "$dir_real" ] && { printf '%s' "$p"; return; }

  root=$(cd "$dir_real" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
  [ -z "$root" ] && { printf '%s' "$p"; return; }

  # Walk up to the OUTERMOST superproject. `--show-superproject-working-tree`
  # only ever returns the IMMEDIATE one, so a submodule nested two levels deep
  # still reported paths relative to the middle repo. The guard bounds a
  # pathological loop; real nests are two or three deep.
  guard=0
  while [ "$guard" -lt 16 ]; do
    super=$(cd "$root" 2>/dev/null && git rev-parse --show-superproject-working-tree 2>/dev/null)
    [ -z "$super" ] && break
    root="$super"
    guard=$((guard + 1))
  done

  root_real=$(cd "$root" 2>/dev/null && pwd -P) || root_real=""
  [ -z "$root_real" ] && { printf '%s' "$p"; return; }

  if [ "$dir_real" = "$root_real" ]; then
    printf '%s' "$base"
  elif [[ "$dir_real" == "$root_real"/* ]]; then
    printf '%s' "${dir_real#"$root_real"/}/$base"
  else
    printf '%s' "$p"
  fi
}

if [ -n "$FILE_PATH" ] && [ "$FILE_PATH" != "null" ]; then
  FILE_PATH=$(normalize_file_path "$FILE_PATH")
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
