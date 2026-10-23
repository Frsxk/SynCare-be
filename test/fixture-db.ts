/** Builds a synthetic review DB with the authoritative schema and observed plan_json shapes. */
/** All data is synthetic; no real patient information. */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Patient 1 (chf-high): top-level patient_id; this is the row in approved_plans. */
/** The approve handler does not rewrite status, so it stays 'DRAFT pending human approval'. */
const planJsonChfHigh = {
  plan_text:
    "Draf tindak lanjut. Diagnosis tercatat: gagal jantung NYHA III. " +
    "Daftar obat dari ringkasan pulang: furosemide 40mg 2x1; bisoprolol 2.5mg 1x1; " +
    "ramipril 5mg 1x1. Telepon perawat dalam 24 jam. Check-in setiap hari. " +
    "Ini rencana demo sintetis yang menunggu persetujuan manusia, bukan panduan klinis.",
  satuseshat: {
    careplan: {
      title: "Draf tindak lanjut sintetis",
      intent: "plan",
      activity: ["Telepon perawat dalam 24 jam.", "Check-in setiap hari."],
    },
    servicerequest: {
      patientInstruction:
        "Tindak lanjut rutin pada 2026-10-11; kontak rutin HOTLINE-DEMO-SINTETIS. " +
        "Menunggu persetujuan manusia.",
      priority: "urgent",
    },
    task: [
      { code: "nurse-call-within-24h", status: "requested", priority: "urgent" },
      { code: "daily-checkin", status: "requested", priority: "urgent" },
    ],
  },
  patient_id: "chf-high",
  tier: "HIGH",
  care_intensity: ["Telepon perawat dalam 24 jam.", "Check-in setiap hari."],
  status: "DRAFT pending human approval",
  label: "demo-heuristic-v1",
  missing_facts: [],
  disclaimer:
    "Synthetic demo only; not clinically validated. FHIR-shaped resources are not a " +
    "SATUSEHAT submission. No diagnosis, medication changes, or emergency advice. " +
    "Pending human clinical approval.",
};

/** Patient 2 (chf-medium): nested patient.id shape; appears only in audit_log. */
const auditPayloadChfMedium = {
  action: "request_changes",
  patient: { id: "chf-medium" },
  tier: "MEDIUM",
  reviewer_note: "Mohon perjelas jadwal telepon perawat untuk pasien medium.",
  status: "DRAFT pending human approval",
};

/** Escalation payload using satuseshat.subject.reference (FHIR "Patient/<id>"). */
const escalatePayload = {
  action: "escalate_to_clinician",
  plan_json: {
    plan_text: "Draf tindak lanjut sintetis untuk eskalasi.",
    satuseshat: {
      careplan: { title: "Draf tindak lanjut sintetis", intent: "plan", activity: [] },
      subject: { reference: "Patient/chf-high" },
    },
    tier: "HIGH",
    status: "DRAFT pending human approval",
  },
};

/** Fallback payload with no patient identity; exercises the null case. */
const fallbackPayload = {
  action: "escalate_to_clinician",
  reason: "Human input timeout (300s); auto-escalated per fallback policy.",
};

export interface FixtureDb {
  /** Absolute path to the temp SQLite file. */
  path: string;
  /** Temp directory containing the file (cleaned up on `cleanup()`). */
  dir: string;
  /** Remove the temp directory and DB file. Safe to call once. */
  cleanup: () => void;
}

/** Create a synthetic review DB in a temp directory. */
export function createFixtureDb(): FixtureDb {
  const dir = mkdtempSync(join(tmpdir(), "syncare-review-fixture-"));
  const path = join(dir, "fixture-review.sqlite3");

  // Open read-write to populate (the reader will open it read-only).
  const db = new Database(path);
  db.run(`
    CREATE TABLE approved_plans(
      plan_json TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      reviewer_note TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE audit_log(
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL
    )
  `);

  // One approved plan; status deliberately remains 'DRAFT pending human approval'.
  db.run(
    "INSERT INTO approved_plans (plan_json, approved_at, reviewer_note) VALUES (?, ?, ?)",
    [
      JSON.stringify(planJsonChfHigh),
      "2026-10-05T08:21:37.002846+00:00",
      "Demo sintetis ditinjau dan disetujui; fakta klinis tidak diubah.",
    ],
  );

  // Four audit rows covering all action types, oldest first.
  // Timestamps are ISO-8601 UTC so lexicographic sort = chronological.
  db.run(
    "INSERT INTO audit_log (action, actor, timestamp, payload) VALUES (?, ?, ?, ?)",
    [
      "approve",
      "demo-reviewer",
      "2026-10-05T08:21:37.002846+00:00",
      JSON.stringify({
        action: "approved",
        patient_id: "chf-high",
        approved_at: "2026-10-05T08:21:37.002846+00:00",
        reviewer_note: "Demo sintetis ditinjau dan disetujui; fakta klinis tidak diubah.",
      }),
    ],
  );
  db.run(
    "INSERT INTO audit_log (action, actor, timestamp, payload) VALUES (?, ?, ?, ?)",
    [
      "request_changes",
      "demo-reviewer",
      "2026-10-05T08:35:12.000000+00:00",
      JSON.stringify(auditPayloadChfMedium),
    ],
  );
  db.run(
    "INSERT INTO audit_log (action, actor, timestamp, payload) VALUES (?, ?, ?, ?)",
    [
      "escalate",
      "demo-reviewer",
      "2026-10-05T08:40:55.000000+00:00",
      JSON.stringify(escalatePayload),
    ],
  );
  db.run(
    "INSERT INTO audit_log (action, actor, timestamp, payload) VALUES (?, ?, ?, ?)",
    [
      "fallback",
      "system",
      "2026-10-05T08:46:01.000000+00:00",
      JSON.stringify(fallbackPayload),
    ],
  );

  db.close();

  return {
    path,
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors in tests.
      }
    },
  };
}
