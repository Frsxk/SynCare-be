#!/usr/bin/env bash
# Measure Langflow's real memory footprint during a live flow run, then record
# whether a memory cap is warranted.
#
# Usage: bash scripts/smoke-memory.sh [flow_key]
#
# Writes docs/memory-baseline.md. Does NOT modify the compose file: the cap
# decision belongs to a human, informed by measured numbers.
set -uo pipefail

cd "$(dirname "$0")/.."
CONTAINER=syncare-langflow
OUT=docs/memory-baseline.md

[ -f .env ] || { echo "No .env — run from the repo root after setup."; exit 2; }
set -a; . ./.env; set +a

host_free() { free -m | awk '/^Mem:/{print $7}'; }
swap_used() { free -m | awk '/^Swap:/{print $3}'; }
ctr_mem()   { docker stats --no-stream --format '{{.MemUsage}}' "$CONTAINER" 2>/dev/null | cut -d/ -f1 | tr -d ' '; }
ctr_cpu()   { docker stats --no-stream --format '{{.CPUPerc}}' "$CONTAINER" 2>/dev/null | cut -d' ' -f1; }

FLOW_KEY="${1:-f1_register_discharge_summary}"
FLOW_ID=$(python3 -c "import json;print(json.load(open('flows.json')).get('$FLOW_KEY',''))" 2>/dev/null)

echo "Baseline before run:"
echo "  host free : $(host_free) MB"
echo "  swap used : $(swap_used) MB"
echo "  container : $(ctr_mem) / $(ctr_cpu)"

# Sample while the flow runs so the figure reflects real load, not idle.
( for i in $(seq 1 24); do
    printf '%s|%s|%s|%s\n' "$(date -u +%H:%M:%S)" "$(ctr_mem)" "$(host_free)" "$(swap_used)"
    sleep 5
  done ) > /tmp/syncare-mem-samples.txt &
SAMPLER=$!

PAYLOAD='{"input_value":"Pasien dengan CHF NYHA III, pulang 2026-10-01, minum furosemide 40mg harian, berat 82kg, eGFR 52, ada edema perifer ringan."}'
if [ -n "$FLOW_ID" ]; then
  echo "Running $FLOW_KEY ($FLOW_ID)..."
  curl -s --max-time 120 -X POST \
    "http://127.0.0.1:7860/api/v1/run/$FLOW_ID" \
    -H "x-api-key: $LANGFLOW_API_KEY" -H 'Content-Type: application/json' \
    -d "$PAYLOAD" -o /tmp/syncare-run.json -w '  http=%{http_code} time=%{time_total}s\n' || true
else
  echo "No flow id for '$FLOW_KEY' — sampling idle footprint only."
fi

kill $SAMPLER 2>/dev/null || true

PEAK=$(cut -d'|' -f2 /tmp/syncare-mem-samples.txt | grep -E 'GiB|MiB' | sed 's/GiB//;s/MiB//' | awk '{if($1 ~ /GiB$/){} ; v=$1; u=$2; if(u=="GiB") v*=1024; if(v+0>m) m=v+0} END{printf "%.0f", m+0}')
[ -z "$PEAK" ] && PEAK=$(ctr_mem)
MINFREE=$(cut -d'|' -f3 /tmp/syncare-mem-samples.txt | sort -n | head -1)

{
  echo "# Langflow memory baseline"
  echo
  echo "Measured $(date -u +%Y-%m-%dT%H:%M:%SZ) on the SynCare backend host."
  echo "Container \`$CONTAINER\`, flow exercised: \`$FLOW_KEY\`."
  echo
  echo "| Metric | Value |"
  echo "|---|---|"
  echo "| Peak container memory during run | ${PEAK} MB |"
  echo "| Minimum host free memory during run | ${MINFREE} MB |"
  echo "| Host RAM total | $(free -m | awk '/^Mem:/{print $2}') MB |"
  echo "| Swap used at peak | $(swap_used) MB |"
  echo "| CPU cores | $(nproc) |"
  echo
  echo "## Raw samples (time | container mem | host free MB | swap used MB)"
  echo '```'
  cat /tmp/syncare-mem-samples.txt
  echo '```'
  echo
  echo "## Interpretation"
  echo
  if [ "${MINFREE:-0}" -gt 400 ]; then
    echo "Host free memory stayed above 400 MB. **No memory cap applied** — capping would add risk without evidence of a problem."
  else
    echo "Host free memory dropped to ${MINFREE} MB. A memory cap is worth evaluating; re-measure with \`mem_limit\` set before trusting any figure."
  fi
} > "$OUT"

echo
echo "Wrote $OUT"
grep -E '^\| (Peak|Minimum)' "$OUT"