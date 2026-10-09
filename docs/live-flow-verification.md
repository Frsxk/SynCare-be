# Live Flow Verification — SynCare-be (cat tree)

**Date:** 2026-10-09 · **Langflow:** 1.12.3 (Docker) · **All runs: synthetic data only**

Every flow below was executed against the live Langflow instance on this host and
the terminal output is quoted verbatim from the run.

---

## F1 — register_discharge_summary

```
http=200  elapsed=1s
tier=HIGH score=4
episode keys: admission_type, admissions_prior_12m, comorbidity_count, diagnosis,
              followup_needs, instructions, length_of_stay_days, medications
```

Gemini extracted the episode; the deterministic scorer assigned the tier. Score
changed from 0 → 4 once hospitalisation/comorbidity facts were supplied, which
confirms scoring is deterministic and not model-generated.

## F2 — record_patient_checkin

Routine:
```
http=200  elapsed=1s
{"patient_id": "chf-high", "baseline_score": 7, "baseline_tier": "HIGH",
 "adjustments": [{"condition": "symptom_count >= 2", "applied": false, "points": 0},
                 {"condition": "medication_adherence == irregular", ...},
                 {"condition": "symptoms empty", "applied": true, "points": -...}]}
```

Red flag (bypasses scoring entirely):
```
http=200  elapsed=2s
{"action": "escalate_immediately", "reason": "Nyeri dada berat"}
```

## F3 — draft_followup_plan

Consumes F1's scored output wrapped in the guard's required envelope:
```
http=200
status=DRAFT pending human approval   label=demo-heuristic-v1
missing_facts=[]                      tier=HIGH
care_intensity=['Telepon perawat dalam 24 jam.', 'Check-in setiap hari.']
satuseshat keys: careplan, servicerequest, task
```

**Fail-closed behaviour verified.** With `followup_date` / `hotline` withheld it
returned `missing_facts: ['followup_date', 'hotline']` and refused to generate —
it will not invent a follow-up date.

## F4 — review_care_plan (human gate)

```
1. POST /api/v2/workflows (mode=background)
   job_id = 4ec8be81-7b60-4546-8184-92559fbffa5d
2. events → human_input_required
   request_id   = HumanInput-IvOz5:4ec8be81-...
   allowed      = ["approve","request_changes","escalate","fallback"]
   timeout_seconds = 300
3. POST /api/v2/workflows/{job}/resume  {"decision":{"action_id":"approve",...}}
   → 200 {"status":"resuming","message":"Resume accepted"}
4. events → output → end
   {"action":"approved",
    "confirmation":"Draf rencana tindak lanjut disetujui oleh peninjau manusia
                    dan disimpan dalam SQLite.",
    "approved_at":"2026-10-09T16:49:13.798724+00:00"}
```

**Review DB after the run** (host: `data/langflow/langflow/syncare-review.sqlite3`):
```
approved_plans: 1   audit_log: 1
approved_at : 2026-10-09T16:49:13.798724+00:00
reviewer_note: Disetujui pada demo backend SynCare-be
audit action : Approve | actor frisky | 2026-10-09T16:49:13.798724+00:00
plan_json.status: DRAFT pending human approval   <-- deliberately unchanged
patient_id       : chf-chain-164858
```

The identical timestamps prove plan + audit were written in the same transaction.
`plan_json.status` staying `DRAFT` after approval is why the console must derive
approval from **table membership**, never from the status string.

## F5 — answer_care_questions (Astra RAG)

Approved patient:
```
http=200
Jawaban demo sintetis berdasarkan rencana tindak lanjut yang telah disetujui
melalui alur kerja sintetis (bukan persetujuan klinis) dan draf edukasi yang
belum disetujui; bukan nasihat medis. Check-in setiap hari.
[chf-chain-164858:care_intensity:1#1 | rencana_disetujui_workflow_sintetis]
```

Unapproved patient:
```
http=200
Maaf, pertanyaan itu di luar cakupan rencana Anda. Silakan tanyakan ke perawat
Anda atau hubungi hotline.
```

**Both fail-closed branches verified.** The answer carries patient-scoped
provenance anchors (`patient_id:care_intensity:1#1`) and a synthetic-demo
disclaimer, and Chroma persisted a real per-patient collection
(`syncare_f5_<sha256(patient_id)[:16]>/`).

---

## Bugs found by running (not by reading)

1. **Gemini key redaction.** Exports store `***REDACTED***` in `api_key`. A global
   Variable alone, a `load_from` variable binding, and clearing the field to fall
   back to the environment **all three failed**. Only writing the key into the node
   field worked.
2. **F4 DB path baked to another machine.** `db_path` was
   `/home/frxskie/langflow/syncare-review.sqlite3`; that path does not exist here,
   so F4 died with `Permission denied` *before reaching the human gate*.
3. **F5 had the same bug twice over.** `db_path` plus `protocol_directory` and
   `persist_directory`. Patching the module-level `DEFAULT_*` constants was not
   enough — the node template fields override them, and the real field names are
   `protocol_directory` / `persist_directory` (not `protocol_dir` / `persist_dir`).
4. **Component code is cached.** PATCHing a flow's Python code has no effect until
   Langflow restarts (`--force-recreate`, since `restart` does not re-read env).
5. **F3's guard is strict on purpose.** It requires all 8 episode fields, an
   explicit ISO `followup_date`, a `hotline`, and `label: demo-heuristic-v1`.

## Reproducing

```bash
bash scripts/smoke-all-flows.sh   # F1, F2 routine, F2 red-flag, F3
bash scripts/chain-full.sh        # F1 -> F3 -> F4 + human gate (resumes approved)
bash scripts/smoke-f5.sh          # F5 approved + fail-closed refusal
```