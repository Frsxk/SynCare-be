# SynCare-be

Current M11 closed locally2026-10-27: [report](../docs/planning/mvp-verification-report.md), [operator/recovery runbook](../docs/planning/demo-runbook.md).205 tests/1452 assertions/56 files and TypeScript PASS. Configured secrets/private account files DPAPI-protected on this Windows account; values unchanged, runtime/host readers compatible, malformed/unsupported envelopes fail closed. Correlated known engine timeout failures map to existing EXPIRED; generic/missing/foreign errors remain honest. Real separate-engine restart/same gate/deadline/missing tests PASS; primary engine unchanged. Original auto expiry/indefinite retention/deployment not promised. Actual protected F1/F2 seed/reopen and F5 PASS. Native/deployed deferred, no clinical rule/schema/new API. Earlier entries historical.

M11 current2026-10-27: [verification](../docs/planning/mvp-verification-report.md), [guarded seed/runbook](../docs/planning/demo-runbook.md), [safe fixture manifest](../docs/planning/demo-fixture-manifest.md). Final200 tests/1435 assertions/54 files and TypeScript PASS; security matrix and safe isolated seed added. Actual F1/F2 cold/reopen/explicit owned reset/reseed PASS; active-data F5 answer4 citations/emergency PASS. Seed has no canonical binding and never resets active data. M11 IN_PROGRESS/NOT_READY for unconditional acceptance: private plaintext handoff/.env and Q10 engine restart/expiry/retention remain open; patient browser storage also remains a client boundary. No model/flow/schema/product endpoint change. Earlier entries historical.

## Current M10 integration evidence,2026-10-26

M01-M09 accepted; M10 local browser scope complete awaiting ACC, [report](../docs/planning/SYNCARE-M10-VERIFICATION.md). Final192 tests/1143 assertions/52 files and TypeScript PASS. Existing APIs/stores/clinical flows unchanged; new scripts prepare exactly two synthetic accounts and verify monitoring/canonical/normal-restart/isolated failure/owned terminal records. Never rerun initialization with replacement UUIDs or reset old data. Private outputs live in ignored data/m10-*.json; no tokens printed. User Langflow stays running; controlled failures use isolated operational clones and an unreachable own loopback target. No canonical writer change, migration, commit/push/deploy/deletion. Native/deployed/whole-MVP and M11 remain separate; M11 unauthorized before M10 ACC.

## Current local M09 behavior,2026-10-26

M01-M08 accepted; four M09 tasks/CP09 locally complete awaiting ACC. POST `/api/v1/patients/:id/questions` exact `{query}` uses current self/assigned identity, unique server session, verified real F5 binding and canonical latest registered approval/quote proof. Answer/refusal/emergency/error are typed, text/refusal unchanged, no raw diagnostics/new clinical rules. Legacy `/answers` retains request shape but now returns the same typed envelope. Same-patient retrieval serializes within this process; no durable chat/distributed lock. Existing F5/model/Astra selection and F4 writer unchanged.

[M09 exact contracts/evidence](../docs/planning/SYNCARE-M09-VERIFICATION.md):192 backend tests/typecheck, actual36 API checks/five cases, Flutter/Next integration/compiled/production evidence, preserved selected approval hash. [Recovery](../docs/planning/recovery-runbook.md) covers source drift, missing proof/uncertain inference. Start existing config with `bun run src/index.ts`; no new seed/migration. Native/deployed/whole-MVP open, M10-M11 unauthorized. Earlier current-status notes historical.

## Current local M08 behavior,2026-10-26

M01-M07 accepted; DL-016/Q08 authorize only fourteen M08 tasks/CP08, locally complete awaiting ACC. Applied0008 persists source-bound guarded F3 drafts, actual F4 registry/events/single gate claims and canonical approval links. C1-C7 are mounted with account/current capability/assignment, strict input/version/UUID and private scoped reads. F4 alone writes canonical approved_plans/audit_log; Bun revalidates exact matching evidence/physical F4-F5 path before C7 or legacy publication. Independent collector/startup recovery never automatically resends unknown start/resume. Actual Request Changes produces revisedDRAFT/new explicit gate; escalate/fallback stay plan outcomes, not M07 alerts.

