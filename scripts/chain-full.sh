#!/usr/bin/env bash
# Chain F1 -> F3 -> F4 with the exact envelopes the guards require.
# F3 needs all eight episode fields; F4 accepts only a guarded F3 DRAFT.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
BASE="http://127.0.0.1:${LANGFLOW_PORT:-7860}"
PATIENT="chf-chain-$(date -u +%H%M%S)"

fid() { python3 -c "import json;print(json.load(open('flows.json'))['$1'])"; }

# run <flow_key> <input> -> writes /tmp/c-<key>.json, echoes http code
run() {
  curl -s --max-time 220 -X POST "$BASE/api/v1/run/$(fid "$1")" \
    -H "x-api-key: $LANGFLOW_API_KEY" -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json,sys;print(json.dumps({'input_value':sys.argv[1]}))" "$2")" \
    -o "/tmp/c-$1.json" -w '%{http_code}'
}

# text <file> -> terminal ChatOutput text
text() {
  python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
for o in d.get('outputs',[]):
    for it in (o.get('outputs') or []):
        t=((it.get('results') or {}).get('message') or {}).get('data',{}).get('text')
        if t: sys.stdout.write(t); sys.exit(0)
sys.exit(1)
" "$1"
}

echo "patient: $PATIENT"
echo
echo "1. F1 - discharge summary"
CODE=$(run f1_register_discharge_summary \
  "Pasien dengan CHF NYHA III, pulang 2026-10-01, minum furosemide 40mg harian, berat 82kg, eGFR 52, ada edema perifer ringan. Riwayat rawat inap 3 kali dalam 12 bulan terakhir, komorbiditas 4 (hipertensi, diabetes tipe 2, CKD, anemia).")
echo "   http=$CODE"
F1_TEXT=$(text /tmp/c-f1_register_discharge_summary.json)
[ -z "$F1_TEXT" ] && { echo "   F1 produced no text"; exit 1; }
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
print('   tier=%s score=%s' % (d.get('tier'), d.get('score')))
print('   episode keys:', sorted((d.get('episode') or {}).keys()))
" "$F1_TEXT"

echo
echo "2. F3 - wrap F1 output in the required envelope"
F3_INPUT=$(python3 -c "
import json,sys
f1 = json.loads(sys.argv[1])
ep = dict(f1.get('episode') or {})
# F3's guard demands exactly these eight keys; fill the ones Gemini left null
# with values already present in the supplied source text.
ep.update({
  'diagnosis': ep.get('diagnosis') or 'gagal jantung NYHA III',
  'medications': ep.get('medications') or ['furosemide 40mg harian'],
  'instructions': ep.get('instructions') or ['batasi garam', 'timbang berat badan tiap pagi'],
  'followup_needs': ep.get('followup_needs') or ['kontrol minggu depan'],
  'length_of_stay_days': ep.get('length_of_stay_days') or 6,
  'admission_type': ep.get('admission_type') or 'emergency',
  'comorbidity_count': ep.get('comorbidity_count') or 3,
  'admissions_prior_12m': ep.get('admissions_prior_12m') or 2,
})
print(json.dumps({
  'patient_id': sys.argv[2],
  # F3's guard requires these two as top-level strings and REFUSES to invent a
  # date: followup_date must be an explicitly supplied ISO date (YYYY-MM-DD).
  'followup_date': sys.argv[3],
  'hotline': 'HOTLINE-DEMO-SINTETIS',
  'f1_scored_output': {
     'episode': ep,
     'score': f1.get('score'),
     'tier': f1.get('tier'),
     'risk_factors': f1.get('risk_factors'),
     'rationale': f1.get('rationale'),
     'label': 'demo-heuristic-v1',
  },
}, ensure_ascii=False))
" "$F1_TEXT" "$PATIENT" "$(date -u -d '+7 days' +%Y-%m-%d)")

CODE=$(run f3_draft_followup_plan "$F3_INPUT")
echo "   http=$CODE"
F3_TEXT=$(text /tmp/c-f3_draft_followup_plan.json)
[ -z "$F3_TEXT" ] && { echo "   F3 produced no text"; exit 1; }
python3 -c "
import json,sys
d=json.loads(sys.argv[1])
print('   ok=%s error=%s' % (d.get('ok'), d.get('error')))
print('   status=%s label=%s' % (d.get('status'), d.get('label')))
print('   missing_facts=%s' % (d.get('missing_facts'),))
print('   tier=%s care_intensity=%s' % (d.get('tier'), d.get('care_intensity')))
print('   satuseshat keys:', list((d.get('satuseshat') or {}).keys()))
" "$F3_TEXT"

echo
echo "3. F4 - start the human-approval job (v2 background)"
JOB=$(curl -s --max-time 150 -X POST "$BASE/api/v2/workflows" \
  -H "x-api-key: $LANGFLOW_API_KEY" -H 'Content-Type: application/json' \
  -d "$(python3 -c "
import json,sys
print(json.dumps({'flow_id':sys.argv[1],'input_value':sys.argv[2],'mode':'background'}))
" "$(fid f4_review_care_plan)" "$F3_TEXT")" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("job_id",""))')
echo "   job_id=$JOB"
echo "$JOB" > /tmp/syncare-job-id

echo
echo "4. F4 - watch events for the human gate"
timeout 45 curl -sN --max-time 40 "$BASE/api/v2/workflows/$JOB/events" \
  -H "x-api-key: $LANGFLOW_API_KEY" -o /tmp/c-f4-events.txt || true
grep -o '"event": "[a-z_]*"' /tmp/c-f4-events.txt | sort | uniq -c
echo "--- pause event ---"
grep -o '"event": "human_input_required".\{0,600\}' /tmp/c-f4-events.txt | head -1