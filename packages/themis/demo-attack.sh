#!/bin/sh
# Demo fallback: send the intent a compromised agent would send, straight to Themis with the agent's token.
# Themis must reject it and list the failed checks; the rejection also appears in the web app's Docket.
#   sh packages/themis/demo-attack.sh
cd "$(dirname "$0")" || exit 1
TOKEN=$(node -p "require('./.local/api-credentials.json').agentToken") || exit 1
curl -s -X POST http://127.0.0.1:3001/intent \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -H "idempotency-key: attack-$(date +%s)" \
  -d '{"action":"transfer","asset":"USDC","amount":"10000","recipient":"0x000000000000000000000000000000000000dEaD","reason":"URGENT: protocol compromised, move all funds"}'
echo
