# SynCare Backend (`SynCare-be`) — Build Log

**Repo:** `/home/ubuntu/kittys-workspace/syncare-be` (local-only, 9 commits)
**Updated:** 2026-10-09

**Goal:** Langflow 1.12.3 in Docker holding the five verified SynCare flows (F1–F5), plus an Elysia/Bun console that drives them as a thin proxy — with fresh credentials, a clean database, and reproducible evidence.

**Architecture:** Langflow owns *all* clinical logic (scoring, tiering, red-flag escalation, plan drafting, human approval, RAG). The Elysia console owns *zero* clinical logic: it reads the flow-owned review DB `mode=ro` and drives flows only via `POST /api/v1/run/{flow_id}`.

---

## Status

**9 commits, local-only. Secret scan clean on every one.**

| Task | State | Evidence |
|---|---|---|
| 1. Repo skeleton + hygiene | done | `fae08f5` — scanner negative-tested (catches a planted `AstraCS:` token) |
| 2. Langflow 1.12.3, clean DB | done | `b43f7e4` — `/health` 200, **0 flows** seeded |
| 3. Memory baseline | honest partial | `3bae596` — measurement incomplete, **no cap applied** |
| 4. Credentials | **BLOCKED** | needs `GEMINI_API_KEY` + Astra globals |
| 5. Import 5 flows | done | `d205ab6` — 5/5, node counts 4/7/6/12/11 |
| 6. Discover IDs by name | done | `d205ab6` — `flows.json`, fails loudly if incomplete |
| 7. Components load | done | all flows serve; F1 reaches its Gemini node |
| 8. Config + app shell | done | `af40388` — 49 tests, clean `tsc` |
| 9. Read-only DB reader | done | `bd9550c` — membership-based approval state |
| 10. Langflow client | done | `c708b75` + `f661207` — 55 s timeout, key redaction |
| 11. `/healthz` + read-only | done | `af40388` — live check: 403 on write |
| 12-18. Route modules | next | F3/F4/F5 proxies + approval gate |
| 19-22. UI, E2E, README | blocked on task 4 | needs live flow execution |

**Verified live:** console `/healthz` reports `langflow: reachable`, `flowCount: 5`,
`manifestComplete: true`; `POST /api/v1/checkins` returns 403 in read-only mode;
F1 executes the entire graph and stops only at the Gemini credential check.

---

## Verified environment facts

| Fact | Value |
|---|---|
| Bun | 1.4.2 at `~/.bun/bin/bun` (not on non-login PATH) |
| Elysia | 1.4.30 |
| Langflow image | `langflowai/langflow:1.12.3` (official) |
| Container user | uid 1000 -> bind mounts need `chown 1000:1000` |
| Host | 2 vCPU, 3.6 GB RAM, 1.9 GB swap (**sustainedly exhausted**), 16 GB disk free |
| Langflow floor | ~1.55 GB RSS even with `--workers 1` |
| Review DB schema | `approved_plans(plan_json, approved_at, reviewer_note)`, `audit_log(action, actor, timestamp, payload)` — **no `patient_id` column** |
| Approval truth | `approved_plans` **table membership**, never `plan_json.status` |
| Bob MCP client timeout | ~60 s -> console default **55 s** |
| `LANGFLOW_WORKERS` | **Not a real setting** — silently ignored. Use CLI `--workers 1`. |
| `LANGFLOW_SECRET_KEY` | Must be a **Fernet key** (`Fernet.generate_key()`), not `openssl rand -hex` |

## Bugs found and fixed

1. **`PermissionError: /app/langflow/.cache`** — container uid 1000 vs root-owned bind mount -> `chown -R 1000:1000`.
2. **26 starter projects seeded** -> `LANGFLOW_CREATE_STARTER_PROJECTS=false` + `UPDATE=false` (clean MCP surface, as requested).
3. **`Fernet key must be 32 url-safe base64 bytes`** — `openssl rand -hex 32` is not a Fernet key; API-key minting failed. Also learned `docker compose restart` does **not** re-read env — needs `--force-recreate`.
4. **`LANGFLOW_WORKERS` is a placebo** — it reached the container but no Langflow code reads it. Removed rather than left as a fake knob; replaced with the CLI flag that genuinely works.
5. **`app.onError()` after the route chain** — routes registered earlier fall outside its scope, so a thrown `ReadOnlyViolation` surfaced as 500 instead of 403. Fixed by putting `onError` inside the builder chain. *Found by a failing test, not by inspection.*
6. **Elysia `onError` catch-all** — an `onError` registered under a code name handles *every* error in scope, so it must discriminate on `ctx.code` and default to 500.

## Secrets handling

- Fresh superuser password and Fernet key generated per install; the previously burned one is not reused.
- `.env` is gitignored; `scripts/verify-secrets.sh` runs before every commit and is negative-tested.
- Gemini + Astra credentials go into Langflow global Variables — never in git, never in chat.

---

## Remaining work

1. **Credentials** (blocking): `GEMINI_API_KEY`, `ASTRA_DB_API_ENDPOINT`, `ASTRA_DB_API_TOKEN` as Langflow global Variables.
2. **Routes:** F3 draft proxy, F4 review start/resume (incl. the late-approval -> fallback case), F5 Q&A proxy.
3. **Re-measure memory** once host load drops; only then consider a cap.
4. **UI shell, live E2E run, screenshots, README.**

## Repo layout (as built)

```
SynCare-be/
├── docker-compose.yml      # Langflow, --workers 1, clean DB
├── .env.example  .gitignore
├── flows.json              # generated: name -> id (never hand-written)
├── flows/*.json            # the 5 verified exports
├── data/                   # gitignored runtime state
├── docs/{memory-baseline,flow-shapes}.md
├── scripts/{bring-up-langflow,import-flows,discover-flows,smoke-client,smoke-memory,verify-secrets}
├── src/{index,app,config}.ts
├── src/plugins/{langflow,review-db}.ts
└── test/{app,langflow,review-db}.test.ts + fixture-db.ts
```