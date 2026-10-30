# SynCare backend

SynCare is a post-discharge care orchestration demo for CHF patients in
Indonesian hospitals, built for the Hacktiv8 x IBM hackathon. This repository is
the backend: a Bun/Elysia HTTP service that owns accounts, sessions, patient
state and the care workflow, and delegates every clinical decision to five
Langflow flows.

> **Synthetic engineering demo.** Not clinically validated and not a calibrated
> risk prediction model. No diagnosis, no medication changes, no emergency
> advice. Human clinical oversight required. FHIR-shaped output is not a
> SATUSEHAT submission.

## What this service owns

- Account login, 24-hour sessions, nurse capabilities and patient assignments.
- Operational records: patient profiles, discharge source versions, F1
  assessments and risk confirmations, check-ins, alerts, homecare bookings,
  care-plan drafts and review state.
- Optimistic version checks, idempotency receipts, append-only history and
  operational audit entries.
- Request-origin enforcement, authentication, authorization and consistent
  no-store responses.
- A read-only demo mode.

It contains **no clinical scoring, tiering, red-flag detection, plan drafting or
approval logic**. Those live inside Langflow. It also never writes the canonical
approval tables: **F4 is the only writer** of `approved_plans` and `audit_log`.
The backend opens that database read-only and revalidates the stored approval
evidence before it returns a plan.

## Architecture

```
SynCare-fe (separate repository)
        │  Authorization: Bearer sc_…   session token from /api/v1/auth/login
        ▼
  Elysia on Bun ────────── x-api-key ─────────▶  Langflow 1.12.3
        │                                          │  F1–F5 clinical flows
        │  operational SQLite                      │  F4 is the sole writer
        │  accounts · patients · check-ins ·       ▼
        │  alerts · bookings · review state   syncare-review.sqlite3
        │                                     approved_plans · audit_log
        └──────── read-only, evidence-checked ─────▶
```

- **Langflow** runs as one Docker worker
  (`langflowai/langflow:1.12.3`). It is the only component allowed to make a
  clinical decision.
- **This service** owns application state and authorization. It calls Langflow
  server-side with `x-api-key`; the browser never receives that key and never
  calls Langflow directly.
- **F4** writes canonical approvals. The backend reads `approved_plans` and
  `audit_log` with a read-only SQLite connection and verifies the review,
  decision and artifact fingerprint before serving an approval.
- **F5 fails closed**: no registered approval means no grounded answer.

### The five flows

| Key | Flow | Role | Backend entry point |
|---|---|---|---|
| `f1_register_discharge_summary` | Register discharge summary | Gemini extracts the episode; a deterministic component scores and tiers it | `POST /api/v1/discharges/:dischargeId/assessments` |
| `f2_record_patient_checkin` | Record patient check-in | Re-stratifies against the confirmed baseline; routine outcome or immediate escalation | `POST /api/v1/patients/:patientId/checkins` (asynchronous) |
| `f3_draft_followup_plan` | Draft follow-up plan | Builds the plan and SATUSEHAT-shaped artifacts; refuses to invent a follow-up date | `POST /api/v1/patients/:patientId/care-plan-drafts` |
| `f4_review_care_plan` | Review care plan | Human-in-the-loop gate; suspends the job until a reviewer decides | `POST /api/v1/care-plan-drafts/:draftId/reviews` |
| `f5_answer_care_questions` | Answer care questions | Per-patient grounded retrieval with Astra DB and a Chroma fallback; refuses unapproved patients | `POST /api/v1/patients/:patientId/questions` |

## Authentication and authorization

### Sessions

`POST /api/v1/auth/login` exchanges an identifier and password for a session:

```json
{ "identifier": "nurse@example.invalid", "password": "…" }
```

```json
{
  "data": {
    "sessionToken": "sc_<43-character-token>",
    "expiresAt": "2026-10-29T09:00:00.000Z",
    "principal": { "id": "…", "role": "nurse", "capabilities": ["review.decide"] }
  },
  "requestId": "…"
}
```

