CREATE TABLE care_plan_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  assessment_id TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  parent_draft_id TEXT REFERENCES care_plan_drafts(id),
  source_review_id TEXT UNIQUE REFERENCES review_jobs(id),
  requested_by TEXT NOT NULL REFERENCES accounts(id),
  input_json TEXT NOT NULL CHECK(json_valid(input_json) AND json_type(input_json)='object'),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  artifact_json TEXT CHECK(artifact_json IS NULL OR (json_valid(artifact_json) AND json_type(artifact_json)='object')),
  artifact_hash TEXT CHECK(artifact_hash IS NULL OR length(artifact_hash)=64),
  state TEXT NOT NULL CHECK(state IN ('RUNNING','DRAFT','INVALID','FAILED','UNKNOWN')),
  version INTEGER NOT NULL CHECK(version IN (1,2)),
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at)>=julianday(created_at)),
  FOREIGN KEY(assessment_id,patient_id) REFERENCES assessments(id,patient_id),
  FOREIGN KEY(confirmation_id,patient_id) REFERENCES risk_confirmations(id,patient_id),
  CHECK((state='RUNNING' AND version=1) OR (state!='RUNNING' AND version=2) OR (state='DRAFT' AND version=1 AND source_review_id IS NOT NULL)),
  CHECK((state='DRAFT' AND artifact_json IS NOT NULL AND artifact_hash IS NOT NULL) OR (state!='DRAFT' AND artifact_json IS NULL AND artifact_hash IS NULL)),
  CHECK((parent_draft_id IS NULL AND source_review_id IS NULL) OR (parent_draft_id IS NOT NULL AND source_review_id IS NOT NULL))
) STRICT;
CREATE INDEX drafts_patient_order ON care_plan_drafts(patient_id,created_at DESC,id DESC);
CREATE TRIGGER draft_trusted_source BEFORE INSERT ON care_plan_drafts WHEN NOT EXISTS (
  SELECT 1 FROM assessments a JOIN risk_confirmations c ON c.assessment_id=a.id
  WHERE a.id=NEW.assessment_id AND a.patient_id=NEW.patient_id AND c.id=NEW.confirmation_id AND a.state='SUCCEEDED'
    AND json_extract(NEW.input_json,'$.patient_id')=NEW.patient_id
    AND json(json_extract(NEW.input_json,'$.f1_scored_output'))=json(a.output_json)
) BEGIN SELECT RAISE(ABORT,'draft_requires_exact_F1'); END;
CREATE TRIGGER draft_immutable BEFORE UPDATE ON care_plan_drafts WHEN
  OLD.state!='RUNNING' OR NEW.version!=OLD.version+1 OR NEW.state='RUNNING'
  OR NEW.id!=OLD.id OR NEW.patient_id!=OLD.patient_id OR NEW.assessment_id!=OLD.assessment_id OR NEW.confirmation_id!=OLD.confirmation_id
  OR NEW.parent_draft_id IS NOT OLD.parent_draft_id OR NEW.source_review_id IS NOT OLD.source_review_id
  OR NEW.requested_by!=OLD.requested_by OR NEW.input_json!=OLD.input_json OR NEW.input_hash!=OLD.input_hash OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'draft_source_or_artifact_immutable'); END;
CREATE TRIGGER draft_no_delete BEFORE DELETE ON care_plan_drafts BEGIN SELECT RAISE(ABORT,'draft_history_required'); END;
CREATE TRIGGER draft_revision_source BEFORE INSERT ON care_plan_drafts WHEN NEW.parent_draft_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM review_jobs r JOIN care_plan_drafts p ON p.id=r.draft_id JOIN review_decisions c ON c.review_id=r.id
  WHERE r.id=NEW.source_review_id AND p.id=NEW.parent_draft_id AND p.patient_id=NEW.patient_id AND p.assessment_id=NEW.assessment_id
    AND p.confirmation_id=NEW.confirmation_id AND c.action_id='request_changes' AND c.actor_id=NEW.requested_by
) BEGIN SELECT RAISE(ABORT,'revision_requires_exact_parent_review'); END;

CREATE TABLE review_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL UNIQUE REFERENCES care_plan_drafts(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  session_id TEXT NOT NULL UNIQUE,
  upstream_id TEXT UNIQUE,
  started_by TEXT NOT NULL REFERENCES accounts(id),
  state TEXT NOT NULL CHECK(state IN ('STARTING','START_UNKNOWN','RUNNING','WAITING_FOR_HUMAN','DECISION_PENDING','DECISION_UNKNOWN','REVISION_DRAFT','APPROVED','ESCALATED','FAILED','EXPIRED','UNKNOWN','INVALID')),
  version INTEGER NOT NULL CHECK(version>=1),
  upstream_status TEXT,
  gate_json TEXT CHECK(gate_json IS NULL OR (json_valid(gate_json) AND json_type(gate_json)='object')),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  revised_draft_id TEXT REFERENCES care_plan_drafts(id),
  failure_code TEXT,
  dispatch_at TEXT CHECK(dispatch_at IS NULL OR julianday(dispatch_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at)>=julianday(created_at))
) STRICT;
CREATE INDEX reviews_patient_order ON review_jobs(patient_id,created_at DESC,id DESC);
CREATE TRIGGER review_exact_draft BEFORE INSERT ON review_jobs WHEN NOT EXISTS (
  SELECT 1 FROM care_plan_drafts WHERE id=NEW.draft_id AND patient_id=NEW.patient_id AND state='DRAFT'
) BEGIN SELECT RAISE(ABORT,'review_requires_guarded_draft'); END;
CREATE TRIGGER review_version_source BEFORE UPDATE ON review_jobs WHEN
  NEW.version!=OLD.version+1 OR NEW.id!=OLD.id OR NEW.draft_id!=OLD.draft_id OR NEW.patient_id!=OLD.patient_id
  OR NEW.session_id!=OLD.session_id OR NEW.started_by!=OLD.started_by OR NEW.created_at!=OLD.created_at
  OR (OLD.upstream_id IS NOT NULL AND NEW.upstream_id IS NOT OLD.upstream_id)
  OR (OLD.dispatch_at IS NOT NULL AND NEW.dispatch_at IS NOT OLD.dispatch_at)
  OR OLD.state IN ('REVISION_DRAFT','APPROVED','ESCALATED','FAILED','EXPIRED','INVALID')
