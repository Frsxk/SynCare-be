CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0),
  identifier TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(identifier)) BETWEEN 1 AND 320),
  password_hash TEXT NOT NULL CHECK(length(password_hash) >= 32),
  role TEXT NOT NULL CHECK(role IN ('patient','nurse')),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND julianday(updated_at) >= julianday(created_at))
) STRICT;
CREATE TRIGGER accounts_role_immutable BEFORE UPDATE OF role ON accounts
WHEN NEW.role != OLD.role BEGIN SELECT RAISE(ABORT, 'account_role_immutable'); END;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  issued_at TEXT NOT NULL CHECK(julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK(julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at)),
  revoked_at TEXT CHECK(revoked_at IS NULL OR (julianday(revoked_at) IS NOT NULL AND julianday(revoked_at) >= julianday(issued_at)))
) STRICT;
CREATE INDEX sessions_account ON sessions(account_id, expires_at);

CREATE TABLE capability_grants (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  capability TEXT NOT NULL CHECK(length(trim(capability)) BETWEEN 1 AND 128),
  granted_by TEXT NOT NULL REFERENCES accounts(id),
  granted_at TEXT NOT NULL CHECK(julianday(granted_at) IS NOT NULL),
  revoked_by TEXT REFERENCES accounts(id),
  revoked_at TEXT CHECK(revoked_at IS NULL OR (julianday(revoked_at) IS NOT NULL AND julianday(revoked_at) >= julianday(granted_at))),
  CHECK((revoked_at IS NULL) = (revoked_by IS NULL))
) STRICT;
CREATE UNIQUE INDEX capability_grants_active ON capability_grants(account_id, capability) WHERE revoked_at IS NULL;
CREATE TRIGGER capability_grants_nurse BEFORE INSERT ON capability_grants
WHEN (SELECT role FROM accounts WHERE id=NEW.account_id) != 'nurse'
BEGIN SELECT RAISE(ABORT, 'nurse_account_required'); END;
CREATE TRIGGER capability_grants_history BEFORE UPDATE ON capability_grants
WHEN NEW.id != OLD.id OR NEW.account_id != OLD.account_id OR NEW.capability != OLD.capability
  OR NEW.granted_by != OLD.granted_by OR NEW.granted_at != OLD.granted_at OR OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'grant_history_immutable'); END;
CREATE TRIGGER capability_grants_no_delete BEFORE DELETE ON capability_grants
BEGIN SELECT RAISE(ABORT, 'grant_history_immutable'); END;
