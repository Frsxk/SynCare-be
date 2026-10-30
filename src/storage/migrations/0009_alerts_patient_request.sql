-- 0009: durable direct patient emergency requests share the nurse alert queue with F2 alerts.
-- Rebuild alerts/alert_actions in place because the legacy tables forbid NULL checkin/attempt
-- and only allow source_type='F2'. Old ids, evidence, status history and timestamps are copied
-- verbatim; no row is synthesized. Foreign keys stay enabled for the whole migration.
CREATE TABLE alerts_next (
  id TEXT PRIMARY KEY NOT NULL,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  checkin_id TEXT UNIQUE REFERENCES checkins(id),
  attempt_id TEXT UNIQUE REFERENCES processing_attempts(id),
  source_type TEXT NOT NULL CHECK(source_type IN ('F2','PATIENT_REQUEST')),
  source_action TEXT NOT NULL CHECK(source_action IN ('escalate_immediately','request_immediate_help')),
  reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  reported_at TEXT NOT NULL CHECK(julianday(reported_at) IS NOT NULL),
  source_at TEXT NOT NULL CHECK(julianday(source_at) IS NOT NULL AND julianday(source_at)>=julianday(reported_at)),
  status TEXT NOT NULL CHECK(status IN ('PENDING_REVIEW','ACKNOWLEDGED','IN_PROGRESS','RESOLVED')),
  version INTEGER NOT NULL CHECK(version>=1),
  acknowledged_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL AND julianday(created_at)>=julianday(source_at)),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND julianday(updated_at)>=julianday(created_at)),
  request_origin TEXT CHECK(request_origin IS NULL OR request_origin='patient_status_page'),
  requested_by TEXT REFERENCES accounts(id),
  CHECK((status='PENDING_REVIEW' AND acknowledged_at IS NULL AND resolved_at IS NULL)
    OR (status IN ('ACKNOWLEDGED','IN_PROGRESS') AND acknowledged_at IS NOT NULL AND julianday(acknowledged_at) IS NOT NULL AND julianday(acknowledged_at)>=julianday(created_at) AND julianday(acknowledged_at)<=julianday(updated_at) AND resolved_at IS NULL)
    OR (status='RESOLVED' AND acknowledged_at IS NOT NULL AND julianday(acknowledged_at) IS NOT NULL AND resolved_at IS NOT NULL AND julianday(resolved_at) IS NOT NULL AND julianday(resolved_at)>=julianday(acknowledged_at) AND julianday(resolved_at)<=julianday(updated_at))),
  CHECK((source_type='F2' AND source_action='escalate_immediately' AND checkin_id IS NOT NULL AND attempt_id IS NOT NULL
      AND request_origin IS NULL AND requested_by IS NULL)
    OR (source_type='PATIENT_REQUEST' AND source_action='request_immediate_help' AND checkin_id IS NULL AND attempt_id IS NULL
      AND request_origin IS 'patient_status_page' AND requested_by IS NOT NULL AND source_at=reported_at AND length(reason)<=8000))
) STRICT;

INSERT INTO alerts_next(id,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,
  acknowledged_at,resolved_at,created_at,updated_at,request_origin,requested_by)
SELECT id,patient_id,checkin_id,attempt_id,source_type,source_action,reason,reported_at,source_at,status,version,
  acknowledged_at,resolved_at,created_at,updated_at,NULL,NULL
FROM alerts;

CREATE TABLE alert_actions_legacy AS SELECT * FROM alert_actions;

DROP TABLE alert_actions;
DROP TABLE alerts;
ALTER TABLE alerts_next RENAME TO alerts;

CREATE TABLE alert_actions (
  id TEXT PRIMARY KEY NOT NULL,
  alert_id TEXT NOT NULL REFERENCES alerts(id),
  version INTEGER NOT NULL CHECK(version>=1),
  action TEXT NOT NULL CHECK(action IN ('created','acknowledge','follow_up','resolve')),
  from_status TEXT CHECK(from_status IS NULL OR from_status IN ('PENDING_REVIEW','ACKNOWLEDGED','IN_PROGRESS')),
  to_status TEXT NOT NULL CHECK(to_status IN ('PENDING_REVIEW','ACKNOWLEDGED','IN_PROGRESS','RESOLVED')),
  actor_id TEXT REFERENCES accounts(id),
  recorded_at TEXT NOT NULL CHECK(julianday(recorded_at) IS NOT NULL),
  occurred_at TEXT NOT NULL CHECK(julianday(occurred_at) IS NOT NULL AND julianday(occurred_at)<=julianday(recorded_at)),
  action_type TEXT CHECK(action_type IS NULL OR action_type IN ('contact_attempt','evaluation_guidance','homecare_review','other')),
  internal_note TEXT CHECK(internal_note IS NULL OR length(trim(internal_note)) BETWEEN 1 AND 4000),
  patient_summary TEXT CHECK(patient_summary IS NULL OR length(trim(patient_summary)) BETWEEN 1 AND 4000),
  UNIQUE(alert_id,version),
  CHECK((action='created' AND version=1 AND actor_id IS NULL AND from_status IS NULL AND to_status='PENDING_REVIEW' AND internal_note IS NULL AND patient_summary IS NULL AND action_type IS NULL)
    OR (action='acknowledge' AND actor_id IS NOT NULL AND from_status='PENDING_REVIEW' AND to_status='ACKNOWLEDGED' AND action_type IS NULL AND patient_summary IS NULL)
    OR (action='follow_up' AND actor_id IS NOT NULL AND from_status IN ('ACKNOWLEDGED','IN_PROGRESS') AND to_status='IN_PROGRESS' AND action_type IS NOT NULL AND internal_note IS NOT NULL)
    OR (action='resolve' AND actor_id IS NOT NULL AND from_status='IN_PROGRESS' AND to_status='RESOLVED' AND internal_note IS NOT NULL AND action_type IS NULL))
) STRICT;