Explicit audited access setup `bun scripts/initialize-review-access.ts` uses private operator stdin and existing eligible assigned nurses; no startup reseed. [M08 exact contracts/evidence](../docs/planning/SYNCARE-M08-VERIFICATION.md) records183 backend tests, actual102 API checks/F5, actual backend restart and isolated canonical-boundary crash. [Recovery runbook](../docs/planning/recovery-runbook.md) covers missing/ambiguous proof, uncertain delivery and observed timeout/retention limits. Start existing backend with `bun run src/index.ts`. M09-M11/native/deployed/whole-MVP gates open. All earlier current-status paragraphs below are historical.

## Current local M07 behavior,2026-10-26

M01-M06 accepted, Q07 approved; M07 locally complete awaiting ACC. New0007 stores immutable exact successful F2 acute source and append-only operational actions. Separate local worker reconciles missing enqueue/expired or failed local materialization from persisted sources, without rerunning F2. Earlier migrations0001-0006, Langflow definitions/shared defaults, Astra and canonical F4 approval ownership unchanged. Known urgent outcome/guidance stays available even if alert persistence fails.

E1 GET `/api/v1/alerts` and `/api/v1/alerts/:id`, E3 GET `/api/v1/patients/:id/alerts`, E2 POST `/api/v1/alerts/:id/actions` are authenticated/private/no-store. Current alert.manage plus assignment, bounded scoped cursors/status filters, exact action/expectedVersion/original UUID and transactional receipts/history apply. Shared detail path redacts internal notes/actor/type/actual-action time for own patient. PENDING_REVIEW -> ACKNOWLEDGED -> IN_PROGRESS -> RESOLVED; follow-up category/actual time/internal note and prior-followup closure summary required. Optional patientSummary deliberately public; no read acknowledgment/direct resolve/reopen or real call/dispatch claim.

Run `bun run src/index.ts` with existing local configuration. Explicit operator setup: `bun scripts/initialize-alert-access.ts`, private stdin `{credentials:{identifier,password},nurseIdentifiers:[...]}`; existing active assigned nurses only, audited grants without assignment expansion. Do not repeat account initialization or reset data. [M07 exact contracts/verification](../docs/planning/SYNCARE-M07-VERIFICATION.md) records163 backend tests, actual94 API checks/three sources, exact restart and clients. Two closed synthetic examples and one pending demo retained. M08-M11 unauthorized; native/deployed gates open. All earlier milestone status paragraphs below are historical.

## Current local M06 behavior, 2026-10-26

M01-M05 accepted; M06 locally complete, awaiting ACC. H4 now supports manual scheduling, completion, cancellation and rejection with one transactional expectedVersion/idempotency/history writer. H5 GET `/api/v1/homecare/staff?patientId=...` returns bounded currently eligible registered staff already assigned to that scoped patient. Same-staff Scheduled overlap is rejected with booking_schedule_conflict409; half-open adjacent slots are allowed. New schedules require a future canonical UTC interval plus Asia/Jakarta. Completion requires an actual nonfuture time at/after confirmed start and a patient-visible note. Terminal bookings cannot reopen; rescheduling remains deferred.

Patient cancellation: own Requested/Under Review only. Assigned booking.manage nurses may cancel those states or Scheduled, and reject Under Review. Reasons are required and patient-visible. Stale versions409 precede state-specific denial; committed intents replay without a duplicate event, while current access is rechecked. H3 global queue optionally filters active/all/one exact status before pagination; omission retains all. Explicit staff registration: `bun scripts/initialize-homecare-staff.ts`, private stdin `{credentials:{identifier,password},staff:[{identifier,displayName}]}`. Existing active eligible nurses only; no grant/assignment expansion or startup reseed.

Applied SQL0001-0006 unchanged. Backend153 tests/879 assertions,61 actual lifecycle checks, six-booking/21-history/21-receipt exact restart and prior M05 snapshot PASS. [M06 verification](../docs/planning/SYNCARE-M06-VERIFICATION.md) contains client/build evidence and native/deployment limits. No real dispatch, Langflow/Astra write or clinical decision change. M07+ not authorized.

## Historical M05 behavior, 2026-10-26

Homecare API-H1-H4 is implemented: active services, own patient booking request, scoped patient/nurse list/detail, and booking.manage Requested -> Under Review with expectedVersion and idempotent mutation receipts. Preferred UTC interval with Asia/Jakarta is separate from nullable confirmed staff/slot. Immutable snapshot/history lives in new migration0006;0001-0005 unchanged. The approved service is synthetic DKI Jakarta care, not availability/dispatch/payment. Scheduling and terminal action endpoints remain M06.

