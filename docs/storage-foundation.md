# M01 operational storage foundation

Current M09,2026-10-26: no new migration or chat table; applied0001-0008 unchanged. Q1 reads latest canonical approval and reuses exact registered row+audit/fingerprint proof, then checks cited approved sentence against original artifact. F4 remains sole canonical business writer. Unique question sessions are transient; same-patient lock is process-local, not durable/distributed. Actual F5 calls perform their existing retrieval synchronization; vector collection configuration untouched. Selected M08 restart hash unchanged after M09 restart/F5 calls. [M09 report](../../docs/planning/SYNCARE-M09-VERIFICATION.md), [recovery](../../docs/planning/recovery-runbook.md). Historical records retained; two new owned booking cases cancelled normally. Native/deployed/whole-MVP open; earlier notes historical.

Current M08 extension,2026-10-26: applied0008_reviews adds immutable trusted care_plan_drafts, review_jobs, append-only review_events, unique review_decisions and approval_links. Original0001-0007 unchanged. Durable start/resume claims precede external dispatch; startup recovery and independent collector never auto-replay unknown intent. Full canonical row+audit/source/session/request/actor/note/physical-path fingerprint revalidated before publication; F4 sole canonical business writer. Actual five-review selected snapshot survived owned backend restart with38 events/5 decisions/2 links/14 receipts/5 canonical audits/2 plans and exact hash; isolated crash fixture proves canonical-commit-before-link recovery separately. [M08 verification](../../docs/planning/SYNCARE-M08-VERIFICATION.md), [recovery runbook](../../docs/planning/recovery-runbook.md). No database reset/history deletion/flow/Astra mutation. Engine retention/automatic timeout/deployed/native gates unverified; earlier extension notes historical.

Current extension, M07: new0007 alerts/append-only alert_actions with exact SUCCEEDED F2 source guards, unique report/attempt and immutable source/history/terminal constraints. Earlier applied0001-0006 unchanged. Separate local reconciler derives source identity from stored report/attempt, not work payload; alert/created action/work success commit atomically. Retry recovers only local materialization and never reruns F2. Current-authority/version/UUID actions atomically commit status/action/operational audit/receipt, with deliberately separate internal note and public summary. Exact3 alerts/9 actions/6 receipts/3 reports/3 attempts/6 work rows survived real process restart and resume unchanged. Earlier M05/M06 selections unchanged; M04 ALERT_F2 work legitimately consumed. [M07 report](../../docs/planning/SYNCARE-M07-VERIFICATION.md). No reset/deletion or canonical F4/Astra ownership change; all earlier status paragraphs below are historical.

Current extension, M06: reuse applied0006 without a new migration. One existing expectedVersion/idempotency transaction commits manual schedule, actual completion, cancellation/rejection and immutable history. Same-staff half-open overlap checks and live staff/account/grant/assignment checks execute in the write transaction. Explicit operator insert-if-missing staff registration does not grant assignments or reactivate records. Six actual booking rows,21 history rows,21 receipts and one referenced staff exact snapshot survived process restart; previous M05 snapshot also unchanged. Test finalization cancelled two new owned test cases normally, deleting zero records. [M06 verification](../../docs/planning/SYNCARE-M06-VERIFICATION.md). Earlier extension text is historical.

Current extension, M05: new0006 adds active homecare_services, eligible manual homecare_staff relation, bookings with version/immutable service-address-preference snapshots and separately nullable confirmed staff/slot, plus immutable booking_history. Six states and FK/time/uniqueness constraints are verified. Existing operational transaction/idempotency/cursor/auth helpers are reused; request and review are the only mounted writes. Explicit approved demo setup is operator-controlled and never startup reseeding/reactivation. Actual four-booking/seven-history/one-service restart hash PASS; later test bookings remain separate. Earlier migration checksums, Astra and canonical F4 approval ownership unchanged. [M05 verification](../../docs/planning/SYNCARE-M05-VERIFICATION.md).

Current extension, M04: migration 0005 adds immutable checkins with original confirmed-baseline references and separate durable processing_attempts. Existing work_items/idempotency_receipts are reused atomically; earlier migrations/checksums unchanged. Expired delivery is UNKNOWN rather than auto-replayed. F2 outcome and future ALERT_F2 work persistence remain separate, so an alert-work failure cannot hide a committed warning. Exact actual restart evidence covers ten reports, ten attempts and twelve work items; no reset/deletion. See [M04 verification](../../docs/planning/SYNCARE-M04-VERIFICATION.md). F4 remains the canonical approval writer; operational report storage does not replace Astra retrieval or that approval DB.

Current extension, M03: migration 0004 adds patient_episode_heads, assessments and risk_confirmations with exact discharge FKs, durable process state and immutable finalized evidence. Earlier migrations/checksums are unchanged. Source saves atomically move the head and increment the patient CAS revision; old confirmations remain historical under approved Q03. Current account routes are mounted since M02. See [M03 backend checkpoint](../../docs/planning/SYNCARE-M03-BACKEND-CHECKPOINT.md); the paragraphs below describe the original M01 foundation scope.

`src/storage/database.ts` exposes an explicit operational Store. It is not mounted into existing API routes in this milestone. Existing F1-F5 adapters and approval readers retain their current behavior.

## Ownership and initialization

