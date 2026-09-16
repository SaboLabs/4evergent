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
}

/**
 * Security assertion — call from the API layer before persisting any record.
 * Fails loudly if secret material ever enters a record, so it can never be
 * persisted silently.
 */
export function assertNoSecrets(record: ActivityRecord): void {
  const blob = JSON.stringify(record).toLowerCase();
  const forbidden = ["secret", "seed", "private_key", "mnemonic", " Keypair"];
  for (const term of forbidden) {
    if (blob.includes(term.toLowerCase())) {
      throw new Error(
        `ActivityStore: refusing to persist record — contains forbidden key material marker '${term}'`
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

export function updateActivity(
  record: ActivityRecord,
  patch: Partial<ActivityRecord>
): ActivityRecord {
  return { ...record, ...patch, updatedAt: new Date().toISOString() };
}

export type { ActivityRecord, AgentIntent, AuthorizationStatus, PolicyDecision, SimulationResult };