Explicit operator setup: `bun scripts/initialize-homecare.ts`, private stdin `{credentials:{identifier,password},nurseIdentifiers:[...]}`. It checks administrative authority, inserts only the missing approved catalog entry and grants existing active demo nurses booking.manage through audited current-version provisioning. It never reactivates an inactive service or runs as startup seed. Verify with `bun scripts/verify-local-homecare.ts` and `bun scripts/verify-homecare-restart.ts prepare|verify`; credentials/evidence remain ignored under data/. M05 does not call or change Langflow/Astra/F4. [M05 verification](../docs/planning/SYNCARE-M05-VERIFICATION.md) records backend145/811 assertions and actual client/restart evidence. M05 awaits user ACC; M06+ not authorized.

## Current local M04 behavior, 2026-10-25

API-M1/M2/M3/E4 are implemented: self-only POST `/api/v1/patients/:id/checkins`, scoped GET list at the same path, GET `/api/v1/checkins/:id`, assigned-nurse GET `/api/v1/monitoring`, and authenticated GET `/api/v1/emergency-guidance`. The common envelope carries persisted records; report commit precedes asynchronous F2 processing. Repeated intent keys reconcile one report. A new key explicitly creates a new report, including on the same day.

Migration 0005 preserves immutable report/baseline and processing evidence. F2 uses numeric original F1 of the current confirmed source, with server-owned patient/session and verified per-run tweaks; absent baseline saves BLOCKED_BASELINE without a default score. Live scorer/node/code binding is rechecked before invocation. Timeout/expired delivery stays UNKNOWN without blind replay. Acute F2 creates durable ALERT_F2 work only; M07 received/action lifecycle is not implemented. trigger_plan_review remains separate and cannot overwrite F1 confirmation.

Set explicit `SYNCARE_GUIDANCE_CONFIG` and `SYNCARE_F2_CONTEXT_CONFIG` paths to the reviewed demo JSON files in `config/`. Missing/unverified guidance is unavailable, with no number fallback. Approved 119 contact is information-only: no telephone call or active tel action. API-P5 now connects actual latestReport and separate latestAnalysis; plan/booking/alert-count ports remain unavailable. Raw legacy F2 stays denied; the owned report API is its M04 path. See [M04 verification](../docs/planning/SYNCARE-M04-VERIFICATION.md) for evidence and platform limits.

## M03 source and confirmation baseline

Persisted discharge/assessment/confirmation producers are now mounted behind account/capability/assignment checks: POST `/api/v1/patients/:patientId/discharges`, POST `/api/v1/discharges/:dischargeId/assessments`, GET `/api/v1/patients/:patientId/assessments`, POST `/api/v1/assessments/:assessmentId/confirmations`. Raw legacy F1 remains denied. Migration 0004 preserves exact source, upstream response and confirmation history. Q03 requires a new assessment and explicit confirmation after each source change.

Approved R02 adds GET `/api/v1/patients/:patientId/overview`: scoped profile, current source, confirmed risk and staff-only latest assessment. Patient source text is redacted. Future plan/report/analysis/booking/alert ports are explicitly unavailable, not zero. Actual dashboard and Flutter CP03 consumers are connected. [M03 verification](../docs/planning/SYNCARE-M03-VERIFICATION.md) records 123 backend tests/639 assertions, 28 actual F1 checks, restart evidence and client verification. M03 is completed locally and awaiting user ACC; no full clinical parity or deployment acceptance is claimed. The earlier [backend checkpoint](../docs/planning/SYNCARE-M03-BACKEND-CHECKPOINT.md) is historical.

## Current local M02 behavior, 2026-10-25

`src/index.ts` mounts account sessions and principal/resource authorization. Login is `POST /api/v1/auth/login`; restore/logout are `GET`/`DELETE /api/v1/auth/session`. Sessions last 24 hours without automatic extension. The infrastructure key authorizes operator health only, and cannot unlock patient/domain routes.

New implemented contracts: API-A1/A2/A3 and API-P1/P2/P3. Authorized nurses create patient profiles and linked accounts; the private operator provisions nurses, manages grants and assigns/revokes patient scope. Profiles, sessions and operational audits persist in the separate operational SQLite store. F4 remains the sole approval writer; Astra retrieval and clinical flow code are unchanged.

Raw discharge/check-in/draft/review/job-stream routes are denied publicly until their domain milestones establish stored ownership/provenance. Their original clinical adapter is preserved in `src/legacy-app.ts` for isolated contract regression; it is reached publicly only through the scoped gateway. Scoped plan reads and F5 remain available. Legacy response fields are preserved apart from patient-only reviewer-note redaction and filtering out foreign/unattributed rows.

