#!/usr/bin/env bash
# Live-run every SynCare flow against the running Langflow and record the result.
#
# Usage: bash scripts/smoke-all-flows.sh
# Writes docs/flow-run-log.md
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

BASE="http://127.0.0.1:${LANGFLOW_PORT:-7860}"
PATIENT="chf-smoke-$(date -u +%H%M%S)"

run() { # run <flow_key> <label> <input>
  local key="$1" label="$2" input="$3"
  local id
  id=$(python3 -c "import json;print(json.load(open('flows.json')).get('$key',''))")
  if [ -z "$id" ]; then echo "  MISSING flow id for $key"; return 1; fi

  echo "--- $label ($key)"
  local start end code
  start=$(date +%s)
  code=$(curl -s --max-time 200 -X POST "$BASE/api/v1/run/$id" \
    -H "x-api-key: $LANGFLOW_API_KEY" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys;print(json.dumps({'input_value':sys.argv[1]}))" "$input")" \
    -o "/tmp/run-$key.json" -w '%{http_code}')
  end=$(date +%s)

  echo "    http=$code  elapsed=$((end-start))s  bytes=$(wc -c < "/tmp/run-$key.json")"
  python3 -c "
import json,sys
d=json.load(open('/tmp/run-$key.json'))
if 'detail' in d:
    print('    ERROR:', str(d['detail'])[:220].replace(chr(10),' '))
    sys.exit(0)
# v1 run shape: outputs[0].outputs[0].results.message.data.text
try:
    for o in d['outputs']:
        for item in (o.get('outputs') or []):
            res = item.get('results') or {}
            msg = res.get('message') or {}
            data = msg.get('data') or {}
            txt = data.get('text') or data.get('messages')
            if txt:
                s = txt if isinstance(txt,str) else json.dumps(txt, ensure_ascii=False)
                print('    OUT:', s[:300].replace(chr(10),' '))
except Exception as e:
    print('    (shape:', type(e).__name__, ')')
"
}

echo "=== SynCare live flow smoke run ==="
echo "patient: $PATIENT"
echo

run f1_register_discharge_summary "F1 register discharge" \
  "Pasien dengan CHF NYHA III, pulang 2026-10-01, minum furosemide 40mg harian, berat 82kg, eGFR 52, ada edema perifer ringan."

run f2_record_patient_checkin "F2 routine check-in" \
  "{\"patient_id\":\"$PATIENT\",\"message\":\"Merasa lebih baik, obat teratur diminum.\"}"

run f2_record_patient_checkin "F2 RED FLAG check-in" \
  "{\"patient_id\":\"$PATIENT\",\"message\":\"Nyeri dada berat dan sesak napas sejak semalam.\"}"

run f3_draft_followup_plan "F3 draft plan" \
  "{\"patient_id\":\"$PATIENT\",\"episode\":{\"diagnosis\":\"CHF NYHA III\",\"medications\":[\"furosemide 40mg harian\"]}}"