- Send the token as `Authorization: Bearer <sessionToken>`.
- Tokens are stored as SHA-256 hashes. Sessions last **24 hours**, with no
  sliding renewal.
- `GET /api/v1/auth/session` returns the current principal and expiry.
- `DELETE /api/v1/auth/session` revokes the current session and returns `204`.
- Passwords are hashed with Argon2id and must be 12–128 characters.
- Login is throttled per identifier and globally; repeated failures return
  `429 rate_limited`.

### Roles and capabilities

A **patient** account is linked to one patient record and can only act on
itself. A **nurse** account sees only patients assigned to it, plus the
capabilities explicitly granted to the account.

| Capability | Allows |
|---|---|
| `patient.manage` | Create/update patient profiles and append discharge source versions |
| `patient.provision` | Create a login for an existing patient |
| `risk.confirm` | Run F1 assessments and confirm the resulting risk tier |
| `review.decide` | Draft, read and review care plans, and record the F4 decision |
| `booking.manage` | View the homecare queue and perform booking transitions |
| `alert.manage` | View the alert queue and record alert actions |
| `assignment.manage` | Grant or revoke a nurse's patient assignment |
| `account.provision`, `capability.manage` | Operator account/capability administration |

Basic profile reads follow this scope; clinical views that need a capability
require the capability shown in the endpoint tables. Capabilities gate the
actions that change clinical or operational state.

### Operator credential

`SYNCARE_API_KEY` is a server-side operator credential accepted on
**`GET /api/health` only**. It is not a user session, cannot call patient or
domain routes, and is never a shared-token bypass. Client applications must log
in and use the issued `sc_…` session token.

### Origins

The service is same-origin by design:

- The request URL origin must match `SYNCARE_BACKEND_ORIGIN`.
- If a browser sends an `Origin` header, it must match `SYNCARE_WEB_ORIGIN`.
- A loopback HTTP exception is available only when
  `SYNCARE_ALLOW_LOCAL_HTTP=true` and both origins are loopback.
- There is no CORS wildcard. Put the API and web app behind one origin rather
  than relaxing these checks.

## API conventions

All paths below are relative to the service origin.

- JSON only. Request bodies must send `Content-Type: application/json` and are
  validated against an exact field set. Paginated endpoints also reject unknown
  query parameters.
- Successful single-resource responses use
  `{ "data": …, "requestId": "…" }`. Lists use
  `{ "data": [...], "nextCursor": "…", "requestId": "…" }`.
- Errors use
  `{ "error": { "code", "message", "requestId", "retryable", … } }`.
  `message` is user-facing Indonesian.
- `requestId` is generated per request and is safe to quote in support reports.
- Every response is `Cache-Control: private, no-store` and
  `X-Content-Type-Options: nosniff`.
- Timestamps are ISO-8601 UTC. Homecare windows also carry the explicit
  `Asia/Jakarta` timezone.

### Idempotency

Record-creating and record-transitioning endpoints (patients, discharges,
assessments, confirmations, check-ins, bookings, alerts, care-plan drafts,
reviews and assignments) require:

```
Idempotency-Key: <UUID>
```

Repeating the same key with the same payload returns the stored result. Reusing
the key with a different payload returns `409 idempotency_conflict`.

### Concurrency

Mutable resources use `expectedVersion`. A stale write returns
`409 version_conflict` with `currentVersion` where available. Review decisions
also require the `requestId` advertised by the current F4 gate; a stale gate or
unknown action returns `409 version_conflict`.

### Pagination

List endpoints accept `limit` (1–100, default 20) and `cursor`. Cursors are
HMAC-signed and bound to the caller and collection; do not construct or edit
them. An opaque `nextCursor` is `null` on the last page.

### Status codes

| Code | Meaning |
|---|---|
| `401` | Missing, invalid, expired or revoked session; failed login |
| `403` | Missing capability or scope, cross-origin request, or read-only mode blocking a write |
| `404` | No such route, or a resource outside the caller's scope |
| `409` | `version_conflict`, `booking_schedule_conflict` or `idempotency_conflict` |
| `422` | Validation failure |
| `429` | Login rate limit |
| `500` | Unexpected processing failure |
| `502` | `outcome_unknown` or `invalid_flow_output` from an upstream result |
| `503` | `dependency_unavailable` (typically Langflow down) or `emergency_guidance_unavailable` |