The older API/flow guide below describes the legacy clinical adapter and deployment baseline, not a shared-key bypass of the M02 gateway. See [private account procedure](../docs/planning/demo-account-procedure.md) and [M02 verification](../docs/planning/SYNCARE-M02-VERIFICATION.md) for current configuration, exact domain envelopes and evidence. Startup requires an explicitly prepared operational store, origins and private cursor key; it never resets or silently seeds the DB.

Backend for **SynCare**: post-discharge care orchestration for CHF patients
in Indonesian hospitals. Built for the Hacktiv8 x IBM hackathon.

**Langflow owns every clinical decision.** This backend is a thin, bearer-token
protected proxy in front of it plus a read-only view of the state the flows
write. It contains no scoring, no tiering, no red-flag detection, no drafting,
and no approval logic.

> Synthetic engineering demo. Not clinically validated and not a calibrated
> risk prediction model. No diagnosis, no medication changes, no emergency
> advice. Human clinical oversight required. FHIR-shaped output is not a
> SATUSEHAT submission.

---

## Architecture

```
SynCare-fe (separate repo)
      │  Authorization: Bearer <token>
      ▼
  Elysia (this repo)  ──thin proxy──▶  Langflow 1.12.3 (5 flows)
      │                                    │
      │  read-only SQLite                  │ sole writer
      ▼                                    ▼
  approved_plans / audit_log  ◀──────  syncare-review.sqlite3
```

- **Langflow** (Docker, `langflowai/langflow:1.12.3`, one worker) runs the five
  flows and is the only component permitted to make a clinical decision.
- **This app** forwards requests verbatim and reads the review DB with
  `readonly: true`. It has no write path to clinical state at all.
- **F4 is the only writer** of `approved_plans` and `audit_log`.
- F5 fails closed: no approval means no answer.

### The five flows

| Key | Flow | Role |
|---|---|---|
| `f1_register_discharge_summary` | Register discharge summary | Gemini extracts the episode; deterministic components score and tier it |
| `f2_record_patient_checkin` | Record patient check-in | Routine adjustment, or immediate escalation on a red flag |
| `f3_draft_followup_plan` | Draft follow-up plan | Builds the plan + SATUSEHAT-shaped artifacts; **refuses to invent a follow-up date** |
| `f4_review_care_plan` | Review care plan | Human-in-the-loop gate; suspends the job until a person decides |
| `f5_answer_care_questions` | Answer care questions | Grounded RAG over Astra with a per-patient collection; refuses unapproved patients |

---

## API

> **Langflow must be running.** It is the clinical engine; this backend cannot
> serve F1-F5 without it. Only these routes work while it is down:
> `/api/health`, `/api/v1/flows`, `/api/v1/plans`, `/api/v1/plans/:patientId`.
> They read local SQLite and `flows.json` only.

Base URL in production: `https://syncare.trackover.web.id`

