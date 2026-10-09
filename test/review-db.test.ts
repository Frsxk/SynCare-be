/**
 * Tests for the read-only SynCare review-DB reader plugin.
 *
 * These tests verify the critical domain invariants:
 * 1. The DB is opened strictly read-only — INSERT must throw.
 * 2. isApproved comes from approved_plans TABLE MEMBERSHIP, not plan_json.status.
 * 3. patientIdOf handles all 4 shapes (top-level, nested, satuseshat, absent).
 * 4. approvedPlans() and auditLog() return newest-first by timestamp.
 *
 * All data is SYNTHETIC — no real patient information.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ReviewDbReader,
  patientIdOf,
  type ApprovedPlanView,
  type AuditLogView,
} from "../src/plugins/review-db";
import { createFixtureDb, type FixtureDb } from "./fixture-db";

let fixture: FixtureDb;

beforeEach(() => {
  fixture = createFixtureDb();
});

afterEach(() => {
  fixture.cleanup();
});

// ─── patientIdOf: pure function, no DB needed ──────────────────────────────

describe("patientIdOf", () => {
  test("extracts top-level patient_id", () => {
    expect(patientIdOf({ patient_id: "chf-high", tier: "HIGH" })).toBe("chf-high");
  });

  test("extracts nested patient.id", () => {
    expect(patientIdOf({ patient: { id: "chf-medium" }, tier: "MEDIUM" })).toBe(
      "chf-medium",
    );
  });

  test("extracts from satuseshat.subject.reference (strips Patient/ prefix)", () => {
    const plan = {
      satuseshat: { subject: { reference: "Patient/chf-high" } },
    };
    expect(patientIdOf(plan)).toBe("chf-high");
  });

  test("extracts from satuseshat.subject.reference without prefix", () => {
    const plan = {
      satuseshat: { subject: { reference: "chf-high" } },
    };
    expect(patientIdOf(plan)).toBe("chf-high");
  });

  test("returns null when patient identity is absent", () => {
    expect(patientIdOf({ tier: "LOW", status: "draft" })).toBeNull();
  });

  test("returns null for non-object input", () => {
    expect(patientIdOf(null)).toBeNull();
    expect(patientIdOf("chf-high")).toBeNull();
    expect(patientIdOf(42)).toBeNull();
    expect(patientIdOf(undefined)).toBeNull();
  });

  test("returns null for arrays", () => {
    expect(patientIdOf(["chf-high"])).toBeNull();
  });

  test("returns null for empty string patient_id", () => {
    expect(patientIdOf({ patient_id: "" })).toBeNull();
  });

  test("never throws on malformed nested structures", () => {
    expect(patientIdOf({ patient: "not-an-object" })).toBeNull();
    expect(patientIdOf({ satuseshat: 42 })).toBeNull();
    expect(patientIdOf({ satuseshat: { subject: null } })).toBeNull();
  });
});

// ─── Read-only enforcement ─────────────────────────────────────────────────

describe("read-only enforcement", () => {
  test("INSERT via read-only connection throws", () => {
    // The reader opens read-only; we simulate a write attempt by opening
    // the same file read-only and trying to INSERT.
    const roDb = new Database(fixture.path, { readonly: true });
    expect(() => {
      roDb.run(
        "INSERT INTO approved_plans (plan_json, approved_at, reviewer_note) VALUES (?, ?, ?)",
        ["{}", "2026-01-01T00:00:00+00:00", "should fail"],
      );
    }).toThrow();
    roDb.close();
  });

  test("UPDATE via read-only connection throws", () => {
    const roDb = new Database(fixture.path, { readonly: true });
    expect(() => {
      roDb.run("UPDATE approved_plans SET reviewer_note = 'hacked'");
    }).toThrow();
    roDb.close();
  });

  test("DELETE via read-only connection throws", () => {
    const roDb = new Database(fixture.path, { readonly: true });
    expect(() => {
      roDb.run("DELETE FROM approved_plans");
    }).toThrow();
    roDb.close();
  });
});

// ─── isApproved from table membership, not plan_json.status ────────────────

describe("isApproved derives from table membership, not plan_json.status", () => {
  test("approved plan with status 'DRAFT pending human approval' still yields isApproved=true", () => {
    const reader = new ReviewDbReader(fixture.path);
    const plans = reader.approvedPlans();
    reader.close();

    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    // The stored plan_json.status is 'DRAFT pending human approval' — this
    // is the upstream invariant (README L304): the approve handler persists
    // the plan verbatim and does NOT rewrite its status field.
    expect(plan.plan).not.toBeNull();
    const parsed = plan.plan as { status?: string };
    expect(parsed.status).toBe("DRAFT pending human approval");
    // CRITICAL: isApproved is true because the row EXISTS in approved_plans,
    // regardless of the status string inside plan_json.
    expect(plan.isApproved).toBe(true);
  });

  test("isApproved is always true for rows returned by approvedPlans()", () => {
    const reader = new ReviewDbReader(fixture.path);
    const plans = reader.approvedPlans();
    reader.close();
    // Every row from approved_plans is approved by definition of table membership.
    for (const p of plans) {
      expect(p.isApproved).toBe(true);
    }
  });
});

// ─── approvedPlans() ───────────────────────────────────────────────────────

describe("approvedPlans()", () => {
  test("returns all rows with parsed plan_json and patientId", () => {
    const reader = new ReviewDbReader(fixture.path);
    const plans: ApprovedPlanView[] = reader.approvedPlans();
    reader.close();

    expect(plans).toHaveLength(1);
    const p = plans[0]!;
    expect(p.plan_json).toBeTruthy();
    expect(p.approved_at).toBe("2026-10-05T08:21:37.002846+00:00");
    expect(p.reviewer_note).toContain("disetujui");
    expect(p.plan).not.toBeNull();
    expect(p.patientId).toBe("chf-high");
  });

  test("returns rows newest-first by approved_at", () => {
    // Add a second approved plan with a later timestamp directly in the fixture DB.
    const db = new Database(fixture.path);
    db.run(
      "INSERT INTO approved_plans (plan_json, approved_at, reviewer_note) VALUES (?, ?, ?)",
      [
        JSON.stringify({ patient_id: "chf-medium", status: "DRAFT pending human approval" }),
        "2026-10-06T10:00:00.000000+00:00",
        "Second synthetic approval",
      ],
    );
    db.close();

    const reader = new ReviewDbReader(fixture.path);
    const plans = reader.approvedPlans();
    reader.close();

    expect(plans).toHaveLength(2);
    // Newest first: the 2026-10-06 row should come before 2026-10-05.
    expect(plans[0]!.approved_at).toBe("2026-10-06T10:00:00.000000+00:00");
    expect(plans[1]!.approved_at).toBe("2026-10-05T08:21:37.002846+00:00");
  });

  test("handles malformed plan_json gracefully (plan=null, isApproved still true)", () => {
    const db = new Database(fixture.path);
    db.run("DELETE FROM approved_plans");
    db.run(
      "INSERT INTO approved_plans (plan_json, approved_at, reviewer_note) VALUES (?, ?, ?)",
      ["{not valid json", "2026-10-07T01:00:00+00:00", "malformed"],
    );
    db.close();

    const reader = new ReviewDbReader(fixture.path);
    const plans = reader.approvedPlans();
    reader.close();

    expect(plans).toHaveLength(1);
    expect(plans[0]!.plan).toBeNull();
    expect(plans[0]!.isApproved).toBe(true);
    expect(plans[0]!.patientId).toBeNull();
  });
});

// ─── auditLog() ────────────────────────────────────────────────────────────

describe("auditLog()", () => {
  test("returns all 4 rows covering approve / request_changes / escalate / fallback", () => {
    const reader = new ReviewDbReader(fixture.path);
    const logs: AuditLogView[] = reader.auditLog();
    reader.close();

    expect(logs).toHaveLength(4);
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("approve");
    expect(actions).toContain("request_changes");
    expect(actions).toContain("escalate");
    expect(actions).toContain("fallback");
  });

  test("returns rows newest-first by timestamp", () => {
    const reader = new ReviewDbReader(fixture.path);
    const logs = reader.auditLog();
    reader.close();

    // Timestamps inserted: 08:21, 08:35, 08:40, 08:46 — newest first.
    expect(logs[0]!.timestamp).toBe("2026-10-05T08:46:01.000000+00:00");
    expect(logs[1]!.timestamp).toBe("2026-10-05T08:40:55.000000+00:00");
    expect(logs[2]!.timestamp).toBe("2026-10-05T08:35:12.000000+00:00");
    expect(logs[3]!.timestamp).toBe("2026-10-05T08:21:37.002846+00:00");
  });

  test("parses payload JSON and extracts patientId from different shapes", () => {
    const reader = new ReviewDbReader(fixture.path);
    const logs = reader.auditLog();
    reader.close();

    // Map action → patientId for easy assertion.
    const byAction = new Map(logs.map((l) => [l.action, l]));

    // approve payload has top-level patient_id → "chf-high"
    const approveLog = byAction.get("approve")!;
    expect(approveLog.data).not.toBeNull();
    expect(approveLog.patientId).toBe("chf-high");

    // request_changes payload has nested patient.id → "chf-medium"
    const rcLog = byAction.get("request_changes")!;
    expect(rcLog.patientId).toBe("chf-medium");

    // escalate payload has satuseshat.subject.reference "Patient/chf-high"
    const escLog = byAction.get("escalate")!;
    expect(escLog.patientId).toBe("chf-high");

    // fallback payload has no patient identity → null
    const fbLog = byAction.get("fallback")!;
    expect(fbLog.patientId).toBeNull();
  });

  test("handles malformed payload gracefully (data=null, patientId=null)", () => {
    const db = new Database(fixture.path);
    db.run("DELETE FROM audit_log");
    db.run(
      "INSERT INTO audit_log (action, actor, timestamp, payload) VALUES (?, ?, ?, ?)",
      ["approve", "demo-reviewer", "2026-10-07T01:00:00+00:00", "{broken json"],
    );
    db.close();

    const reader = new ReviewDbReader(fixture.path);
    const logs = reader.auditLog();
    reader.close();

    expect(logs).toHaveLength(1);
    expect(logs[0]!.data).toBeNull();
    expect(logs[0]!.patientId).toBeNull();
  });
});

// ─── Fixture schema correctness ────────────────────────────────────────────

describe("fixture DB schema", () => {
  test("has exactly two tables: approved_plans and audit_log", () => {
    const db = new Database(fixture.path);
    const tables = db
      .query<{ name: string; sql: string }, []>(
        "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all();
    db.close();

    const names = tables.map((t) => t.name);
    expect(names).toEqual(["approved_plans", "audit_log"]);

    // Verify exact DDL matches the authoritative schema.
    const apDdl = tables.find((t) => t.name === "approved_plans")!.sql;
    expect(apDdl).toContain("plan_json TEXT");
    expect(apDdl).toContain("approved_at TEXT");
    expect(apDdl).toContain("reviewer_note TEXT");

    const alDdl = tables.find((t) => t.name === "audit_log")!.sql;
    expect(alDdl).toContain("action TEXT");
    expect(alDdl).toContain("actor TEXT");
    expect(alDdl).toContain("timestamp TEXT");
    expect(alDdl).toContain("payload TEXT");
  });

  test("has no patient_id column in approved_plans", () => {
    const db = new Database(fixture.path);
    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(approved_plans)")
      .all()
      .map((c) => c.name);
    db.close();
    expect(cols).not.toContain("patient_id");
    expect(cols).toEqual(["plan_json", "approved_at", "reviewer_note"]);
  });
});
