#!/usr/bin/env bash
# Upsert Langflow global Variables from ~/.env.langflow.
# Values are never echoed, logged, or written to this repo.
set -euo pipefail

cd "$(dirname "$0")/.."
SECRETS_FILE="${SYNCARE_SECRETS_FILE:-$HOME/.env.langflow}"

[ -f "$SECRETS_FILE" ] || { echo "Missing $SECRETS_FILE"; exit 2; }
chmod 600 "$SECRETS_FILE"

set -a; . "$SECRETS_FILE"; set +a
set -a; . ./.env; set +a

BASE="http://127.0.0.1:${LANGFLOW_PORT:-7860}"

: "${GEMINI_API_KEY:?GEMINI_API_KEY missing from $SECRETS_FILE}"
: "${ASTRA_DB_API_ENDPOINT:?ASTRA_DB_API_ENDPOINT missing from $SECRETS_FILE}"
: "${ASTRA_DB_API_TOKEN:?ASTRA_DB_API_TOKEN missing from $SECRETS_FILE}"

echo "==> Authenticating as $LANGFLOW_SUPERUSER"
TOKEN=$(curl -s --max-time 20 -X POST "$BASE/api/v1/login" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=$LANGFLOW_SUPERUSER" \
  --data-urlencode "password=$LANGFLOW_SUPERUSER_PASSWORD" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# upsert <name> <type> <value>
# The Variables API requires `default_fields` on create/update (422 otherwise);
# an empty list means "global, not bound to specific component fields".
upsert() {
  local name="$1" vtype="$2" value="$3"
  local existing payload
  existing=$(curl -s --max-time 20 "$BASE/api/v1/variables/" \
    -H "Authorization: Bearer $TOKEN" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d if isinstance(d, list) else d.get('items', d.get('variables', []))
for v in items:
    if v.get('name') == '$name':
        print(v['id']); break
")

  payload=$(python3 -c "
import json, sys
print(json.dumps({
    'name': sys.argv[1],
    'value': sys.argv[2],
    'type': sys.argv[3],
    'default_fields': [],
}))
" "$name" "$value" "$vtype")

  if [ -n "$existing" ]; then
    curl -s --max-time 20 -X PATCH "$BASE/api/v1/variables/$existing" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$payload" -o /dev/null -w "  updated $name (%{http_code})\n"
  else
    curl -s --max-time 20 -X POST "$BASE/api/v1/variables/" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$payload" -o /dev/null -w "  created $name (%{http_code})\n"
  fi
}

echo "==> Setting global Variables (values never printed)"
upsert GEMINI_API_KEY          Credential "$GEMINI_API_KEY"
upsert ASTRA_DB_API_ENDPOINT   Generic    "$ASTRA_DB_API_ENDPOINT"
upsert ASTRA_DB_APPLICATION_TOKEN Credential "$ASTRA_DB_API_TOKEN"

echo "==> Verifying (names + emptiness only)"
curl -s --max-time 20 "$BASE/api/v1/variables/" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
items = d if isinstance(d, list) else d.get('items', d.get('variables', []))
for v in items:
    val = v.get('value')
    print(f\"  {v.get('name'):28} {'SET' if val else 'EMPTY'}\")
"
echo "Done. Restart Langflow so every component re-reads the Variables."
rm -f /tmp/tok