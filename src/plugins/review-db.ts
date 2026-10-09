/**
 * Read-only SQLite review-DB reader for the SynCare console.
 *
 * ARCHITECTURAL RULE: Langflow owns ALL clinical logic (risk scoring, tiering,
 * red-flag escalation, plan drafting, human approval, RAG). This module is a
 * THIN READ-ONLY PROXY — it only reads and presents what the flows wrote.
 * It must never re-implement or recompute any clinical decision.
 *
 * Authoritative schema (verified from upstream SynCare repo, README L291):
 *   approved_plans(plan_json TEXT NOT NULL, approved_at TEXT NOT NULL, reviewer_note TEXT NOT NULL)
 *   audit_log(action TEXT NOT NULL, actor TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL)
 *
 * There is NO patient_id column. Patient identity lives inside the plan_json /
 * audit-payload JSON. See {@link patientIdOf} for tolerant extraction.
 */
import { Database } from "bun:sqlite";

// ─── Types ────────────────────────────────────────────────────────────────

/** Raw row from the approved_plans table (all columns are TEXT). */
export interface ApprovedPlanRow {
  plan_json: string;
  approved_at: string;
  reviewer_note: string;
}

/** Raw row from the audit_log table (all columns are TEXT). */
export interface AuditLogRow {
  action: string;
  actor: string;
  timestamp: string;
  payload: string;
}

/**
 * Enriched approved-plan view: the raw row plus parsed plan_json and the
 * derived approval state.
 *
 * `isApproved` is derived from TABLE MEMBERSHIP, never from `plan_json.status`.
 * The upstream flows deliberately keep `plan_json.status === 'DRAFT pending
 * human approval'` even AFTER approval (upstream README L304) — the approve
 * handler persists the plan verbatim and does not rewrite its status field.
 * So approval state = "does a row exist in approved_plans?".
 */
export interface ApprovedPlanView {
  plan_json: string;
  approved_at: string;
  reviewer_note: string;
  /** Parsed plan_json; null when the stored JSON is malformed. */
  plan: unknown;
  /** True because this row exists in approved_plans — regardless of plan_json.status. */
  isApproved: boolean;
  /** Patient identity extracted from plan_json, or null when absent. */
  patientId: string | null;
}

/** Enriched audit-log view: the raw row plus parsed payload. */
export interface AuditLogView {
  action: string;
  actor: string;
  timestamp: string;
  payload: string;
  /** Parsed payload JSON; null when malformed. */
  data: unknown;
  /** Patient identity extracted from payload, or null when absent. */
  patientId: string | null;
}

// ─── Pure helpers (no DB dependency — unit-testable in isolation) ──────────

/**
 * Tolerantly extract a patient identifier from a plan_json object (or any JSON
 * value). Handles four shapes observed in the upstream SynCare flows:
 *
 * 1. Top-level `patient_id`               — F3/F4 draft plan JSON
 * 2. Nested `patient.id`                  — alternate FHIR-ish layout
 * 3. `satuseshat.subject.reference`       — FHIR Subject reference ("Patient/chf-high")
 * 4. Absent                               — returns null
 *
 * Never throws: non-object input, missing keys, or unexpected types all
 * yield null.
 */
