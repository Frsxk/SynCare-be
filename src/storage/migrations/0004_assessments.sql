CREATE UNIQUE INDEX discharge_source_identity ON discharge_versions(id,patient_id,version);
CREATE UNIQUE INDEX discharge_episode_identity ON discharge_versions(patient_id,episode_id,id,version);

CREATE TABLE patient_episode_heads (
  patient_id TEXT PRIMARY KEY NOT NULL REFERENCES patients(id),
  episode_id TEXT NOT NULL UNIQUE,
  current_discharge_id TEXT NOT NULL UNIQUE,
  current_version INTEGER NOT NULL CHECK(current_version >= 1),
  updated_by TEXT NOT NULL REFERENCES accounts(id),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL),
  version INTEGER NOT NULL CHECK(version >= 1),
  FOREIGN KEY(patient_id,episode_id,current_discharge_id,current_version)
    REFERENCES discharge_versions(patient_id,episode_id,id,version)
) STRICT;
CREATE TRIGGER episode_head_identity BEFORE UPDATE ON patient_episode_heads
WHEN NEW.patient_id != OLD.patient_id OR NEW.episode_id != OLD.episode_id
  OR NEW.version != OLD.version+1 OR NEW.current_version != OLD.current_version+1
BEGIN SELECT RAISE(ABORT, 'episode_head_invalid_transition'); END;
CREATE TRIGGER episode_head_no_delete BEFORE DELETE ON patient_episode_heads
BEGIN SELECT RAISE(ABORT, 'episode_head_history_required'); END;

CREATE TABLE assessments (
  id TEXT PRIMARY KEY NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  discharge_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version >= 1),
  requested_by TEXT NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) > 0),
  session_id TEXT NOT NULL UNIQUE CHECK(length(session_id) > 0),
  state TEXT NOT NULL CHECK(state IN ('RUNNING','SUCCEEDED','INVALID','FAILED','UNKNOWN')),
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  completed_at TEXT CHECK(completed_at IS NULL OR (julianday(completed_at) IS NOT NULL AND julianday(completed_at)>=julianday(created_at))),
  output_json TEXT CHECK(output_json IS NULL OR (json_valid(output_json) AND json_type(output_json)='object')),
  raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),
  failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('invalid_flow_output','dependency_unavailable','outcome_unknown')),
  UNIQUE(requested_by,discharge_id,idempotency_key),
  FOREIGN KEY(discharge_id,patient_id,source_version) REFERENCES discharge_versions(id,patient_id,version),
  CHECK((state='RUNNING' AND completed_at IS NULL AND version=1) OR (state!='RUNNING' AND completed_at IS NOT NULL AND version=2)),
  CHECK((state='SUCCEEDED' AND output_json IS NOT NULL AND raw_json IS NOT NULL AND failure_code IS NULL) OR state!='SUCCEEDED')
) STRICT;
CREATE INDEX assessments_patient_order ON assessments(patient_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX assessment_patient_identity ON assessments(id,patient_id);
CREATE TRIGGER assessment_identity BEFORE UPDATE ON assessments
WHEN OLD.state!='RUNNING' OR NEW.state='RUNNING' OR NEW.version!=OLD.version+1
  OR NEW.id!=OLD.id OR NEW.patient_id!=OLD.patient_id OR NEW.discharge_id!=OLD.discharge_id
  OR NEW.source_version!=OLD.source_version OR NEW.requested_by!=OLD.requested_by
  OR NEW.idempotency_key!=OLD.idempotency_key OR NEW.session_id!=OLD.session_id OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT, 'assessment_history_immutable'); END;
CREATE TRIGGER assessment_no_delete BEFORE DELETE ON assessments
BEGIN SELECT RAISE(ABORT, 'assessment_history_immutable'); END;

CREATE TABLE risk_confirmations (
  id TEXT PRIMARY KEY NOT NULL,
  assessment_id TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  category TEXT NOT NULL CHECK(category IN ('LOW','MEDIUM','HIGH')),
  confirmed_by TEXT NOT NULL REFERENCES accounts(id),
  confirmed_at TEXT NOT NULL CHECK(julianday(confirmed_at) IS NOT NULL),
  version INTEGER NOT NULL CHECK(version=1),
  FOREIGN KEY(assessment_id,patient_id) REFERENCES assessments(id,patient_id)
) STRICT;
CREATE INDEX confirmations_patient_order ON risk_confirmations(patient_id,confirmed_at DESC,id DESC);
CREATE TRIGGER confirmation_source_category BEFORE INSERT ON risk_confirmations
WHEN NOT EXISTS(SELECT 1 FROM assessments a JOIN patient_episode_heads h ON h.patient_id=a.patient_id
  JOIN accounts n ON n.id=NEW.confirmed_by
  WHERE a.id=NEW.assessment_id AND a.patient_id=NEW.patient_id AND a.state='SUCCEEDED'
    AND h.current_discharge_id=a.discharge_id AND json_extract(a.output_json,'$.tier')=NEW.category
    AND n.role='nurse' AND n.active=1)
BEGIN SELECT RAISE(ABORT, 'confirmation_requires_valid_current_source'); END;
CREATE TRIGGER confirmation_no_update BEFORE UPDATE ON risk_confirmations
BEGIN SELECT RAISE(ABORT, 'confirmation_history_immutable'); END;
CREATE TRIGGER confirmation_no_delete BEFORE DELETE ON risk_confirmations
BEGIN SELECT RAISE(ABORT, 'confirmation_history_immutable'); END;
