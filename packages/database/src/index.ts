import type {
  ActivityRecord,
  AgentIntent,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
} from "@4evergent/shared";

/**
 * ActivityStore — persistence interface for the transaction activity log.
 *
 * The store is keyed by activity id and records the FULL decision trail for
 * every intent the pipeline touches, including the ones it rejects. It NEVER
 * stores private keys, seeds, or mnemonics — the ActivityRecord type has no
 * field for secret material, by construction.
 */
export interface ActivityStore {
  record(record: ActivityRecord): Promise<void>;
  get(id: string): Promise<ActivityRecord | null>;
  listByAgent(agentId: string, limit?: number): Promise<ActivityRecord[]>;
  listByStatus(agentId: string, status: string, limit?: number): Promise<ActivityRecord[]>;
  listAll(limit?: number): Promise<ActivityRecord[]>;
  update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null>;
}

/**
 * ApprovalStore — persistence interface for transaction approval records.
 *
 * An ApprovalRecord tracks the lifecycle of a transaction that requires
 * human/authoritative approval before it can be signed and submitted.
 *
 * State machine:
 *   PENDING_APPROVAL → APPROVED → EXECUTING → SUBMITTED/CONFIRMED/FAILED
 *   PENDING_APPROVAL → REJECTED
 *   PENDING_APPROVAL → EXPIRED
 *
 * Approval records NEVER store private keys, transaction blobs, or XDR.
 */
export interface ApprovalStore {
  record(record: ApprovalRecord): Promise<void>;
  get(id: string): Promise<ApprovalRecord | null>;
  listByAgent(agentId: string, limit?: number): Promise<ApprovalRecord[]>;
  listByStatus(agentId: string, status: string, limit?: number): Promise<ApprovalRecord[]>;
  listAll(limit?: number): Promise<ApprovalRecord[]>;
  update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null>;
}

export type ApprovalStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "executing"
  | "submitted"
  | "confirmed"
  | "failed";

export interface ApprovalRecord {
  id: string;
  activityId: string;
  agentId: string;
  intent: AgentIntent;
  policyDecision: PolicyDecision;
  status: ApprovalStatus;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  expiredAt: string | null;
  approver: string | null;
  expiresAt: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * InMemoryActivityStore — process-local activity log.
 *
 * LIMITATION: not durable. Records are lost when the process exits. This is
 * acceptable for MVP/development; the interface is what production code
 * depends on, so a Postgres-backed implementation can replace it without
 * touching the pipeline.
 */
export class InMemoryActivityStore implements ActivityStore {
  private records = new Map<string, ActivityRecord>();

  async record(record: ActivityRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ActivityRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByAgent(agentId: string, limit = 50): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listByStatus(agentId: string, status: string, limit = 50): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listAll(limit = 50): Promise<ActivityRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async update(id: string, patch: Partial<ActivityRecord>): Promise<ActivityRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }
}

/**
 * InMemoryApprovalStore — process-local approval log.
 *
 * LIMITATION: not durable. Records are lost when the process exits.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private records = new Map<string, ApprovalRecord>();

  async record(record: ApprovalRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return this.records.get(id) ?? null;
  }

  async listByAgent(agentId: string, limit = 50): Promise<ApprovalRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listByStatus(agentId: string, status: string, limit = 50): Promise<ApprovalRecord[]> {
    return [...this.records.values()]
      .filter((r) => r.agentId === agentId && r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listAll(limit = 50): Promise<ApprovalRecord[]> {
    return [...this.records.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async update(id: string, patch: Partial<ApprovalRecord>): Promise<ApprovalRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.records.set(id, updated);
    return updated;
  }
}

/**
 * Security assertion — call from the API layer before persisting any record.
 * Fails loudly if secret material ever enters a record, so it can never be
 * persisted silently.
 */
export function assertNoSecrets(record: ActivityRecord | ApprovalRecord): void {
  const blob = JSON.stringify(record).toLowerCase();
  const forbidden = ["secret", "seed", "private_key", "mnemonic", "keypair"];
  for (const term of forbidden) {
    if (blob.includes(term.toLowerCase())) {
      throw new Error(
        `Store: refusing to persist record — contains forbidden key material marker '${term}'`
      );
    }
  }
}

/**
 * Creates a new ActivityRecord in its initial pending state.
 */
export function createActivity(
  agentId: string,
  intent: AgentIntent,
  policyDecision: PolicyDecision
): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId,
    intent,
    policyDecision,
    authorizationStatus: null,
    simulationResult: null,
    txHash: null,
    status: "pending",
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Creates a new ApprovalRecord in PENDING_APPROVAL state.
 */
export function createApproval(
  activityId: string,
  agentId: string,
  intent: AgentIntent,
  policyDecision: PolicyDecision,
  expiresAt?: string | null
): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    activityId,
    agentId,
    intent,
    policyDecision,
    status: "pending_approval",
    requestedAt: now,
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    approver: null,
    expiresAt: expiresAt ?? null,
    txHash: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateActivity(
  record: ActivityRecord,
  patch: Partial<ActivityRecord>
): ActivityRecord {
  return { ...record, ...patch, updatedAt: new Date().toISOString() };
}

export function updateApproval(
  record: ApprovalRecord,
  patch: Partial<ApprovalRecord>
): ApprovalRecord {
  return { ...record, ...patch, updatedAt: new Date().toISOString() };
}

/**
 * Validates state transitions for approval records.
 * Returns null if valid, error message if invalid.
 */
export function validateApprovalTransition(
  current: ApprovalStatus,
  next: ApprovalStatus
): string | null {
  const allowed: Record<ApprovalStatus, ApprovalStatus[]> = {
    pending_approval: ["approved", "rejected", "expired", "executing"],
    approved: ["executing", "submitted", "failed"],
    rejected: [],
    expired: [],
    executing: ["submitted", "confirmed", "failed"],
    submitted: ["confirmed", "failed"],
    confirmed: [],
    failed: [],
  };
  if (!allowed[current].includes(next)) {
    return `Invalid transition: ${current} -> ${next}`;
  }
  return null;
}

export type { ActivityRecord, AgentIntent, AuthorizationStatus, PolicyDecision, SimulationResult };

// SQLite-backed persistent stores
export { SQLiteActivityStore, SQLiteApprovalStore } from "./sqlite-store.js";