In the isolated legacy adapter, `/api/*` uses an internal bearer. In the current public application, use account sessions as described above; the infrastructure key is restricted to health.
`/` and all other paths return `404`; this service serves no HTML.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/health` | Liveness, Langflow reachability, flow-manifest completeness. Gated. |
| `GET` | `/api/v1/flows` | Canonical flow-key → UUID map |
| `GET` | `/api/v1/plans` | `{ plans, audit }` newest-first, read-only |
| `GET` | `/api/v1/plans/:patientId` | `404` when no approved plan exists |
| `POST` | `/api/v1/discharge` | F1. Body: `{ input_value }` |
| `POST` | `/api/v1/checkins` | F2. Body: `{ input_value }` |
| `POST` | `/api/v1/plans/draft` | F3. Body: `{ patient_id, followup_date, hotline, f1_scored_output }` |
| `POST` | `/api/v1/reviews` | F4. Body: `{ draft, session_id? }` → `{ jobId }` |
| `POST` | `/api/v1/reviews/:jobId/resume` | Body: `{ request_id, action_id, actor, reviewer_note? }` |
| `GET` | `/api/v1/reviews/:jobId/events` | SSE approval feed (see below) |
| `POST` | `/api/v1/answers` | F5. Body: `{ patient_id, query }` |

Flow output is returned **verbatim**. The backend never re-scores, re-tiers, or
softens what a flow emitted.

### Status codes

| Code | Meaning |
|---|---|
| `401` | Missing or wrong bearer token (`WWW-Authenticate: Bearer`) |
| `403` | Read-only mode blocked a mutating route |
| `404` | No such route; also returned for unknown `/api` paths **before** auth, so the surface cannot be mapped anonymously |
| `422` | Body failed schema validation |
| `502` | Could not open the F4 event stream (Langflow down, or stale job id) |
| `503` | `langflow_unreachable` / `langflow_timeout`: the clinical engine is down or slow; retry |
| `503` | `auth_not_configured`: the server has no `SYNCARE_API_KEY` |

---

## Notes for SynCare-fe

**1. Never call Langflow directly.** Its API key lives server-side here on
purpose. The frontend talks only to this backend.

**2. `EventSource` cannot send an `Authorization` header.** For the F4 approval
feed you must use `fetch()` + `ReadableStream`:

```js
const res = await fetch(`/api/v1/reviews/${jobId}/events`, {
  headers: { Authorization: `Bearer ${token}` },
})
const reader = res.body.getReader()
const decoder = new TextDecoder()
// Reassemble SSE frames from the decoded chunks.
```

A `?token=` query parameter would make `EventSource` work, but it leaks the
token into access logs, proxy logs, and browser history. Do not do it.

**3. CORS is not configured yet.** Same-origin works today; a cross-origin
frontend needs an explicit allowlist. Do not "fix" this with `Access-Control-Allow-Origin: *`.

**4. F3 will not guess.** Supply an explicit `followup_date` (`YYYY-MM-DD`) and
`hotline`, or it returns `missing_facts`.

**5. F4 resume needs `request_id` at the top level.** Langflow 1.12.3 can return
`200` while leaving the job silently suspended if it is omitted.

---

## Local development

```bash
cp .env.example .env      # then fill it in
docker compose up -d      # Langflow on :7860
bun install
bun src/index.ts          # console on :8080
```

Bring up Langflow from a genuinely clean state:

```bash
bash scripts/bring-up-langflow.sh
```

### Checks

```bash
bun test                  # 66 tests
bunx tsc --noEmit         # typecheck
bash scripts/verify-secrets.sh
```

### Scripts

| Script | Purpose |
|---|---|
| `scripts/verify-secrets.sh` | Fails if a real key pattern is committed |
| `scripts/bring-up-langflow.sh` | Clean Langflow rebuild + health check |
| `scripts/import-flows.ts` | Import `flows/*.json`, validating each |
| `scripts/discover-flows.ts` | Resolve flow UUIDs by exact name into `flows.json` |
| `scripts/set-langflow-variables.sh` | Upsert Langflow global Variables without printing them |
| `scripts/inject-gemini-key.ts` | Populate the Gemini credential into imported node fields |
| `scripts/fix-review-db-path.ts` | Repoint F4 at the container bind mount |
| `scripts/fix-f5-paths.ts` | Repoint F5 node fields |
| `scripts/patch-f5-constants.ts` | Repoint F5 Python module constants |
| `scripts/smoke-all-flows.sh` | Independent F1/F2 smoke, incl. the red-flag branch |
| `scripts/chain-full.sh` | F1 → F3 → F4 acceptance chain |
| `scripts/smoke-f5.sh` | F5 approved vs. unapproved (fail-closed) |

---

## Credentials

Every secret lives in `.env` (gitignored, `chmod 600`) and is read at startup.
`.env.example` documents the variables with empty values.

Two Langflow-specific notes, learned the hard way:

- `LANGFLOW_SECRET_KEY` must be a **Fernet** key (`Fernet.generate_key()`), not
  `openssl rand -hex 32`, or Variables cannot be decrypted.
- The Gemini credential authenticates with the **`x-goog-api-key`** header.
  Query-parameter and `Authorization: Bearer` do not work for a Gemini API key.

Imported flow exports carry `***REDACTED***` credential fields. A global
Variable alone does not satisfy them; `scripts/inject-gemini-key.ts` populates
the live flow definitions instead.

---

## Operations

See **[docs/OPERATIONS.md](docs/OPERATIONS.md)** for the systemd unit
(`syncare-console.service`), token rotation, read-only demo mode, health
checks, and troubleshooting.

Other documents:

- [docs/flow-shapes.md](docs/flow-shapes.md): observed request/response shapes
- [docs/runtime-bindings.md](docs/runtime-bindings.md): flow-binding verification
- [docs/cross-platform-secrets.md](docs/cross-platform-secrets.md): local secret provisioning
- [docs/storage-foundation.md](docs/storage-foundation.md): storage model
