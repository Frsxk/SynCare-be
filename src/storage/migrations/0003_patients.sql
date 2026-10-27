CREATE TABLE patients (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) > 0),
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json) AND json_type(profile_json)='object'),
  recorded_condition TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  updated_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND julianday(updated_at) >= julianday(created_at))
) STRICT;
CREATE INDEX patients_order ON patients(created_at DESC, id DESC);

CREATE TABLE patient_account_links (
  patient_id TEXT PRIMARY KEY NOT NULL REFERENCES patients(id),
  account_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  linked_by TEXT NOT NULL REFERENCES accounts(id),
  linked_at TEXT NOT NULL CHECK(julianday(linked_at) IS NOT NULL)
) STRICT;
CREATE TRIGGER patient_links_role BEFORE INSERT ON patient_account_links
WHEN (SELECT role FROM accounts WHERE id=NEW.account_id) != 'patient'
BEGIN SELECT RAISE(ABORT, 'patient_account_required'); END;
CREATE TRIGGER patient_links_no_update BEFORE UPDATE ON patient_account_links
BEGIN SELECT RAISE(ABORT, 'patient_link_immutable'); END;
CREATE TRIGGER patient_links_no_delete BEFORE DELETE ON patient_account_links
BEGIN SELECT RAISE(ABORT, 'patient_link_immutable'); END;

CREATE TABLE patient_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  nurse_account_id TEXT NOT NULL REFERENCES accounts(id),
  granted_by TEXT NOT NULL REFERENCES accounts(id),
  effective_at TEXT NOT NULL CHECK(julianday(effective_at) IS NOT NULL),
  revoked_at TEXT CHECK(revoked_at IS NULL OR (julianday(revoked_at) IS NOT NULL AND julianday(revoked_at) >= julianday(effective_at))),
  revoked_by TEXT REFERENCES accounts(id),
  CHECK((revoked_at IS NULL) = (revoked_by IS NULL))
) STRICT;
CREATE UNIQUE INDEX patient_assignments_active ON patient_assignments(patient_id,nurse_account_id) WHERE revoked_at IS NULL;
CREATE INDEX patient_assignments_scope ON patient_assignments(nurse_account_id,revoked_at,patient_id);
CREATE TRIGGER patient_assignments_role BEFORE INSERT ON patient_assignments
WHEN (SELECT role FROM accounts WHERE id=NEW.nurse_account_id) != 'nurse'
BEGIN SELECT RAISE(ABORT, 'nurse_account_required'); END;
CREATE TRIGGER patient_assignments_history BEFORE UPDATE ON patient_assignments
WHEN NEW.id != OLD.id OR NEW.patient_id != OLD.patient_id OR NEW.nurse_account_id != OLD.nurse_account_id
  OR NEW.granted_by != OLD.granted_by OR NEW.effective_at != OLD.effective_at OR OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'assignment_history_immutable'); END;
CREATE TRIGGER patient_assignments_no_delete BEFORE DELETE ON patient_assignments
BEGIN SELECT RAISE(ABORT, 'assignment_history_immutable'); END;

CREATE TABLE discharge_versions (
  id TEXT PRIMARY KEY NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  episode_id TEXT NOT NULL CHECK(length(episode_id) > 0),
  version INTEGER NOT NULL CHECK(version >= 1),
  source_text TEXT NOT NULL CHECK(length(trim(source_text)) BETWEEN 1 AND 64000),
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  UNIQUE(episode_id,version)
) STRICT;
CREATE INDEX discharge_versions_patient ON discharge_versions(patient_id,created_at DESC,id DESC);
CREATE TRIGGER discharge_episode_owner BEFORE INSERT ON discharge_versions
WHEN EXISTS(SELECT 1 FROM discharge_versions WHERE episode_id=NEW.episode_id AND patient_id != NEW.patient_id)
BEGIN SELECT RAISE(ABORT, 'episode_patient_mismatch'); END;
CREATE TRIGGER discharge_versions_no_update BEFORE UPDATE ON discharge_versions
BEGIN SELECT RAISE(ABORT, 'discharge_history_immutable'); END;
CREATE TRIGGER discharge_versions_no_delete BEFORE DELETE ON discharge_versions
BEGIN SELECT RAISE(ABORT, 'discharge_history_immutable'); END;
