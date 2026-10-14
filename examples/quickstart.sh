#!/usr/bin/env bash
# agy-bridge demo: models list + one tiny completion. Needs:
#   export AGY_BRIDGE_KEY=<your apiKey from agy-bridge.json>
#   bridge running: systemctl --user start agy-bridge
set -u
: "${AGY_BRIDGE_KEY:?set AGY_BRIDGE_KEY first}"
BASE="${AGY_BRIDGE_URL:-http://127.0.0.1:8766}"
SESS="demo-$(date +%s)"
echo "### models"
curl -s -H "Authorization: Bearer $AGY_BRIDGE_KEY" "$BASE/v1/models" \
  | python3 -c "import json,sys; print('\n'.join(' - '+m['id'] for m in json.load(sys.stdin)['data'][:8]))"
echo "### one completion"
curl -s -H "Authorization: Bearer $AGY_BRIDGE_KEY" -H 'Content-Type: application/json' \
  "$BASE/v1/chat/completions" \
  -d "{\"model\":\"gemini-3.8-flash-low\",\"messages\":[{\"role\":\"user\",\"content\":\"reply with exactly: DEMO-OK\"}],\"user\":\"$SESS\"}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'].strip(), '| usage:', d.get('usage'))"
