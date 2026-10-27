CREATE TABLE homecare_services (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 2000),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL)
) STRICT;

CREATE TABLE homecare_staff (
  account_id TEXT PRIMARY KEY NOT NULL REFERENCES accounts(id),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 200),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1)
) STRICT;
CREATE TRIGGER homecare_staff_nurse BEFORE INSERT ON homecare_staff
WHEN (SELECT role FROM accounts WHERE id=NEW.account_id) != 'nurse'
BEGIN SELECT RAISE(ABORT,'nurse_account_required'); END;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  service_id TEXT NOT NULL REFERENCES homecare_services(id),
  service_snapshot_json TEXT NOT NULL CHECK(json_valid(service_snapshot_json) AND json_type(service_snapshot_json)='object'),
  address_json TEXT NOT NULL CHECK(json_valid(address_json) AND json_type(address_json)='object'),
  visit_note TEXT NOT NULL CHECK(length(visit_note)<=2000),
  preferred_start_at TEXT NOT NULL CHECK(julianday(preferred_start_at) IS NOT NULL),
  preferred_end_at TEXT NOT NULL CHECK(julianday(preferred_end_at) IS NOT NULL AND julianday(preferred_end_at)>julianday(preferred_start_at)),
  preferred_timezone TEXT NOT NULL CHECK(preferred_timezone='Asia/Jakarta'),
  status TEXT NOT NULL CHECK(status IN ('Requested','Under Review','Scheduled','Completed','Cancelled','Rejected')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  assigned_staff_id TEXT REFERENCES homecare_staff(account_id),
  confirmed_start_at TEXT,
  confirmed_end_at TEXT,
  confirmed_timezone TEXT,
  completed_at TEXT,
  completion_note TEXT,
  created_by TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL CHECK(julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK(julianday(updated_at) IS NOT NULL AND julianday(updated_at)>=julianday(created_at)),
  CHECK((assigned_staff_id IS NULL AND confirmed_start_at IS NULL AND confirmed_end_at IS NULL AND confirmed_timezone IS NULL)
    OR (assigned_staff_id IS NOT NULL AND confirmed_start_at IS NOT NULL AND confirmed_end_at IS NOT NULL
      AND julianday(confirmed_start_at) IS NOT NULL AND julianday(confirmed_end_at) IS NOT NULL AND julianday(confirmed_end_at)>julianday(confirmed_start_at)
      AND confirmed_timezone IS NOT NULL AND confirmed_timezone='Asia/Jakarta')),
  CHECK(status NOT IN ('Requested','Under Review','Rejected') OR assigned_staff_id IS NULL),
  CHECK(status NOT IN ('Scheduled','Completed') OR assigned_staff_id IS NOT NULL),
  CHECK((status='Completed' AND completed_at IS NOT NULL AND julianday(completed_at) IS NOT NULL
    AND completion_note IS NOT NULL AND length(trim(completion_note)) BETWEEN 1 AND 2000)
    OR (status!='Completed' AND completed_at IS NULL AND completion_note IS NULL))
) STRICT;
CREATE INDEX bookings_patient_created ON bookings(patient_id,created_at DESC,id DESC);
CREATE INDEX bookings_staff_slot ON bookings(assigned_staff_id,confirmed_start_at,confirmed_end_at) WHERE status='Scheduled';
CREATE TRIGGER bookings_snapshot_immutable BEFORE UPDATE ON bookings
WHEN NEW.patient_id!=OLD.patient_id OR NEW.service_id!=OLD.service_id OR NEW.service_snapshot_json!=OLD.service_snapshot_json
  OR NEW.address_json!=OLD.address_json OR NEW.visit_note!=OLD.visit_note
  OR NEW.preferred_start_at!=OLD.preferred_start_at OR NEW.preferred_end_at!=OLD.preferred_end_at
  OR NEW.preferred_timezone!=OLD.preferred_timezone OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT,'booking_snapshot_immutable'); END;
CREATE TRIGGER bookings_no_delete BEFORE DELETE ON bookings BEGIN SELECT RAISE(ABORT,'booking_history_immutable'); END;

CREATE TABLE booking_history (
  id TEXT PRIMARY KEY NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  version INTEGER NOT NULL CHECK(version>=1),
  from_status TEXT CHECK(from_status IS NULL OR from_status IN ('Requested','Under Review','Scheduled','Completed','Cancelled','Rejected')),
  to_status TEXT NOT NULL CHECK(to_status IN ('Requested','Under Review','Scheduled','Completed','Cancelled','Rejected')),
  actor_id TEXT NOT NULL REFERENCES accounts(id),
  occurred_at TEXT NOT NULL CHECK(julianday(occurred_at) IS NOT NULL),
  reason TEXT,
  internal_note TEXT,
  UNIQUE(booking_id,version)
) STRICT;
CREATE INDEX booking_history_order ON booking_history(booking_id,version);
CREATE TRIGGER booking_history_no_update BEFORE UPDATE ON booking_history BEGIN SELECT RAISE(ABORT,'booking_history_immutable'); END;
CREATE TRIGGER booking_history_no_delete BEFORE DELETE ON booking_history BEGIN SELECT RAISE(ABORT,'booking_history_immutable'); END;
