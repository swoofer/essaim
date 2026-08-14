#!/bin/bash
# v0.6: PreToolUse hook — POST /api/working-files/start when an Edit/Write/NotebookEdit tool is about to run.
# Called by Claude Code as a PreToolUse hook.
# Claude Code passes hook input as JSON on stdin, not positional args.
# See: https://code.claude.com/docs/en/hooks.md
COORDINATOR_URL="${COORDINATOR_URL:-http://localhost:3100}"
AGENT_ID="${COORDINATOR_AGENT_ID:-unknown}"

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

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Normalize a path to repo-relative, forward-slash form.
# In team-mode the coordinator is on a different machine and cannot resolve the
# agent's local repo root; only this client can.
#
# Byte-identical to track_activity.sh's copy on purpose: the two hooks must
# agree on the path they report, or the coordinator sees two different names
# for one file. tests/track_activity_path_normalization.test.sh pins both.
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
  # coordinator received an ABSOLUTE path it cannot match against anything
  # (#100, wider than reported).
  dir_real=$(cd "$dir" 2>/dev/null && pwd -P) || dir_real=""
  [ -z "$dir_real" ] && { printf '%s' "$p"; return; }

  root=$(cd "$dir_real" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null)
  [ -z "$root" ] && { printf '%s' "$p"; return; }

  # Walk up to the OUTERMOST superproject: `--show-superproject-working-tree`
  # only ever returns the IMMEDIATE one.
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

curl -s --max-time 2 -X POST "$COORDINATOR_URL/api/working-files/start" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg aid "$AGENT_ID" \
    --arg file "$FILE_PATH" \
    '{agent_id: $aid, file_path: $file}')" \
  >/dev/null 2>&1 || true