INSERT INTO alert_actions SELECT * FROM alert_actions_legacy;
DROP TABLE alert_actions_legacy;

CREATE INDEX alerts_patient_order ON alerts(patient_id,created_at DESC,id DESC);
CREATE INDEX alerts_status_order ON alerts(status,created_at DESC,id DESC);
CREATE INDEX alert_actions_order ON alert_actions(alert_id,version DESC);

CREATE TRIGGER alert_trusted_source BEFORE INSERT ON alerts
WHEN (NEW.source_type='F2' AND NOT EXISTS(SELECT 1 FROM checkins c JOIN processing_attempts p ON p.checkin_id=c.id
  WHERE c.id=NEW.checkin_id AND c.patient_id=NEW.patient_id AND p.id=NEW.attempt_id AND p.state='SUCCEEDED'
    AND json_extract(p.output_json,'$.action')=NEW.source_action AND json_extract(p.output_json,'$.reason')=NEW.reason
    AND json_type(p.output_json,'$.reason')='text' AND (SELECT COUNT(*) FROM json_each(p.output_json))=2
    AND c.created_at=NEW.reported_at AND p.updated_at=NEW.source_at))
  OR (NEW.source_type='PATIENT_REQUEST' AND NOT EXISTS(SELECT 1 FROM accounts a JOIN patient_account_links l ON l.account_id=a.id
    WHERE a.id=NEW.requested_by AND a.active=1 AND a.role='patient' AND l.patient_id=NEW.patient_id))
  OR NEW.status!='PENDING_REVIEW' OR NEW.version!=1
BEGIN SELECT RAISE(ABORT,'alert_requires_trusted_acute_source'); END;

CREATE TRIGGER alert_source_immutable BEFORE UPDATE ON alerts
WHEN NEW.id IS NOT OLD.id OR NEW.patient_id IS NOT OLD.patient_id OR NEW.checkin_id IS NOT OLD.checkin_id OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.source_type IS NOT OLD.source_type OR NEW.source_action IS NOT OLD.source_action OR NEW.reason IS NOT OLD.reason
  OR NEW.reported_at IS NOT OLD.reported_at OR NEW.source_at IS NOT OLD.source_at OR NEW.created_at IS NOT OLD.created_at
  OR NEW.request_origin IS NOT OLD.request_origin OR NEW.requested_by IS NOT OLD.requested_by
  OR NEW.version!=OLD.version+1 OR julianday(NEW.updated_at)<julianday(OLD.updated_at)
  OR NOT ((OLD.status='PENDING_REVIEW' AND NEW.status='ACKNOWLEDGED')
    OR (OLD.status='ACKNOWLEDGED' AND NEW.status='IN_PROGRESS')
    OR (OLD.status='IN_PROGRESS' AND NEW.status IN ('IN_PROGRESS','RESOLVED')))
  OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS NOT OLD.acknowledged_at)
BEGIN SELECT RAISE(ABORT,'alert_source_or_transition_immutable'); END;

CREATE TRIGGER alert_no_delete BEFORE DELETE ON alerts BEGIN SELECT RAISE(ABORT,'alert_history_required'); END;

CREATE TRIGGER alert_action_current BEFORE INSERT ON alert_actions
WHEN NOT EXISTS(SELECT 1 FROM alerts a WHERE a.id=NEW.alert_id AND a.version=NEW.version AND a.status=NEW.to_status
  AND julianday(NEW.occurred_at)>=julianday(a.source_at))
BEGIN SELECT RAISE(ABORT,'alert_action_requires_current_version'); END;

CREATE TRIGGER alert_action_no_update BEFORE UPDATE ON alert_actions BEGIN SELECT RAISE(ABORT,'alert_action_immutable'); END;
CREATE TRIGGER alert_action_no_delete BEFORE DELETE ON alert_actions BEGIN SELECT RAISE(ABORT,'alert_action_immutable'); END;
