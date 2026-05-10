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

curl -s --max-time 2 -X POST "$COORDINATOR_URL/api/working-files/start" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg aid "$AGENT_ID" \
    --arg file "$FILE_PATH" \
    '{agent_id: $aid, file_path: $file}')" \
  >/dev/null 2>&1 || true
