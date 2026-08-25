#!/bin/bash
# BCE hook: session stop
# Marks the agent offline in the coordinator.
COORDINATOR_URL="${COORDINATOR_URL:-http://127.0.0.1:3100}"
AGENT_ID="${COORDINATOR_AGENT_ID:-unknown}"

if ! curl -s --max-time 2 "$COORDINATOR_URL/health" >/dev/null 2>&1; then
  exit 0
fi

curl -s --max-time 3 -X POST "$COORDINATOR_URL/api/session-stop" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$AGENT_ID" '{agent_id: $id}')" \
  >/dev/null 2>&1
