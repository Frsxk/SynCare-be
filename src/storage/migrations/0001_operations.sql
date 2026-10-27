CREATE TABLE operational_audit (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK(julianday(occurred_at) IS NOT NULL),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX operational_audit_resource ON operational_audit(resource_type, resource_id, occurred_at DESC, id DESC);

CREATE TABLE idempotency_receipts (
  principal_id TEXT NOT NULL,
  method TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  response_status INTEGER NOT NULL CHECK(response_status BETWEEN 200 AND 599),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  PRIMARY KEY(principal_id, method, resource_key, idempotency_key)
) STRICT;

CREATE TABLE work_items (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','SUCCEEDED','FAILED','UNKNOWN')),
  available_at TEXT NOT NULL CHECK(julianday(available_at) IS NOT NULL),
  claim_token TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
  UNIQUE(kind, source_key),
  CHECK(state != 'RUNNING' OR (claim_token IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL))
) STRICT;
CREATE INDEX work_items_pending ON work_items(kind, state, available_at, id);