export function patientIdOf(planJson: unknown): string | null {
  if (typeof planJson !== "object" || planJson === null || Array.isArray(planJson)) {
    return null;
  }

  const obj = planJson as Record<string, unknown>;

  // 1. Top-level patient_id (string only — the flows write string IDs).
  const pid = obj["patient_id"];
  if (typeof pid === "string" && pid.length > 0) {
    return pid;
  }

  // 2. Nested patient.id
  const patient = obj["patient"];
  if (typeof patient === "object" && patient !== null && !Array.isArray(patient)) {
    const p = patient as Record<string, unknown>;
    const id = p["id"];
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }

  // 3. satuseshat.subject.reference — FHIR-shaped: "Patient/<id>"
  const satuseshat = obj["satuseshat"];
  if (typeof satuseshat === "object" && satuseshat !== null && !Array.isArray(satuseshat)) {
    const ss = satuseshat as Record<string, unknown>;
    const subject = ss["subject"];
    if (typeof subject === "object" && subject !== null && !Array.isArray(subject)) {
      const s = subject as Record<string, unknown>;
      const ref = s["reference"];
      if (typeof ref === "string" && ref.length > 0) {
        // Strip "Patient/" prefix if present (FHIR reference convention).
        const slash = ref.indexOf("/");
        return slash >= 0 ? ref.slice(slash + 1) : ref;
      }
    }
  }

  // 4. Fallback: if the object wraps a plan inside a `plan_json` sub-key
  //    (common in audit payloads like escalate_to_clinician), recurse into it.
  const inner = obj["plan_json"];
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return patientIdOf(inner);
  }

  // 5. Absent
  return null;
}

// ─── Reader ───────────────────────────────────────────────────────────────

/**
 * Read-only reader for the SynCare review database.
 *
 * The DB is opened with `readonly: true` via the SQLite URI `?mode=ro`.
 * Any write attempt (INSERT/UPDATE/DELETE) will throw at the SQLite level,
 * enforced by the test suite.
 */
export class ReviewDbReader {
  private readonly db: Database;
  private readonly closed: boolean = false;

  /**
   * @param dbPath Absolute or relative path to the SQLite file.
   *               Opened strictly read-only.
   */
  constructor(dbPath: string) {
    // `readonly: true` opens the SQLite file in read-only mode at the driver
    // level (SQLITE_OPEN_READONLY). Any write attempt (INSERT/UPDATE/DELETE)
    // will throw a SQLiteError, enforced by the test suite.
    this.db = new Database(dbPath, { readonly: true });
  }

  /** Close the underlying database connection. Safe to call once. */
  close(): void {
    if (!this.closed) {
      this.db.close();
      (this as { closed: boolean }).closed = true;
    }
  }

  // ── approved_plans ──────────────────────────────────────────────────────

  /**
   * Return all approved plans, newest-first by `approved_at`.
   *
   * approved_at timestamps are ISO-8601 UTC strings, so lexicographic ORDER BY
   * is correct for chronological ordering.
   */
  approvedPlans(): ApprovedPlanView[] {
    const rows = this.db
      .query<ApprovedPlanRow, []>(
        "SELECT plan_json, approved_at, reviewer_note FROM approved_plans ORDER BY approved_at DESC",
      )
      .all();

    return rows.map((row) => {
      let plan: unknown = null;
      try {
        plan = JSON.parse(row.plan_json);
      } catch {
        plan = null;
      }
      return {
        plan_json: row.plan_json,
        approved_at: row.approved_at,
        reviewer_note: row.reviewer_note,
        plan,
        // Approval state comes from table membership, NOT plan_json.status.
        // The upstream approve handler persists plan_json verbatim; its
        // status string remains 'DRAFT pending human approval' even after
        // approval (upstream README L304).
        isApproved: true,
        patientId: patientIdOf(plan),
      };
    });
  }

  // ── audit_log ───────────────────────────────────────────────────────────

  /**
   * Return all audit-log entries, newest-first by `timestamp`.
   *
   * Timestamps are ISO-8601 UTC strings, so lexicographic ORDER BY DESC
   * is correct for chronological ordering.
   */
  auditLog(): AuditLogView[] {
    const rows = this.db
      .query<AuditLogRow, []>(
        "SELECT action, actor, timestamp, payload FROM audit_log ORDER BY timestamp DESC",
      )
      .all();

    return rows.map((row) => {
      let data: unknown = null;
      try {
        data = JSON.parse(row.payload);
      } catch {
        data = null;
      }
      return {
        action: row.action,
        actor: row.actor,
        timestamp: row.timestamp,
        payload: row.payload,
        data,
        patientId: patientIdOf(data),
      };
    });
  }
}
