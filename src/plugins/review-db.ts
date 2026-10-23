/** Read-only review-DB reader: Langflow owns clinical logic, this module only reads its state. */
/** Schema has no patient_id column; identity lives inside plan_json and audit payload JSON. */
import { Database } from "bun:sqlite";

export interface ApprovedPlanRow {
  plan_json: string;
  approved_at: string;
  reviewer_note: string;
}

export interface AuditLogRow {
  action: string;
  actor: string;
  timestamp: string;
  payload: string;
}

/** Parsed plan plus derived approval state. */
export interface ApprovedPlanView {
  plan_json: string;
  approved_at: string;
  reviewer_note: string;
  /** Parsed plan_json; null when the stored JSON is malformed. */
  plan: unknown;
  /** True because this row exists in approved_plans, regardless of plan_json.status. */
  isApproved: boolean;
  /** Patient identity extracted from plan_json, or null when absent. */
  patientId: string | null;
}

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

/** Extract a patient id from patient_id, patient.id, or satuseshat.subject.reference. */
// Never throws; non-object input and unexpected types yield null.
export function patientIdOf(planJson: unknown): string | null {
  if (typeof planJson !== "object" || planJson === null || Array.isArray(planJson)) {
    return null;
  }

  const obj = planJson as Record<string, unknown>;

  const pid = obj["patient_id"];
  if (typeof pid === "string" && pid.length > 0) {
    return pid;
  }

  const patient = obj["patient"];
  if (typeof patient === "object" && patient !== null && !Array.isArray(patient)) {
    const p = patient as Record<string, unknown>;
    const id = p["id"];
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }

  const satuseshat = obj["satuseshat"];
  if (typeof satuseshat === "object" && satuseshat !== null && !Array.isArray(satuseshat)) {
    const ss = satuseshat as Record<string, unknown>;
    const subject = ss["subject"];
    if (typeof subject === "object" && subject !== null && !Array.isArray(subject)) {
      const s = subject as Record<string, unknown>;
      const ref = s["reference"];
      if (typeof ref === "string" && ref.length > 0) {
        // FHIR references use "Patient/<id>".
        const slash = ref.indexOf("/");
        return slash >= 0 ? ref.slice(slash + 1) : ref;
      }
    }
  }

  // Audit payloads may wrap the plan under plan_json; recurse into it.
  const inner = obj["plan_json"];
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
    return patientIdOf(inner);
  }

  return null;
}

/** Opens the review DB read-only; writes throw at the SQLite level. */
export class ReviewDbReader {
  private readonly db: Database;
  private closed = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { readonly: true });
  }

  /** Close the underlying database connection. Safe to call once. */
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  /** All approved plans, newest-first by ISO-8601 approved_at. */
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
        // Approval comes from table membership; plan_json.status stays DRAFT even after approval.
        isApproved: true,
        patientId: patientIdOf(plan),
      };
    });
  }

  /** All audit rows, newest-first by ISO-8601 timestamp. */
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
