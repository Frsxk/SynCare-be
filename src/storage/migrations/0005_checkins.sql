CREATE UNIQUE INDEX confirmation_patient_identity ON risk_confirmations(id,patient_id);
CREATE TABLE checkins (
  id TEXT PRIMARY KEY NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  submitted_by TEXT NOT NULL REFERENCES accounts(id),
  message TEXT NOT NULL CHECK(length(trim(message)) BETWEEN 1 AND 8000),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  baseline_assessment_id TEXT,
  baseline_confirmation_id TEXT,
  baseline_score REAL CHECK(baseline_score IS NULL OR baseline_score>=0),
  version INTEGER NOT NULL CHECK(version=1),
  FOREIGN KEY(baseline_assessment_id,patient_id) REFERENCES assessments(id,patient_id),
  FOREIGN KEY(baseline_confirmation_id,patient_id) REFERENCES risk_confirmations(id,patient_id),
  CHECK((baseline_assessment_id IS NULL AND baseline_confirmation_id IS NULL AND baseline_score IS NULL)
    OR (baseline_assessment_id IS NOT NULL AND baseline_confirmation_id IS NOT NULL AND baseline_score IS NOT NULL))
) STRICT;
CREATE INDEX checkins_patient_order ON checkins(patient_id,created_at DESC,id DESC);
CREATE TRIGGER checkin_baseline_source BEFORE INSERT ON checkins
WHEN NEW.baseline_assessment_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM assessments a JOIN risk_confirmations c ON c.assessment_id=a.id
  JOIN patient_episode_heads h ON h.patient_id=a.patient_id
  WHERE a.id=NEW.baseline_assessment_id AND c.id=NEW.baseline_confirmation_id
    AND a.patient_id=NEW.patient_id AND a.state='SUCCEEDED' AND a.discharge_id=h.current_discharge_id
    AND json_extract(a.output_json,'$.score')=NEW.baseline_score)
BEGIN SELECT RAISE(ABORT, 'checkin_requires_exact_confirmed_baseline'); END;
CREATE TRIGGER checkin_no_update BEFORE UPDATE ON checkins
BEGIN SELECT RAISE(ABORT, 'checkin_source_immutable'); END;
CREATE TRIGGER checkin_no_delete BEFORE DELETE ON checkins
BEGIN SELECT RAISE(ABORT, 'checkin_history_required'); END;

CREATE TABLE processing_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  checkin_id TEXT NOT NULL UNIQUE REFERENCES checkins(id),
  session_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PENDING','BLOCKED_BASELINE','RUNNING','SUCCEEDED','INVALID','FAILED','UNKNOWN')),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND julianday(updated_at)>=julianday(created_at)),
  output_json TEXT CHECK(output_json IS NULL OR (json_valid(output_json) AND json_type(output_json)='object')),
  raw_json TEXT CHECK(raw_json IS NULL OR json_valid(raw_json)),
  failure_code TEXT CHECK(failure_code IS NULL OR failure_code IN ('baseline_unavailable','invalid_flow_output','dependency_unavailable','outcome_unknown')),
  CHECK((state IN ('PENDING','BLOCKED_BASELINE') AND version=1) OR (state='RUNNING' AND version=2)
    OR (state IN ('SUCCEEDED','INVALID','FAILED','UNKNOWN') AND version=3)),
  CHECK(state!='SUCCEEDED' OR (output_json IS NOT NULL AND raw_json IS NOT NULL AND failure_code IS NULL)),
  CHECK(state='SUCCEEDED' OR output_json IS NULL)
) STRICT;
CREATE TRIGGER checkin_attempt_transition BEFORE UPDATE ON processing_attempts
WHEN NEW.id!=OLD.id OR NEW.checkin_id!=OLD.checkin_id OR NEW.session_id!=OLD.session_id OR NEW.created_at!=OLD.created_at
  OR NEW.version!=OLD.version+1 OR NOT ((OLD.state='PENDING' AND NEW.state='RUNNING')
    OR (OLD.state='RUNNING' AND NEW.state IN ('SUCCEEDED','INVALID','FAILED','UNKNOWN')))
BEGIN SELECT RAISE(ABORT, 'checkin_attempt_immutable_or_invalid_transition'); END;
CREATE TRIGGER checkin_attempt_no_delete BEFORE DELETE ON processing_attempts
BEGIN SELECT RAISE(ABORT, 'checkin_attempt_history_required'); END;
