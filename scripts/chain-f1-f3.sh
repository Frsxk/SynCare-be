#!/usr/bin/env bash
# Chain F1 -> F3 -> F4 so each flow receives the previous flow's real output.
# F3 refuses a hand-written payload because it requires F1's scored output.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="http://127.0.0.1:${LANGFLOW_PORT:-7860}"

run_raw() { # run_raw <flow_key> <input> -> /tmp/chain-<key>.json
  local key="$1" input="$2"
  local id
  id=$(python3 -c "import json;print(json.load(open('flows.json'))['$key'])")
  local code
  code=$(curl -s --max-time 200 -X POST "$BASE/api/v1/run/$id" \
    -H "x-api-key: $LANGFLOW_API_KEY" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys;print(json.dumps({'input_value':sys.argv[1]}))" "$input")" \
    -o "/tmp/chain-$key.json" -w '%{http_code}')
  echo "  $key http=$code bytes=$(wc -c < "/tmp/chain-$key.json")"
}

# Extract the terminal text payload from a v1 run response.
extract() {
  python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for o in d.get('outputs',[]):
    for item in (o.get('outputs') or []):
        res=item.get('results') or {}
        msg=res.get('message') or {}
        data=msg.get('data') or {}
        t=data.get('text')
        if t:
            sys.stdout.write(t); sys.exit(0)
sys.exit(1)
" "$1"
}

PATIENT="chf-chain-$(date -u +%H%M%S)"
echo "patient: $PATIENT"
echo

echo "1. F1 discharge summary"
run_raw f1_register_discharge_summary \
  "Pasien dengan CHF NYHA III, pulang 2026-10-01, minum furosemide 40mg harian, berat 82kg, eGFR 52, ada edema perifer ringan. Riwayat rawat inap 3 kali dalam 12 bulan terakhir, komorbiditas 4 (hipertensi, diabetes tipe 2, CKD, anemia)."

F1_TEXT=$(extract /tmp/chain-f1_register_discharge_summary.json)
if [ -z "$F1_TEXT" ]; then echo "F1 produced no text; aborting"; exit 1; fi
echo "  F1 tier/score: $(python3 -c "
import json,sys
d=json.loads(sys.argv[1]); print('tier=%s score=%s' % (d.get('tier'), d.get('score')))" "$F1_TEXT" 2>/dev/null || echo '(unparsed)')"

echo
echo "2. F3 draft plan (fed F1's real scored output)"
run_raw f3_draft_followup_plan "$F1_TEXT"

F3_TEXT=$(extract /tmp/chain-f3_draft_followup_plan.json)
if [ -z "$F3_TEXT" ]; then echo "F3 produced no text; aborting"; exit 1; fi
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
print('  status:', d.get('status'))
print('  label:', d.get('label'))
print('  missing_facts:', d.get('missing_facts'))
print('  plan_text:', (d.get('plan_text') or '')[:160])
print('  satuseshat keys:', list((d.get('satuseshat') or {}).keys()))
" "$F3_TEXT" 2>/dev/null || echo "  (F3 output not JSON)"

echo
echo "3. F4 review gate: starting the human-approval job"
F4_ID=$(python3 -c "import json;print(json.load(open('flows.json'))['f4_review_care_plan'])")
code=$(curl -s --max-time 120 -X POST "$BASE/api/v2/workflows" \
  -H "x-api-key: $LANGFLOW_API_KEY" -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json,sys
print(json.dumps({'flow_id':sys.argv[1],'input_value':sys.argv[2],'mode':'background'}))
" "$F4_ID" "$F3_TEXT")" -o /tmp/chain-f4-job.json -w '%{http_code}')
echo "  F4 v2 start http=$code"
python3 -c "
import json
d=json.load(open('/tmp/chain-f4-job.json'))
print('  job_id:', d.get('job_id'))
print('  status:', d.get('status'))
if 'detail' in d: print('  detail:', str(d['detail'])[:240])
" 2>/dev/null || head -c 240 /tmp/chain-f4-job.json

echo
echo "Saved: /tmp/chain-*.json"