Unknown `/api/*` paths return `404` only after authentication, so the route
surface cannot be mapped anonymously. `/` and all non-API paths return `404`;
this service serves no HTML.

## Endpoints

### Authentication and accounts

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/auth/login` | public | Exchange identifier/password for a session |
| `GET` | `/api/v1/auth/session` | session | Current principal and expiry |
| `DELETE` | `/api/v1/auth/session` | session | Revoke the current session |
| `POST` | `/api/v1/accounts/patient-links` | `patient.provision` + assignment | Create a patient login |

### Patients, discharges and risk

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/patients` | session | List patients in scope |
| `POST` | `/api/v1/patients` | `patient.manage` | Create a patient profile |
| `GET` | `/api/v1/patients/:patientId` | session | Read a patient profile |
| `PATCH` | `/api/v1/patients/:patientId` | `patient.manage` | Update profile/condition |
| `GET` | `/api/v1/patients/:patientId/overview` | session | Role-aware dashboard aggregate |
| `POST` | `/api/v1/patients/:patientId/assignments` | `assignment.manage` | Grant or revoke a nurse assignment |
| `POST` | `/api/v1/patients/:patientId/discharges` | `patient.manage` | Append a discharge source version |
| `POST` | `/api/v1/discharges/:dischargeId/assessments` | `risk.confirm` | Run F1; `202` while running, `200` when settled |
| `GET` | `/api/v1/patients/:patientId/assessments` | `risk.confirm` | Assessment history plus confirmation history |
| `POST` | `/api/v1/assessments/:assessmentId/confirmations` | `risk.confirm` | Confirm the F1 risk tier |

The patient profile body is exact:
`{ "profile": { "displayName": "…" }, "initialCondition": null }`.
`initialCondition` may be a string instead of `null`. A new discharge requires
`{ "sourceText": "…", "expectedPatientVersion": n }`.

### Check-ins and monitoring

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/patients/:patientId/checkins` | patient (self) | Submit a check-in; `202`, F2 runs asynchronously |
| `GET` | `/api/v1/patients/:patientId/checkins` | session | List check-ins and processing state |
| `GET` | `/api/v1/checkins/:checkinId` | session | Check-in detail and F2 outcome |
| `GET` | `/api/v1/monitoring` | nurse | Assigned patients with their latest check-in |
| `GET` | `/api/v1/emergency-guidance` | session | Configured demo emergency guidance |

A check-in body is `{ "message": "…" }`. F2 needs a confirmed baseline: without
one the processing attempt is stored as `BLOCKED_BASELINE` and no score is
invented. Processing states are `PENDING`, `BLOCKED_BASELINE`, `RUNNING`,
`SUCCEEDED`, `INVALID`, `FAILED` and `UNKNOWN`. A timeout or uncertain delivery
stays `UNKNOWN` rather than being replayed blindly.

Emergency guidance comes from `SYNCARE_GUIDANCE_CONFIG`. If it is missing or
unreadable, the route fails closed with `503 emergency_guidance_unavailable`.
The guidance is information only: this service never places a call.

### Care plans and human review

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/patients/:patientId/care-plan-drafts` | `review.decide` | Run F3 and return the resulting draft with `202` |
| `GET` | `/api/v1/care-plan-drafts/:draftId` | `review.decide` | Draft state and artifact |
| `POST` | `/api/v1/care-plan-drafts/:draftId/reviews` | `review.decide` | Start F4 with an empty `{}` body; `202` |
| `GET` | `/api/v1/reviews` | `review.decide` | List reviews; optional `patientId` |
| `GET` | `/api/v1/reviews/:reviewId` | `review.decide` | Review state and current human gate |
| `GET` | `/api/v1/reviews/:reviewId/stream` | `review.decide` | SSE feed for the gate and decision |
| `POST` | `/api/v1/reviews/:reviewId/decisions` | `review.decide` | Resume F4 with the gate decision; `202` |
| `GET` | `/api/v1/patients/:patientId/care-plans` | session (nurse: `review.decide`) | Approved plans, revalidated against evidence |
| `GET` | `/api/v1/plans` | session | Approved-plan view over backend-managed reviews; legacy `{ plans, audit }` shape |
| `GET` | `/api/v1/plans/:patientId` | session | Single-patient compatibility view; `404` if none |

