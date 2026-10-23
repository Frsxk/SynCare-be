# Real flow output shapes (from the verified SynCare repo)

Source of truth: `/home/ubuntu/kittys-workspace/syncare-review/reports/integrated-e2e-test.txt`
plus the five verified exports in `flows/`. These are **observed** shapes from a real
end-to-end run; prefer them over invented fixtures.

## F1: register_discharge_summary

Returns a deterministic score plus Gemini-extracted facts. Observed keys include:

```json
{
  "patient_id": "chf-high-e2e",
  "tier": "HIGH",
  "status": "...",
  "satuseshat": { "careplan": {}, "servicerequest": {}, "task": {} },
  "source_input": "..."
}
```

Risk factors and the numeric score are emitted by the deterministic scorer component
(`SynCareRiskScorer`), not by Gemini.

## F2: record_patient_checkin

Re-stratifies risk at every check-in. Two branches, both observed:

```json
{ "patient_id": "chf-high-e2e", "tier": "HIGH", "action": "continue_monitoring" }
{ "patient_id": "chf-high-e2e", "action": "escalate_immediately" }
```

`escalate_immediately` is the red-flag path. It **structurally excludes the scorer**;
no scoring span appears in the trace at all. A console rendering a red-flag result
must present it as an escalation, never as a tier change.

## F3: draft_followup_plan

Draft plan with SATUSEHAT-shaped artifacts:

```json
{
  "patient_id": "...",
  "status": "DRAFT pending human approval",
  "plan_text": "...",
  "satuseshat": { "careplan": {}, "servicerequest": {}, "task": {} }
}
```

**Quirk worth knowing:** the `satuseshat` key appears in the report spelled exactly
that way; do not "fix" it to camelCase when reading.

## F4: review_care_plan (human gate)

Pause event (observed verbatim):

```json
{
  "request_id": "HumanInput-<node>:<run_id>",
  "kind": "node_input",
  "options": [
    { "action_id": "approve", "label": "Approve" },
    { "action_id": "request_changes", "label": "Request Changes" },
    { "action_id": "escalate", "label": "Escalate" }
  ],
  "allowed_decisions": ["approve", "request_changes", "escalate", "fallback"],
  "timeout_seconds": 300,
  "fallback_action": "fallback",
  "paused_at": "2026-10-06T09:48:16.727071+00:00"
}
```

Terminal outputs observed:

| Decision | Terminal output |
|---|---|
| Approve | `{ "action": "approved", "confirmation": "...", "approved_at": "..." }` |
| Escalate | `{ "action": "escalate_to_clinician", "plan_json": {...} }` |
| Late approve (>300 s) | rerouted to fallback, then `escalate_to_clinician`; audit row records `action_id: "fallback"` |

Audit rows land in `audit_log(action, actor, timestamp, payload)`; approved plans in
`approved_plans(plan_json, approved_at, reviewer_note)`. **Neither table has a
`patient_id` column**; identity is inside the JSON payload.

## F5: answer_care_questions

Grounded answer with provenance anchors plus backend telemetry:

```json
{
  "patient_id": "chf-high-e2e",
  "query": "...",
  "answer": "... [hf-aftercare:section:4#2 | draf_edukasi_tidak_disetujui] ...",
  "backend_used": "astra",
  "backend_requested": "...",
  "astra_collection": "syncare_f5_kb_...",
  "astra_keyspace": "default_keyspace",
  "dimension_choice": "dimension 3072 (cosine) confirmed on 'syncare_f5_kb_...'"
}
```

Out-of-scope refusal is byte-exact and must be shown verbatim, not paraphrased:

```
Maaf, pertanyaan itu di luar cakupan rencana Anda. Silakan tanyakan
ke perawat Anda atau hubungi hotline.
```

## Operational facts

- Bob's MCP client aborts at **~60 s**. Console client default: **55 s**.
- F5 retriever observed at ~26 s; keep demo queries short.
- The F4 reroute is **lazy**: nothing fires at exactly 300 s. A late decision is
  rerouted at resume time. Never promise automatic escalation "at 5 minutes".
- `human_input_expired` telemetry is emitted only on the durable-serve path, not on
  `langflow run`. Documented low-severity gap; no functional impact.