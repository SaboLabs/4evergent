import { DatabaseSync } from "node:sqlite";
import type {
  ActivityRecord,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
} from "@4evergent/shared";
import type {
  ActivityStore,
  ApprovalStore,
  ApprovalRecord,
  ApprovalStatus,
} from "./index.js";

/**
 * SQLiteActivityStore — persistent ActivityStore backed by SQLite.
 *
 * Uses Node.js built-in node:sqlite (Node 22+, stable in Node 26). No external
 * database server required. Data persists across process restarts in a file
 * at the path provided to the constructor.
 *
 * Schema is versioned in _meta (schema_version = 1). initSchema() is
 * idempotent and safe to call on every construction.
 */
export class SQLiteActivityStore implements ActivityStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        policy_decision_json TEXT NOT NULL,
        authorization_status TEXT,
        simulation_result_json TEXT,
        tx_hash TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_agent ON activities(agent_id);
      CREATE INDEX IF NOT EXISTS idx_activities_status ON activities(status);
    `);
  }

  async record(record: ActivityRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO activities
         (id, agent_id, intent_json, policy_decision_json, authorization_status,
          simulation_result_json, tx_hash, status, error, created_at, updated_at)
         VALUES (@id, @agent_id, @intent_json, @policy_decision_json, @authorization_status,
                 @simulation_result_json, @tx_hash, @status, @error, @created_at, @updated_at)`
      )
      .run({
        id: record.id,
        agent_id: record.agentId,
        intent_json: JSON.stringify(record.intent),
        policy_decision_json: JSON.stringify(record.policyDecision),
        authorization_status: record.authorizationStatus,
        simulation_result_json: record.simulationResult
          ? JSON.stringify(record.simulationResult)
          : null,
        tx_hash: record.txHash,
        status: record.status,
        error: record.error,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
  }

  async get(id: string): Promise<ActivityRecord | null> {
    const row = this.db.prepare("SELECT * FROM activities WHERE id = ?").get(id);
    if (!row) return null;
    return rowToActivityRecord(row as unknown as ActivityRow);
  }

  async listByAgent(agentId: string, limit = 50): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit);
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listByStatus(agentId: string, status: string, limit = 50): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM activities WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(agentId, status, limit);
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async listAll(limit = 50): Promise<ActivityRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM activities ORDER BY created_at DESC LIMIT ?")
      .all(limit);
    return rows.map((r) => rowToActivityRecord(r as unknown as ActivityRow));
  }

  async update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.record(updated);
    return updated;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * SQLiteApprovalStore — persistent ApprovalStore backed by SQLite.
 *
 * Shares the same DB file as SQLiteActivityStore. The partial unique index
 * idx_approvals_activity_one enforces that at most one PENDING_APPROVAL record
 * exists per activity id. This is the structural guard against duplicate pending
 * approvals for the same intent.
 *
 * record() performs an explicit pre-check for an existing pending approval
 * before inserting, so callers get a clear error (not a raw SQL exception).
 * SQLite's unique index is the final safety net.
 */
export class SQLiteApprovalStore implements ApprovalStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        policy_decision_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        expired_at TEXT,
        approver TEXT,
        expires_at TEXT,
        tx_hash TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id);
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
      CREATE INDEX IF NOT EXISTS idx_approvals_activity ON approvals(activity_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_activity_one
        ON approvals(activity_id) WHERE status = 'pending_approval';
    `);
  }

  async record(record: ApprovalRecord): Promise<void> {
    // Invariant: at most one PENDING_APPROVAL per activity id.
    // SQLite's partial unique index (idx_approvals_activity_one) is the final
    // structural guard; this pre-check gives callers a clear error and keeps
    // existing records from being silently replaced.
    if (record.status === "pending_approval") {
      const existing = this.db
        .prepare(
          "SELECT id FROM approvals WHERE activity_id = ? AND status = 'pending_approval' AND id != ?"
        )
        .get(record.activityId, record.id) as { id: string } | undefined;
      if (existing) {
        throw new Error(
          `ApprovalStore: activity ${record.activityId} already has a pending approval (${existing.id}); refusing to create a second one`
        );
      }
    }

    this.db
      .prepare(
        `INSERT INTO approvals
         (id, activity_id, agent_id, intent_json, policy_decision_json, status,
          requested_at, approved_at, rejected_at, expired_at, approver, expires_at,
          tx_hash, error, created_at, updated_at)
         VALUES (@id, @activity_id, @agent_id, @intent_json, @policy_decision_json, @status,
                 @requested_at, @approved_at, @rejected_at, @expired_at, @approver, @expires_at,
                 @tx_hash, @error, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           activity_id = excluded.activity_id,
           agent_id = excluded.agent_id,
           intent_json = excluded.intent_json,
           policy_decision_json = excluded.policy_decision_json,
           status = excluded.status,
           requested_at = excluded.requested_at,
           approved_at = excluded.approved_at,
           rejected_at = excluded.rejected_at,
           expired_at = excluded.expired_at,
           approver = excluded.approver,
           expires_at = excluded.expires_at,
           tx_hash = excluded.tx_hash,
           error = excluded.error,
           updated_at = excluded.updated_at`
      )
      .run({
        id: record.id,
        activity_id: record.activityId,
        agent_id: record.agentId,
        intent_json: JSON.stringify(record.intent),
        policy_decision_json: JSON.stringify(record.policyDecision),
        status: record.status,
        requested_at: record.requestedAt,
        approved_at: record.approvedAt,
        rejected_at: record.rejectedAt,
        expired_at: record.expiredAt,
        approver: record.approver,
        expires_at: record.expiresAt,
        tx_hash: record.txHash,
        error: record.error,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    if (!row) return null;
    return rowToApprovalRecord(row as unknown as ApprovalRow);
  }

  async listByAgent(agentId: string, limit = 50): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(agentId, limit);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listByStatus(agentId: string, status: string, limit = 50): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE agent_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(agentId, status, limit);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async listAll(limit = 50): Promise<ApprovalRecord[]> {
    const rows = this.db
      .prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?")
      .all(limit);
    return rows.map((r) => rowToApprovalRecord(r as unknown as ApprovalRow));
  }

  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    await this.record(updated);
    return updated;
  }

  close(): void {
    this.db.close();
  }
}

interface ActivityRow {
  id: string;
  agent_id: string;
  intent_json: string;
  policy_decision_json: string;
  authorization_status: string | null;
  simulation_result_json: string | null;
  tx_hash: string | null;
  status: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface ApprovalRow {
  id: string;
  activity_id: string;
  agent_id: string;
  intent_json: string;
  policy_decision_json: string;
  status: string;
  requested_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  expired_at: string | null;
  approver: string | null;
  expires_at: string | null;
  tx_hash: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    intent: JSON.parse(row.intent_json) as AgentIntent,
    policyDecision: JSON.parse(row.policy_decision_json) as PolicyDecision,
    authorizationStatus: (row.authorization_status as AuthorizationStatus | null) ?? null,
    simulationResult: row.simulation_result_json
      ? (JSON.parse(row.simulation_result_json) as SimulationResult)
      : null,
    txHash: row.tx_hash,
    status: row.status as ActivityRecord["status"],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApprovalRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    activityId: row.activity_id,
    agentId: row.agent_id,
    intent: JSON.parse(row.intent_json) as AgentIntent,
    policyDecision: JSON.parse(row.policy_decision_json) as PolicyDecision,
    status: row.status as ApprovalStatus,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    expiredAt: row.expired_at,
    approver: row.approver,
    expiresAt: row.expires_at,
    txHash: row.tx_hash,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
