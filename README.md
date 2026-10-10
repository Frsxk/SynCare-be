# SynCare-be

Backend for **SynCare** — post-discharge care orchestration for CHF patients
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
- **F5 fails closed**: no approval means no answer.

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
> serve F1–F5 without it. Only these routes work while it is down:
> `/api/health`, `/api/v1/flows`, `/api/v1/plans`, `/api/v1/plans/:patientId`
> — they read local SQLite and `flows.json` only.

Base URL in production: `https://syncare.trackover.web.id`

Every `/api/*` route requires `Authorization: Bearer <SYNCARE_API_KEY>`.
`/` and all other paths return `404` — this service serves no HTML.

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
| `404` | No such route — also returned for unknown `/api` paths **before** auth, so the surface cannot be mapped anonymously |
| `422` | Body failed schema validation |
| `502` | Could not open the F4 event stream (Langflow down, or stale job id) |
| `503` | `langflow_unreachable` / `langflow_timeout` — the clinical engine is down or slow; retry |
| `503` | `auth_not_configured` — the server has no `SYNCARE_API_KEY` |

---

## ⚠️ Notes for SynCare-fe

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
bun test                  # 62 tests
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

- [docs/BUILD-LOG.md](docs/BUILD-LOG.md) — what was built and in what order
- [docs/live-flow-verification.md](docs/live-flow-verification.md) — quoted live F1–F5 output
- [docs/flow-shapes.md](docs/flow-shapes.md) — observed request/response shapes
- [docs/memory-baseline.md](docs/memory-baseline.md) — **incomplete** memory measurement, no cap applied