A draft request is exactly:

```json
{ "assessmentId": "…", "followupDate": "YYYY-MM-DD", "hotline": "…" }
```

It requires a current confirmed F1 assessment for the same patient. F3 refuses
to invent a follow-up date; a missing or invalid date fails validation.

A review decision is:

```json
{ "expectedVersion": 3, "requestId": "…", "actionId": "approve", "reviewerNote": "…" }
```

`requestId` and `actionId` must match the gate returned by
`GET /api/v1/reviews/:reviewId`. Review states include `STARTING`, `RUNNING`,
`WAITING_FOR_HUMAN`, `DECISION_PENDING`, `APPROVED`, `REVISION_DRAFT`,
`ESCALATED`, `FAILED`, `EXPIRED` and `UNKNOWN`. A revised draft is stored as a
new draft and must go through a new explicit review; escalation and fallback
remain plan outcomes.

The SSE route requires the normal `Authorization` header. `EventSource` cannot
send that header, so use `fetch()` with a `ReadableStream` reader. Do not put a
session token in a query string: the route rejects query parameters, and tokens
in URLs leak through proxy logs and browser history.

### Alerts

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/patients/:patientId/emergencies` | patient (self) | Record a direct urgent request in the assigned nurse queue |
| `GET` | `/api/v1/alerts` | `alert.manage` | Global queue; `status=active`, `all`, or one exact status |
| `GET` | `/api/v1/patients/:patientId/alerts` | session (nurse: `alert.manage`) | Alerts for one patient |
| `GET` | `/api/v1/alerts/:alertId` | session (nurse: `alert.manage`) | Alert detail plus action timeline |
| `POST` | `/api/v1/alerts/:alertId/actions` | `alert.manage` | Acknowledge, record follow-up or resolve |

Alerts have two distinct sources: a trusted acute F2 escalation
(`source.type=F2`, `escalate_immediately`) or an authenticated direct patient
request (`source.type=PATIENT_REQUEST`, `request_immediate_help`). Direct
requests accept exactly `{ "reason": "…" }` (trimmed, nonempty, at most 8000
Unicode code points) with a UUID `Idempotency-Key`. They return HTTP 201 with
`{data:{resource,replayed}}`, create the durable queue entry immediately, and
require neither an F1 baseline nor an LLM call. Replaying the same key and
reason returns the same alert; changing the reason with that key conflicts.
Patient requests expose a `requestId` rather than fabricated F2 report/attempt
IDs. Migration 0009 preserves existing F2 alerts and timelines. Neither source
contacts a hospital, sends an ambulance, or guarantees an immediate response.
Patient alert-list clients opt into the new source with
`X-SynCare-Alert-Sources: all`. Without this header, patient list responses stay
F2-only so existing APKs retain a parseable history; the filter runs before
pagination. Nurse queues include both sources by default. The rebuilt patient
app sets this header; it is a representation capability, not an authorization
credential. Alert detail/ownership checks and nurse action permissions are
unchanged.
Statuses are `PENDING_REVIEW`, `ACKNOWLEDGED`, `IN_PROGRESS` and `RESOLVED`.
An action body is
`{ "action": "acknowledge" | "follow_up" | "resolve", "expectedVersion": n, "note": "…", … }`.
Acknowledge accepts an optional note. Follow-up additionally requires
`actionType`, `occurredAt` and a note; resolve requires a note and a prior
follow-up. In alert responses, patient-visible summaries and staff-only
internal notes are separate fields; patient responses never include internal
notes or actor identities.

### Homecare

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/homecare/services` | session | Active synthetic service catalog |
| `GET` | `/api/v1/homecare/staff?patientId=…` | `booking.manage` | Eligible staff already assigned to that patient |
| `POST` | `/api/v1/patients/:patientId/bookings` | patient (self) | Request a booking |
| `GET` | `/api/v1/patients/:patientId/bookings` | session (nurse: `booking.manage`) | Patient's bookings |
| `GET` | `/api/v1/bookings` | `booking.manage` | Nurse queue; `status=active` or one exact status |
| `GET` | `/api/v1/bookings/:bookingId` | session (nurse: `booking.manage`) | Booking detail and timeline |
| `POST` | `/api/v1/bookings/:bookingId/transitions` | patient cancel / `booking.manage` | Advance or close a booking |

