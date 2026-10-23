#!/usr/bin/env bash
# F5 live test: grounded answers for an approved patient, refusal for anyone else.
# F5 requires both an approved_plans row and a matching Approve audit entry.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="http://127.0.0.1:${LANGFLOW_PORT:-7860}"
F5=$(python3 -c "import json;print(json.load(open('flows.json'))['f5_answer_care_questions'])")

APPROVED=$(python3 -c "
import sqlite3, json
c=sqlite3.connect('file:data/langflow/langflow/syncare-review.sqlite3?mode=ro', uri=True)
rows=c.execute('select plan_json from approved_plans').fetchall()
if not rows: raise SystemExit('NO_APPROVED_PATIENT')
d=json.loads(rows[0][0])
print(d.get('patient_id') or (d.get('source_input') or {}).get('patient_id') or '')
" 2>/dev/null)

if [ -z "$APPROVED" ]; then
  echo "!! No approved patient found. Run scripts/chain-full.sh first (it approves one)."
  exit 1
fi
echo "approved patient in review DB: $APPROVED"

ask() { # ask <patient_id> <question> <label> <outfile-suffix>
  local pid="$1" q="$2" label="$3" suffix="$4"
  echo
  echo "--- $label (patient_id=$pid)"
  local code
  code=$(curl -s --max-time 280 -X POST "$BASE/api/v1/run/$F5" \
    -H "x-api-key: $LANGFLOW_API_KEY" -H 'Content-Type: application/json' \
    -d "$(python3 -c "
import json,sys
print(json.dumps({'input_value':json.dumps({'patient_id':sys.argv[1],'query':sys.argv[2]}, ensure_ascii=False)}))
" "$pid" "$q")" \
    -o "/tmp/f5-$suffix.json" -w '%{http_code}')
  echo "    http=$code bytes=$(wc -c < /tmp/f5-$suffix.json)"
  python3 -c "
import json
d=json.load(open('/tmp/f5-$suffix.json'))
if 'detail' in d:
    print('    ERROR:', str(d['detail'])[:300].replace(chr(10),' ')); raise SystemExit
for o in d.get('outputs',[]):
    for it in (o.get('outputs') or []):
        t=((it.get('results') or {}).get('message') or {}).get('data',{}).get('text')
        if t: print('    ANS:', t[:600]); raise SystemExit
print('    (no terminal text)')
"
}

ask "$APPROVED" "Apa saja kegiatan perawatan yang harus saya lakukan setiap hari?" "APPROVED patient (must answer, grounded)" approved
ask "patient-not-approved-xyz" "Apa saja kegiatan perawatan harian saya?" "UNAPPROVED patient (must refuse)" denied
echo
echo "Saved: /tmp/f5-approved.json /tmp/f5-denied.json"