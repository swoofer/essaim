#!/bin/bash
# BCE hook: check for coordination interrupts
# Called as PreToolUse (before Edit/Write) and PostToolUse (after Edit/Write).
# If a thread is waiting for this agent's response, outputs a message that
# Claude sees in its context — triggering it to respond before continuing.
COORDINATOR_URL="${COORDINATOR_URL:-http://127.0.0.1:3100}"
AGENT_ID="${COORDINATOR_AGENT_ID:-unknown}"

if [ "$AGENT_ID" = "unknown" ]; then
  exit 0
fi

RESPONSE=$(curl -s --max-time 2 -X POST "$COORDINATOR_URL/api/check-interrupt" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg id "$AGENT_ID" '{agent_id: $id}')" 2>/dev/null)

if [ -z "$RESPONSE" ]; then
  exit 0
fi

INTERRUPT=$(echo "$RESPONSE" | jq -r '.interrupt // false' 2>/dev/null)
if [ "$INTERRUPT" = "true" ]; then
  echo ""
  echo "⚠️ COORDINATION INTERRUPT"
  echo ""
  echo "$RESPONSE" | jq -r '.threads[] | "Thread \(.thread_id) — \(.subject)\n  Status: \(.status) | Initiateur: \(.initiator_id)\n  Fichiers: \(.target_files | join(", "))\n  → Appelle get_thread(thread_id=\"\(.thread_id)\") pour lire les détails\n  → Puis post_to_thread pour répondre (ou approve_resolution/contest_resolution si status=resolving)\n"' 2>/dev/null
fi
