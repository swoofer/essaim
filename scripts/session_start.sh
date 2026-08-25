#!/bin/bash
# BCE hook: session start
# Registers the agent with the coordinator and prints the briefing
# to stdout so Claude sees it in its context on SessionStart.
COORDINATOR_URL="${COORDINATOR_URL:-http://127.0.0.1:3100}"
AGENT_ID="${COORDINATOR_AGENT_ID:-unknown}"
AGENT_NAME="${COORDINATOR_AGENT_NAME:-unknown}"
AGENT_MODULES="${COORDINATOR_AGENT_MODULES:-}"

if ! curl -s --max-time 2 "$COORDINATOR_URL/health" >/dev/null 2>&1; then
  echo "BCE: coordinator unreachable at $COORDINATOR_URL (session-start skipped)"
  exit 0
fi

MODULES_JSON="[]"
if [ -n "$AGENT_MODULES" ]; then
  MODULES_JSON=$(echo "$AGENT_MODULES" | jq -R -c 'split(",") | map(select(length > 0))')
fi

curl -s --max-time 3 -X POST "$COORDINATOR_URL/api/register" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$AGENT_ID" --arg name "$AGENT_NAME" --argjson modules "$MODULES_JSON" \
    '{agent_id: $id, name: $name, modules: $modules}')" \
  >/dev/null 2>&1

BRIEFING_RESPONSE=$(curl -s --max-time 3 -X POST "$COORDINATOR_URL/api/session-start" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$AGENT_ID" --arg name "$AGENT_NAME" \
    '{agent_id: $id, agent_name: $name}')")

if [ -z "$BRIEFING_RESPONSE" ]; then
  echo "BCE: no response from /api/session-start"
  exit 0
fi

BRIEFING=$(echo "$BRIEFING_RESPONSE" | jq -r '.briefing // ""' 2>/dev/null)
if [ -n "$BRIEFING" ]; then
  echo "## Coordinator briefing"
  echo ""
  echo "$BRIEFING"
fi