A booking request is:

```json
{
  "serviceId": "…",
  "preferredWindow": {
    "startAt": "2026-11-01T02:00:00.000Z",
    "endAt": "2026-11-01T04:00:00.000Z",
    "timezone": "Asia/Jakarta"
  },
  "address": { "fullAddress": "…", "kelurahan": "…", "kecamatan": "…", "city": "…" },
  "visitNote": "…"
}
```

The preferred window must start in the future. Statuses are `Requested`,
`Under Review`, `Scheduled`, `Completed`, `Cancelled` and `Rejected`. Same-staff
overlapping `Scheduled` visits are rejected with `409 booking_schedule_conflict`;
adjacent half-open windows are allowed. Completion requires an actual
non-future time at or after the confirmed start and a patient-visible note.
Terminal bookings cannot be reopened. Patients may cancel their own `Requested`
or `Under Review` booking; `booking.manage` staff may reject/cancel according to
state.

This is a workflow simulation over a synthetic DKI Jakarta catalog. It does not
dispatch a real nurse, guarantee availability, take payment, or call anyone.

### Questions

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/patients/:patientId/questions` | session | Ask F5; body `{ "query": "…" }` |
| `POST` | `/api/v1/answers` | session | Compatibility body `{ "patient_id": "…", "query": "…" }` |

Answers are typed as `answer`, `refusal`, `emergency` or `error`. An `answer`
carries citations with provenance (`approved_plan` or
`unapproved_education`) and a synthetic-demo disclaimer. Before returning a
grounded answer the backend checks the cited approved text against the canonical
approval evidence. F5 availability is rechecked before each answer. Same-patient
questions serialize inside this process; that lock is not distributed.

### Operations

| Method | Path | Access | Purpose |
|---|---|---|---|
| `GET` | `/api/health` | operator key or session | Liveness, Langflow reachability, review-DB presence, flow manifest |
| `GET` | `/api/v1/flows` | `account.provision` | Flow-key → UUID map |

`/api/health` returns no patient data. It reports `langflow: "reachable" |
"unreachable"`, `reviewDbPresent`, `flowCount`, `manifestComplete`,
`missingFlows`, `readOnly` and the demo disclaimer.

The original unscoped proxy routes (`/api/v1/discharge`, `/api/v1/checkins`,
`/api/v1/plans/draft` and the legacy review-job routes) are **not public**; they
return `403`. All clinical work goes through the owned routes above.

## Local setup

Prerequisites: Bun (the service uses `bun:sqlite` and `Bun.password`), Docker
for Langflow, and a writable data directory.

```bash
cp .env.example .env
chmod 600 .env
mkdir -p data                  # or the parent directory of SYNCARE_STATE_DB
# Fill in Langflow credentials, origins and a >=32-byte cursor secret.

bun install
docker compose up -d langflow

# Register the five flow exports with the running engine.
bun run import:flows
bun run discover:flows          # writes the current flow UUIDs to flows.json

# Bind credentials to the imported flow nodes (only as needed for your install).
bash scripts/set-langflow-variables.sh
bun scripts/inject-gemini-key.ts   # or bind-gemini-key.ts when nodes read GEMINI_API_KEY