- Bun owns the new operational schema only. F4 remains the approval writer; this module never creates or writes approved_plans/audit_log.
- Pass an absolute filesystem path or file URL object to Store.open. Missing files fail unless create:true is explicitly provided; parent directories are not silently created.
- Call migrate() explicitly. Numbered SQL files must be contiguous, immutable once applied and checksum-consistent. A failed migration rolls back its DDL and ledger entry. Opening/reopening does not seed, reset or delete data.
- M01 implements 0001_operations (audit, idempotency receipts, work queue), 0002_identity (accounts, hashed session references, explicit capability grants) and 0003_patients (profiles, account links, nurse assignments, immutable discharge versions). These are internal schema modules; account login/provisioning and patient APIs are not implemented by these migrations.
- Operational connections use foreign keys, WAL, FULL synchronization and a bounded busy timeout. Unknown application databases and approval databases are rejected before changing journal settings.
- Default backend paths use fileURLToPath so Windows drive names and spaces are handled correctly. Existing SYNCARE_STATE_DB/SYNCARE_REVIEW_DB overrides remain unchanged; no runtime database or environment file is created by this change.

## Transactions and work certainty

Transaction callbacks must be synchronous; the public method is awaitable. An immediate SQLite transaction serializes claims. A unique kind/source key and claim token protect work identity. Expired RUNNING work is not automatically reset/replayed; a later domain reconciler must establish its outcome. finishWork requires the matching claim token.

Store exposes no HTTP endpoint. Domain authorization belongs to M02 and later WBS tasks; do not pass client SQL to this internal library. New opt-in error/DTO, validation, pagination and idempotency helpers live in src/modules/contracts; legacy route error shapes remain unchanged.

## Schema boundaries

Accounts default inactive and receive no capability automatically. Password verifiers and 64-character lowercase SHA-256 session-token hashes have separate columns; there are no plaintext password/token columns. Schema checks are not a credential hashing or authentication service. Roles are fixed per account to preserve linked-record integrity. M02 must implement actual password hashing, token generation, account state/session expiry/revocation checks and authorization. No lifetime, activation authority or clinical capability policy is selected by the schema.

Identifiers have an ASCII case-insensitive uniqueness constraint. M02 must choose and enforce identifier normalization before provisioning. Patient profiles are structural JSON objects, with recorded condition separate from future assessment/confirmation records. Demographic requirements and field-level projections belong to the domain API. Patient links are immutable one-to-one; any future account replacement needs an explicit audited migration/policy, not direct relinking. Nurse assignments and capability grants retain revoke history. Grant authority and current effective scope must still be checked by backend services on every request.

Discharge versions preserve original source text, episode ownership, version, creator and timestamp. They cannot be updated/deleted. Corrections append a version. There is no risk scorer or clinical decision rule in these schemas.

## New domain contract helpers

- Errors: stable code/message/requestId/retryable envelope, optional conflict resource/version; no raw exception text. Opt-in only, not a change to existing app.ts responses.
- Structural inputs: reject unknown keys, empty/oversize text, malformed JSON and bodies over 262144 UTF-8 bytes. Text boundaries preserve original clinical whitespace/content. New HTTP routers must apply the body limit while reading, before allocating an unbounded request body; parseBoundedJson is a second guard for an already-read string.
- Idempotency: principal + method + canonical resource + UUID intent key, canonical JSON SHA-256 hash, same-payload replay, different-payload 409, receipt/effect in one immediate transaction. Authenticate and authorize the current principal/resource before calling withIdempotency, including replays. The callback is synchronous local DB work only; never place a Langflow/network call inside it. No automatic replay of uncertain upstream work.
- Pagination: default 20/max 100; signed opaque cursor binds principal/resource/filter scope to createdAt/id. CursorCodec requires an operator-supplied secret of at least 32 bytes, stable across normal restarts; no secret/default is embedded or configured by M01. Authorization remains mandatory and the caller must derive scope on the server. Use ORDER BY julianday(created_at) DESC,id DESC with seekBoundary; occurred_at is also supported for audit records. Scope must include the current authorized resource and filters, not client-supplied authority.

## Verification

```powershell
bun test test/storage-foundation.test.ts
bun test test/domain-contract.test.ts
bun test test/migrations
bun test
node node_modules/typescript/bin/tsc --noEmit
```

If Bun is not on PATH, the verified portable alternative is `npm exec --yes --package=bun@1.4.4 -- bun test` (use an existing npm cache or permit the official package download). This does not install Bun globally or change backend dependencies.

Tests use owned temporary directories and real SQLite files, including two child processes competing for one work item. They verify rollback, reopen, drift/sequence detection, path/approval separation and no automatic replay. They do not run Langflow.

inspectApprovalDatabase opens an existing file read-only, never creates a missing file, and always reports liveVerified:false. Finding the expected tables is not proof F4/backend/F5 use the same physical file, or that a care plan is valid/approved. A separate live check on 2026-10-25 verified the local Windows F4/backend/F5 mapping, matching plan/audit timestamp, actual Astra retrieval and preservation after a backend restart. This evidence does not change the static inspector's deliberately conservative flag. See [local integration verification](../../docs/planning/SYNCARE-LOCAL-INTEGRATION-2026-10-25.md). The deployed topology remains NOT VERIFIED; repeat live verification at M08/T-0705 and before MVP acceptance as required by DL-008.