BEGIN SELECT RAISE(ABORT,'review_version_source_or_terminal_invalid'); END;
CREATE TRIGGER review_approval_evidence BEFORE UPDATE ON review_jobs WHEN NEW.state='APPROVED' AND NOT EXISTS (SELECT 1 FROM approval_links WHERE review_id=NEW.id AND draft_id=NEW.draft_id AND patient_id=NEW.patient_id)
BEGIN SELECT RAISE(ABORT,'review_requires_approval_evidence'); END;
CREATE TRIGGER review_revision_evidence BEFORE UPDATE ON review_jobs WHEN NEW.state='REVISION_DRAFT' AND NOT EXISTS (SELECT 1 FROM care_plan_drafts WHERE id=NEW.revised_draft_id AND source_review_id=NEW.id AND parent_draft_id=NEW.draft_id)
BEGIN SELECT RAISE(ABORT,'review_requires_revision_evidence'); END;
CREATE TRIGGER review_no_delete BEFORE DELETE ON review_jobs BEGIN SELECT RAISE(ABORT,'review_history_required'); END;

CREATE TABLE review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES review_jobs(id),
  version INTEGER NOT NULL CHECK(version>=1),
  kind TEXT NOT NULL CHECK(kind IN ('snapshot','gate','state','result','error')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  UNIQUE(review_id,version)
) STRICT;
CREATE TRIGGER review_event_exact BEFORE INSERT ON review_events WHEN NOT EXISTS (SELECT 1 FROM review_jobs WHERE id=NEW.review_id AND version=NEW.version)
BEGIN SELECT RAISE(ABORT,'review_event_current_version_required'); END;
CREATE TRIGGER review_event_no_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT,'review_events_append_only'); END;
CREATE TRIGGER review_event_no_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT,'review_events_append_only'); END;

CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL REFERENCES review_jobs(id),
  request_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  action_id TEXT NOT NULL,
  reviewer_note TEXT NOT NULL,
  expected_version INTEGER NOT NULL CHECK(expected_version>=1),
  state TEXT NOT NULL CHECK(state IN ('CLAIMED','SENT','UNKNOWN','CONFIRMED')),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at)>=julianday(created_at)),
  UNIQUE(review_id,request_id)
) STRICT;
CREATE TRIGGER decision_claim_exact BEFORE INSERT ON review_decisions WHEN NOT EXISTS (
  SELECT 1 FROM review_jobs WHERE id=NEW.review_id AND state='WAITING_FOR_HUMAN' AND version=NEW.expected_version
    AND json_extract(gate_json,'$.requestId')=NEW.request_id
    AND EXISTS (SELECT 1 FROM json_each(gate_json,'$.options') WHERE json_extract(value,'$.actionId')=NEW.action_id)
) BEGIN SELECT RAISE(ABORT,'decision_requires_actual_gate'); END;
CREATE TRIGGER decision_claim_immutable BEFORE UPDATE ON review_decisions WHEN NEW.id!=OLD.id OR NEW.review_id!=OLD.review_id
  OR NEW.request_id!=OLD.request_id OR NEW.actor_id!=OLD.actor_id OR NEW.action_id!=OLD.action_id OR NEW.reviewer_note!=OLD.reviewer_note
  OR NEW.expected_version!=OLD.expected_version OR NEW.created_at!=OLD.created_at OR OLD.state='CONFIRMED'
BEGIN SELECT RAISE(ABORT,'decision_claim_immutable'); END;
CREATE TRIGGER decision_no_delete BEFORE DELETE ON review_decisions BEGIN SELECT RAISE(ABORT,'decision_history_required'); END;

CREATE TABLE approval_links (
  id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL UNIQUE REFERENCES review_jobs(id),
  draft_id TEXT NOT NULL REFERENCES care_plan_drafts(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  fingerprint TEXT NOT NULL UNIQUE CHECK(length(fingerprint)=64),
  plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
  approved_at TEXT NOT NULL CHECK(julianday(approved_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL)
) STRICT;
CREATE TRIGGER approval_link_exact BEFORE INSERT ON approval_links WHEN NOT EXISTS (
  SELECT 1 FROM review_jobs r JOIN care_plan_drafts d ON d.id=r.draft_id JOIN review_decisions c ON c.review_id=r.id
  WHERE r.id=NEW.review_id AND r.draft_id=NEW.draft_id AND r.patient_id=NEW.patient_id AND d.artifact_hash=NEW.plan_hash AND c.action_id='approve'
) BEGIN SELECT RAISE(ABORT,'approval_requires_correlated_review'); END;
CREATE TRIGGER approval_link_no_update BEFORE UPDATE ON approval_links BEGIN SELECT RAISE(ABORT,'approval_evidence_immutable'); END;
CREATE TRIGGER approval_link_no_delete BEFORE DELETE ON approval_links BEGIN SELECT RAISE(ABORT,'approval_evidence_history_required'); END;