# Create the operational database and the first accounts (one time only).
chmod 600 /absolute/path/initial-accounts.json
bun scripts/initialize-accounts.ts --initialize < /absolute/path/initial-accounts.json

# Start the API.
bun run start
```

These are new-install steps, not an upgrade/reset procedure for an existing
engine. Flow import and discovery alone do not certify the F2/F5 runtime
bindings: verify the deployment-specific component IDs, code/edge hashes,
folder IDs and configuration against the reviewed exports using
[docs/runtime-bindings.md](docs/runtime-bindings.md). Container and host paths
must resolve to the same canonical approval database, and F5 must have its
protocol/vector-store paths configured. Do not overwrite live flows simply to
start an already provisioned backend.

The server prints its bind address, Langflow URL, review-DB path and read-only
state. It binds `127.0.0.1:8080` by default.

**Startup order matters.** The service does not create or seed the operational
database. `initialize-accounts` creates and migrates it; starting the server
against a missing state database fails with `state_db_missing`. The one-time
initializer also refuses to run when any account already exists, and it never
resets data.

### One-time account initialization

`initialize-accounts.ts --initialize` reads a private JSON document from stdin.
This abbreviated example shows one nurse and one patient; the script requires
2–10 of each:

```json
{
  "operator": { "identifier": "operator@example.invalid", "password": "…" },
  "nurses": [
    {
      "identifier": "nurse@example.invalid",
      "password": "…",
      "capabilities": [
        "patient.manage", "patient.provision", "risk.confirm",
        "review.decide", "booking.manage", "alert.manage"
      ]
    }
  ],
  "patients": [
    {
      "identifier": "patient@example.invalid",
      "password": "…",
      "displayName": "Synthetic Patient",
      "nurseIdentifier": "nurse@example.invalid"
    }
  ]
}
```

It creates the operator, provisions nurses with the listed capabilities,
creates synthetic patient profiles, assigns each patient to a nurse, creates
the patient logins, and revokes the bootstrap sessions. It prints counts only
and returns no credentials. A `local-demo-manifest.json` containing identifiers
and record IDs (no passwords) is written next to `SYNCARE_STATE_DB`; it is
created once and will not be overwritten.

### Optional access and catalog setup

These are explicit operator actions against an existing installation. Each
reads private JSON from stdin, requires an operator credential with
`capability.manage` (the initializers also check `account.provision`), audits
grants and registrations, and prints no credentials.

| Script | Input | Effect |
|---|---|---|
| `initialize-homecare.ts` | `{ credentials, nurseIdentifiers }` | Insert the synthetic catalog if missing; grant `booking.manage` to existing nurses |
| `initialize-homecare-staff.ts` | `{ credentials, staff: [{ identifier, displayName }] }` | Register existing active nurses that already hold `booking.manage` as bookable staff |
| `initialize-alert-access.ts` | `{ credentials, nurseIdentifiers }` | Grant `alert.manage` to existing assigned nurses |
| `initialize-review-access.ts` | `{ credentials, nurseIdentifiers }` | Grant `review.decide` to existing assigned nurses |
| `operator-capability.ts` | `{ credentials, change }` | Grant or revoke one capability with an expected version |

None of these scripts expands patient assignments, reactivates records, reseeds
clinical data, or runs automatically at startup.

## Configuration

Copy `.env.example` to `.env`. Secrets have no defaults and are never committed.
Bun loads `.env` for `bun run` commands.

| Variable | Required | Purpose |
|---|---|---|
| `LANGFLOW_API_KEY` | yes | Server-side key for the Langflow API |
| `LANGFLOW_BASE_URL` | no | Default `http://127.0.0.1:7860` |
| `SYNCARE_BACKEND_ORIGIN` | yes | Exact origin clients use to reach this API |
| `SYNCARE_WEB_ORIGIN` | yes | Allowed browser `Origin` |
| `SYNCARE_ALLOW_LOCAL_HTTP` | no | Permit loopback HTTP origins for development |
| `SYNCARE_CURSOR_SECRET` | yes | At least 32 bytes; signs pagination cursors |
| `SYNCARE_STATE_DB` | no | Operational SQLite path; default `data/console-state.sqlite3` |
| `SYNCARE_REVIEW_DB` | no | Canonical approval DB path; default `data/langflow/langflow/syncare-review.sqlite3` |
| `SYNCARE_HOST` / `SYNCARE_PORT` | no | Default `127.0.0.1:8080` |
| `SYNCARE_READ_ONLY` | no | Block mutations; login/logout still work |
| `SYNCARE_API_KEY` | no | Operator credential accepted only by `GET /api/health` |
| `SYNCARE_GUIDANCE_CONFIG` | no | Absolute path to emergency-guidance JSON; missing means unavailable |
| `SYNCARE_F2_CONTEXT_CONFIG` | no | Absolute path to the F2 context/binding JSON |
| `SYNCARE_PRIVATE_KEY_FILE` | Linux only | Absolute path to the 32-byte key for sealed private files |

The Compose service also reads:

| Variable | Required | Purpose |
|---|---|---|
| `LANGFLOW_SUPERUSER` | yes | Fresh Langflow superuser name |
| `LANGFLOW_SUPERUSER_PASSWORD` | yes | Fresh Langflow superuser password |
| `LANGFLOW_SECRET_KEY` | yes | Fernet key that encrypts Langflow global Variables |
| `GEMINI_API_KEY` | yes | Gemini credential used by the flows |
| `LANGFLOW_PORT` | no | Host port for Langflow; default `7860` |
| `LANGFLOW_AUTO_LOGIN` | no | Keep `false`; the human gate must not be bypassed |

`LANGFLOW_SECRET_KEY` must be a Fernet key (`Fernet.generate_key()`), not a hex
string. Losing it makes stored global Variables undecryptable. Exported flows
carry redacted credential fields; a global Variable alone does not satisfy them,
which is why the credential-binding scripts exist.

### Storage

- **Operational DB** (`SYNCARE_STATE_DB`): accounts, sessions, capability grants,
  assignments, patients, discharge versions, assessments, confirmations,
  check-ins and processing attempts, alerts/actions, homecare catalog/bookings,
  care-plan drafts, review jobs/events/decisions, idempotency receipts and
  operational audit. It uses WAL, foreign keys and numbered, checksum-tracked
  migrations. Startup never resets or seeds it.
- **Review DB** (`SYNCARE_REVIEW_DB`): canonical `approved_plans` and
  `audit_log`, written only by F4. The backend opens it read-only. `GET
  /api/health` reports whether it exists; F4 creates it when it first records an
  approval.

The two paths must be different. The service refuses an operational DB that
looks like the approval DB, and refuses an unrecognized database.

## Security notes

- `.env` is gitignored and should be `chmod 600`. `.env.example` documents names
  with empty values. Run `bash scripts/verify-secrets.sh` before committing.
- Langflow's API key stays server-side. Do not publish the Langflow port to the
  internet; restrict it to the backend host and operators.
- Session tokens are hashed at rest. Do not log them or put them in URLs.
- `SYNCARE_API_KEY` is health-only. It is not a user credential and does not
  unlock patient or domain routes.
- Login has in-process per-identifier and global attempt limits and bounds
  concurrent password verification. Unknown identifiers use a dummy Argon2id
  hash and the same generic denial response.
- Authenticated clinical routes do not currently have general per-account
  quotas, a global Langflow concurrency budget, or a credit-spend cap. Session
  authentication alone does not prevent resource or LLM-credit exhaustion; add
  deployment-level abuse controls before broad public use.
- Domain routes reject unknown body fields, duplicate query parameters and
  encoded path separators.
- Read-only mode blocks every non-`GET`/`HEAD`/`OPTIONS` request except session
  login and logout.
- Private configuration supports sealed demo credentials and environment values:
  Windows DPAPI (`dpapi:v1:`) or Linux AES-256-GCM (`aesgcm:v1:`) with an
  external 32-byte key at `SYNCARE_PRIVATE_KEY_FILE`, mode `0600`. The adapter
  never generates a key and never treats an invalid encrypted envelope as
  plaintext. Plain JSON and unsealed environment inputs are also accepted by
  the readers, so protect their files/process environment explicitly. Do not
  copy a `dpapi:` value to Linux; re-provision it there.
- `scripts/protect-local-secrets.ts` converts explicitly named files and prints
  counts only. It has no default paths.

## Checks

```bash
bun test                  # unit and integration suites
bunx tsc --noEmit         # TypeScript typecheck
bash scripts/verify-secrets.sh
```

Additional live checks require a running Langflow instance and suitable flow
data:

```bash
bash scripts/smoke-all-flows.sh   # F1/F2, including the red-flag branch
bash scripts/chain-full.sh        # F1 → F3 → F4 acceptance chain
bash scripts/smoke-f5.sh          # F5 approved vs unapproved
```

## Operations

- The reference deployment uses the systemd **user** unit
  `syncare-console.service`:

  ```bash
  systemctl --user status  syncare-console.service
  systemctl --user restart syncare-console.service   # after editing .env
  journalctl --user -u syncare-console.service -f
  ```

- Bind the console to loopback and terminate TLS in a reverse proxy. The proxy
  must forward `Authorization` and disable response buffering for the F4 SSE
  route (`flush_interval -1` in the Caddy example under `deploy/`).
- Health check:

  ```bash
  curl -s -H "Authorization: Bearer $SYNCARE_API_KEY" \
    http://127.0.0.1:8080/api/health
  ```

- Read-only demo mode: set `SYNCARE_READ_ONLY=1` and restart. Login and logout
  continue to work; all other writes return `403`. Background workers do not
  start. F1 startup recovery skips its repair writes in read-only mode; a
  writable restart is required to reconcile orphaned assessments.
- Startup applies migrations and recovers interrupted assessments and reviews
  before the listener accepts traffic. It never replays an uncertain F1/F2/F3/F4
  call automatically; request a fresh action explicitly.

Host-specific deployment notes (systemd, Caddy, troubleshooting) are in
[docs/OPERATIONS.md](docs/OPERATIONS.md). Its older single-token curl examples
predate account sessions; the session rules in this README are authoritative.
Secret provisioning is covered in
[docs/cross-platform-secrets.md](docs/cross-platform-secrets.md).

## Repository layout

| Path | Contents |
|---|---|
| `src/app.ts` | Origin/auth gate and route dispatch |
| `src/index.ts` | Startup: migrations, recovery, workers, listener |
| `src/legacy-app.ts` | Historical single-key HTTP adapter, mounted internally behind the gateway |
| `src/modules/` | Auth, patients, assessments, check-ins, alerts, homecare, plans, reviews, questions |
| `src/storage/` | Operational SQLite store and numbered migrations |
| `flows/` | Five Langflow flow exports |
| `flows.json` | Flow key → UUID map |
| `config/` | Example F2 context, emergency guidance and F5 runtime config |
| `scripts/` | Provisioning, flow import/repair, verification and smoke checks |
| `deploy/` | Caddy virtual-host example |
| `docs/` | Runbook and reference notes |

## Further reading

- [docs/flow-shapes.md](docs/flow-shapes.md): observed F1–F5 request/response shapes
- [docs/runtime-bindings.md](docs/runtime-bindings.md): flow-binding verification tooling
- [docs/cross-platform-secrets.md](docs/cross-platform-secrets.md): sealed private files and the protection CLI
- [docs/OPERATIONS.md](docs/OPERATIONS.md): deployment runbook and troubleshooting

## Limitations

- Synthetic demo data only; not a medical device and not clinically validated.
- No real homecare dispatch, staff availability guarantee, payment or call
  placement.
- FHIR-shaped artifacts are not SATUSEHAT submissions.
- SQLite and in-process workers are single-node. Per-patient question
  serialization is process-local, not a distributed lock.
- Retention and expiry behavior depend on the deployment; this repository does
  not promise automatic expiry or indefinite retention.
