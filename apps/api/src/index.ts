import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type {
  AgentIntent,
  ActivityStatus,
  AuthorizationStatus,
  PolicyDecision,
  SimulationResult,
} from "@4evergent/shared";
import { IntentValidator } from "@4evergent/agent-core";
import { PolicyEngine, DEFAULT_RULES, validatePolicyRules, normalizePolicyRules } from "@4evergent/policy";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "@4evergent/stellar";
import type { Signer } from "@4evergent/stellar";
import { AgentScheduler } from "./scheduler.js";
import { ScheduleExecutionService } from "./schedule-execution.js";
import { ExecutionQueue } from "./execution-queue.js";
import { ExecutionRecoveryService } from "./execution-recovery.js";
import { TransactionStatusReconciler } from "@4evergent/stellar";
import { AccountSequenceCoordinator } from "./account-sequence-coordinator.js";
import type { ExecutionRecord } from "@4evergent/database";
import type { ScheduleExecutionResult } from "./schedule-execution.js";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryScheduleStore,
  InMemoryExecutionStore,
  InMemoryAgentStore,
  InMemoryPolicyConfigStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  SQLiteScheduleStore,
  SQLiteExecutionStore,
  SQLiteAgentStore,
  SQLitePolicyConfigStore,
  assertNoSecrets,
  validateApprovalTransition,
  ResourceAuthorizationService,
  type AuthorizationContext,
  type ActivityStore,
  type ApprovalStore,
  type ScheduleStore,
  type ExecutionStore,
  type AgentStore,
  type ApprovalRecord,
  type ApprovalStatus,
  type ActivityRecord,
  type PolicyConfigStore,
} from "@4evergent/database";
import type { PolicyRules, Agent, RequestContext, AuthorizationService } from "@4evergent/shared";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

interface IntentResponse {
  activityId: string;
  agentId: string;
  status: string;
  policyDecision: PolicyDecision;
  authorizationStatus: AuthorizationStatus;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  error: string | null;
  approvalId?: string;
}

interface ApprovalResponse {
  approvalId: string;
  activityId: string;
  agentId: string;
  status: ApprovalStatus;
  message: string;
}

const agents = new Map<string, Agent>();

export function clearAgents() {
  agents.clear();
}

export interface ServerOptions {
  port: number;
  horizonUrl: string;
  signer: Signer;
  policyRules?: Partial<PolicyRules>;
  activityStore?: ActivityStore;
  approvalStore?: ApprovalStore;
  scheduleStore?: ScheduleStore;
  dbPath?: string;
  deferExecution?: boolean;
  requestContext?: RequestContext;
  authorizationService?: AuthorizationService;
  /** Enable the background scheduler to execute due schedules. */
  scheduler?: {
    enabled?: boolean;
    intervalMs?: number;
    /** Inject a custom scheduler (e.g. for testing). */
    instance?: AgentScheduler;
  };
  /** Execution store — defaults to SQLite if dbPath provided, else in-memory. */
  executionStore?: ExecutionStore;
  /** Agent store — defaults to SQLite if dbPath provided, else in-memory. */
  agentStore?: AgentStore;
  /** Policy configuration store — defaults to SQLite if dbPath provided, else in-memory. */
  policyConfigStore?: import("@4evergent/database").PolicyConfigStore;
  /** Enable the persistent execution queue (opt-in). */
  executionQueue?: {
    enabled?: boolean;
    intervalMs?: number;
    concurrency?: number;
    instance?: ExecutionQueue;
  };
  /** Enable on-chain transaction status reconciliation (opt-in). */
  reconciliation?: {
    enabled?: boolean;
    intervalMs?: number;
    instance?: import("@4evergent/stellar").TransactionStatusReconciler;
  };
}

const DEFAULT_OWNER = "dev-owner";

export async function createApiServer(options: ServerOptions) {
  const store: ActivityStore =
    options.activityStore ??
    (options.dbPath ? new SQLiteActivityStore(options.dbPath) : new InMemoryActivityStore());
  const approvals: ApprovalStore =
    options.approvalStore ??
    (options.dbPath ? new SQLiteApprovalStore(options.dbPath) : new InMemoryApprovalStore());
  const schedules: ScheduleStore =
    options.scheduleStore ??
    (options.dbPath ? new SQLiteScheduleStore(options.dbPath) : new InMemoryScheduleStore());
  const agentStore: AgentStore =
    options.agentStore ??
    (options.dbPath ? new SQLiteAgentStore(options.dbPath) : new InMemoryAgentStore());

  // Phase 28A: Policy configuration store (agent-scoped)
  const policyConfigStore: PolicyConfigStore =
    options.policyConfigStore ??
    (options.dbPath ? new SQLitePolicyConfigStore(options.dbPath) : new InMemoryPolicyConfigStore());

  const defaultAuthzCtx: AuthorizationContext = {
    activityStore: store,
    approvalStore: approvals,
    scheduleStore: schedules,
    agents: agents as Map<string, { id: string; ownerId: string }>,
  };
  const authorizationService: AuthorizationService =
    options.authorizationService ?? new ResourceAuthorizationService(defaultAuthzCtx);

  const requestCtx: RequestContext = options.requestContext ?? { ownerId: DEFAULT_OWNER };

  // Phase 28A: Create policy resolver that loads agent-specific rules
  // Falls back to DEFAULT_RULES if no custom policy exists for the agent
  const getRules = async (agentId: string): Promise<PolicyRules> => {
    const custom = await policyConfigStore.get(agentId);
    // If agent has persisted policy, use it (highest precedence).
    // Otherwise, deep-merge startup options.policyRules over DEFAULT_RULES
    // so nested fields (maxTxAmount, dailySpendingLimit, txTypeRestrictions)
    // are properly combined rather than overwritten.
    return custom ?? normalizePolicyRules(options.policyRules ?? {});
  };

  const pipeline = new TransactionPipeline({
    horizonUrl: options.horizonUrl,
    networkPassphrase: TESTNET_PASSPHRASE,
    signer: options.signer,
    activityStore: store,
    approvalStore: approvals,
    policyRules: options.policyRules,
    policyResolver: getRules,
  });

  // Phase 28J: PolicyEngine in API uses the SAME resolver
  const policy = new PolicyEngine(options.policyRules, store as any, getRules);
  const adapter = new StellarAdapter(options.horizonUrl);

  // --- Account sequence coordinator (Phase 25) ---
  // Serializes sequence-sensitive execution for the SAME Stellar source account.
  // Different accounts remain concurrent.
  const sequenceCoordinator = new AccountSequenceCoordinator();

  // --- Execution queue setup ---
  const executionStore: ExecutionStore =
    options.executionStore ??
    (options.dbPath ? new SQLiteExecutionStore(options.dbPath) : new InMemoryExecutionStore());

  // --- Execution recovery setup ---
  const recoveryService = new ExecutionRecoveryService(executionStore);
  let executionQueue: ExecutionQueue | null = null;
  let reconciler: import("@4evergent/stellar").TransactionStatusReconciler | null = null;

  // Run crash recovery BEFORE starting the queue worker.
  if (options.executionQueue?.enabled) {
    try {
      const recoveryResult = await recoveryService.recover();
      if (recoveryResult.found > 0) {
        console.log(
          `[execution-recovery] recovered ${recoveryResult.recovered}/${recoveryResult.found} stuck executions`
        );
      }
    } catch (err) {
      console.error("[execution-recovery] recovery failed:", err);
    }
  }

  // --- Transaction status reconciliation setup ---
  if (options.reconciliation?.enabled) {
    const statusProvider: import("@4evergent/stellar").TransactionStatusProvider = {
      getStatus: (txHash: string) => adapter.getTransactionStatus(txHash),
    };
    reconciler =
      options.reconciliation.instance ??
      new TransactionStatusReconciler(executionStore, statusProvider, {
        intervalMs: options.reconciliation.intervalMs,
      });
    reconciler.start();
    console.log("[reconciler] started, interval:", options.reconciliation.intervalMs ?? 30_000, "ms");
  }

  if (options.executionQueue?.enabled) {
    const getSourceAccount = async () => {
      const account = await adapter.getAccount(options.signer.getAccountId());
      return {
        accountId: () => account.address,
        sequenceNumber: () => account.sequence,
        incrementSequenceNumber: () => {},
      };
    };

    const pipelineExecutor = async (record: ExecutionRecord) => {
      // Phase 25: Wrap sequence-sensitive execution in account-scoped lock.
      //
      // WHY: Two concurrent executions using the SAME Stellar source account
      // could read the same Horizon sequence and build transactions with the
      // same sequence number. One would fail at Horizon with "unexpected
      // sequence". The lock serializes the critical section (read sequence →
      // build → simulate → sign → submit) per Stellar account.
      //
      // The coordination key is the signer's Stellar public key (G...), which
      // is stable per server instance. All executions through this API server
      // share the same signer → same Stellar account → serialized. Different
      // server instances (different signers) are not affected.
      //
      // getSourceAccount() is called INSIDE the lock to prevent the race where
      // two executions read the same sequence before either acquires the lock.
      const accountId = options.signer.getAccountId();
      return sequenceCoordinator.runExclusive(accountId, async () => {
        const sourceAccount = await getSourceAccount();
        const outcome = await pipeline.execute({ intent: record.intent, sourceAccount });
        const txHash = (outcome as { txHash?: string }).txHash;
        return {
          record,
          success: outcome.status === "submitted",
          status: outcome.status,
          error: outcome.message,
          errorClass: outcome.status === "rejected" ? "permanent" as const : "transient" as const,
          txHash,
          submittedHash: txHash ?? null,
        };
      });
    };

    const preCheck = async (txHash: string) => {
      const status = await adapter.getTransactionStatus(txHash);
      if (status === "confirmed" || status === "failed") return "found" as const;
      if (status === "not_found") return "not_found" as const;
      return "network_error" as const;
    };

    executionQueue =
      options.executionQueue.instance ??
      new ExecutionQueue(executionStore, pipelineExecutor, getSourceAccount, {
        intervalMs: options.executionQueue.intervalMs,
        concurrency: options.executionQueue.concurrency,
        preCheck,
      });

    executionQueue.start();
    console.log("[execution-queue] started, interval:", options.executionQueue.intervalMs ?? 10_000, "ms");
  }

  // --- Scheduler setup ---
  // The scheduler executes due schedules via the SAME pipeline as manual intents.
  // It is opt-in: only starts if options.scheduler.enabled is true.
  let scheduler: AgentScheduler | null = null;
  if (options.scheduler?.enabled) {
    const scheduleExecution = new ScheduleExecutionService({
      activityStore: store,
      approvalStore: approvals,
      getSourceAccount: async () => {
        const account = await adapter.getAccount(options.signer.getAccountId());
        return {
          accountId: () => account.address,
          sequenceNumber: () => account.sequence,
          incrementSequenceNumber: () => {},
        };
      },
      pipelineExecutor: (input) => pipeline.execute(input) as any,
    });

    const agentStatusStore = {
      get: async (id: string) => {
        const agent = agents.get(id);
        return agent ? { id: agent.id, status: agent.status, ownerId: agent.ownerId } : null;
      },
    };

    scheduler =
      options.scheduler.instance ??
      new AgentScheduler(
        schedules,
        agentStatusStore,
        async (schedule) => {
          // If execution queue is enabled, enqueue; otherwise fall back to
          // direct ScheduleExecutionService invocation.
          if (executionQueue) {
            const now = new Date().toISOString();
            const executionRecord: ExecutionRecord = {
              id: crypto.randomUUID(),
              ownerId: schedule.ownerId,
              agentId: schedule.agentId,
              approvalId: null,
              activityId: null,
              intent: schedule.intent,
              status: "queued",
              policyDecision: null,
              simulationResult: null,
              txHash: null,
              submittedHash: null,
              error: null,
              attempt: 0,
              nextRetryAt: null,
              startedAt: null,
              completedAt: null,
              errorClass: null,
              createdAt: now,
              updatedAt: now,
            };
            void executionQueue.enqueue(executionRecord);
            return {
              status: "submitted",
              message: "schedule enqueued for execution",
              policyDecision: {
                result: "allow",
                reason: "schedule enqueued",
                rule: "scheduler",
                intent: schedule.intent,
              },
              simulationResult: null,
              txHash: null as unknown as string,
              activityId: undefined,
              approvalId: undefined,
            } as ScheduleExecutionResult;
          }
          return scheduleExecution.executeSchedule(schedule);
        },
        options.scheduler.intervalMs !== undefined
          ? { intervalMs: options.scheduler.intervalMs }
          : {}
      );

    scheduler.start();
    console.log("[scheduler] started, interval:", options.scheduler.intervalMs ?? 60_000, "ms");
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    if (method === "POST" && url === "/agents") {
      return handleCreateAgent(req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/intents$/.test(url)) {
      return handleIntent(req, res);
    }
    if (method === "POST" && /^\/approvals\/[^/]+\/(approve|reject)$/.test(url)) {
      const isApprove = url.endsWith("/approve");
      return isApprove ? handleApprove(req, res) : handleReject(req, res);
    }
    if (method === "GET" && url === "/health") {
      return json(res, { status: "ok", signerAccountId: options.signer.getAccountId() });
    }
    if (method === "GET" && /^\/agents\/[^/]+\/policy$/.test(url)) {
      return handleGetPolicy(req, res);
    }
    if (method === "PUT" && /^\/agents\/[^/]+\/policy$/.test(url)) {
      return handlePutPolicy(req, res);
    }

    if (method === "GET" && url === "/agents") {
      return handleListAgents(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+$/.test(url)) {
      return handleGetAgent(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/activity(\?.*)?$/.test(url)) {
      return handleAgentActivity(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/activity\/[^/]+$/.test(url)) {
      return handleActivityDetail(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/approvals(\?.*)?$/.test(url)) {
      return handleAgentApprovals(req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+\/status$/.test(url)) {
      return handleUpdateAgentStatus(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/schedules(\?.*)?$/.test(url)) {
      return handleListSchedules(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleGetSchedule(req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/schedules$/.test(url)) {
      return handleCreateSchedule(req, res);
    }
    if (method === "PATCH" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleUpdateSchedule(req, res);
    }
    if (method === "DELETE" && /^\/agents\/[^/]+\/schedules\/[^/]+$/.test(url)) {
      return handleDeleteSchedule(req, res);
    }
    if (method === "POST" && /^\/agents\/[^/]+\/schedules\/[^/]+\/(pause|resume|disable)$/.test(url)) {
      return handleScheduleAction(req, res);
    }
    if (method === "GET" && /^\/approvals(\?.*)?$/.test(url)) {
      return handleListApprovals(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/executions(\?.*)?$/.test(url)) {
      return handleAgentExecutions(req, res);
    }
    if (method === "GET" && /^\/executions\/[^/]+$/.test(url)) {
      return handleExecutionDetail(req, res);
    }
    if (method === "GET" && /^\/agent-queue(\?.*)?$/.test(url)) {
      return handleQueueStatus(req, res);
    }
    if (method === "POST" && /^\/executions\/[^/]+\/retry$/.test(url)) {
      return handleRetryExecution(req, res);
    }
    if (method === "POST" && /^\/executions\/[^/]+\/cancel$/.test(url)) {
      return handleCancelExecution(req, res);
    }
    json(res, { error: "not found" }, 404);
  });

  async function handleListAgents(_req: any, res: any) {
    const all = await agentStore.listByOwner(requestCtx.ownerId);
    const agentList = all.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      description: a.description,
      ownerId: a.ownerId,
      stellarAddress: a.stellarAddress,
      capabilities: a.capabilities,
      active: a.active,
      createdAt: a.createdAt,
    }));
    return json(res, { agents: agentList });
  }

  async function handleCreateAgent(req: any, res: any) {
    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }

    const b = body as Record<string, unknown>;
    const displayName = b.displayName;
    if (typeof displayName !== "string" || displayName.trim().length === 0) {
      return json(res, { error: "displayName is required" }, 400);
    }
    if (displayName.trim().length > 100) {
      return json(res, { error: "displayName must be 100 characters or fewer" }, 400);
    }

    const description = typeof b.description === "string" ? b.description : "";

    let capabilities: string[] = [];
    if (b.capabilities !== undefined) {
      if (!Array.isArray(b.capabilities) || !b.capabilities.every((c) => typeof c === "string")) {
        return json(res, { error: "capabilities must be an array of strings" }, 400);
      }
      capabilities = b.capabilities as string[];
    }

    let stellarAddress = "";
    if (b.stellarAddress !== undefined) {
      if (typeof b.stellarAddress !== "string") {
        return json(res, { error: "stellarAddress must be a string" }, 400);
      }
      stellarAddress = b.stellarAddress;
    }

    const agent = await agentStore.create({
      displayName: displayName.trim(),
      description,
      capabilities,
      ownerId: requestCtx.ownerId,
      stellarAddress,
    });

    // Backward compatibility: keep in-memory map in sync
    agents.set(agent.id, agent);

    return json(res, { agent }, 201);
  }

  async function handleAgentActivity(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/activity$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const allowed = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!allowed) return json(res, { error: "not found" }, 404);
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const activity = await store.listByAgent(agentId, limit);
    return json(res, { agentId, activity });
  }

  async function handleListApprovals(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const statusFilter = urlObj.searchParams.get("status") ?? undefined;
    const all = await approvals.listByOwner(requestCtx.ownerId, 200);
    const filtered = statusFilter
      ? all.filter((r) => r.status === statusFilter).slice(0, 50)
      : all.slice(0, 50);
    return json(res, { approvals: filtered });
  }


  async function handleGetPolicy(req: any, res: any) {
    const agentId = extractAgentIdFromPolicyUrl(req.url);
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);

    if (!agents.has(agentId)) return json(res, { error: "agent not found" }, 404);
    const canAccess = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!canAccess) return json(res, { error: "not found" }, 404);

    const metadata = await policyConfigStore.getWithMetadata(agentId);
    if (metadata) {
      return json(res, {
        agentId,
        policy: metadata.rules,
        version: metadata.version,
        updatedAt: metadata.updatedAt,
      });
    }
    // No custom policy — return DEFAULT_RULES with version indicator
    return json(res, { agentId, policy: DEFAULT_RULES, version: 0, updatedAt: null });
  }

  async function handlePutPolicy(req: any, res: any) {
    const agentId = extractAgentIdFromPolicyUrl(req.url);
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);

    if (!agents.has(agentId)) return json(res, { error: "agent not found" }, 404);
    const canAccess = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!canAccess) return json(res, { error: "not found" }, 404);

    let body: unknown;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }

    if (typeof body !== "object" || body === null) {
      return json(res, { error: "policy must be an object" }, 400);
    }

    const validation = validatePolicyRules(body);
    if (!validation.valid) {
      return json(res, { error: "invalid policy", details: validation.errors }, 400);
    }

    const normalized = normalizePolicyRules(body as Partial<PolicyRules>);
    const result = await policyConfigStore.upsert(agentId, requestCtx.ownerId, normalized);
    return json(res, { agentId, policy: result.rules, version: result.version });
  }

  function extractAgentIdFromPolicyUrl(url: string): string | null {
    const match = url.match(/^\/agents\/([^/]+)\/policy$/);
    return match?.[1] ?? null;
  }


  async function handleGetAgent(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const allowed = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!allowed) return json(res, { error: "not found" }, 404);
    const agent = await agentStore.getForOwner(agentId, requestCtx.ownerId);
    if (!agent) return json(res, { error: "not found" }, 404);
    return json(res, {
      id: agent.id,
      displayName: agent.displayName,
      description: agent.description,
      ownerId: agent.ownerId,
      stellarAddress: agent.stellarAddress,
      capabilities: agent.capabilities,
      status: agent.status,
      active: agent.active,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    });
  }

  async function handleActivityDetail(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/activity\/([^/]+)$/);
    const agentId = match?.[1];
    const activityId = match?.[2];
    if (!agentId || !activityId) return json(res, { error: "invalid path" }, 400);
    const allowed = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!allowed) return json(res, { error: "not found" }, 404);
    const activity = await store.getForOwner(activityId, requestCtx.ownerId);
    if (!activity) return json(res, { error: "not found" }, 404);
    return json(res, { activity });
  }

  async function handleAgentApprovals(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/approvals$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const allowed = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!allowed) return json(res, { error: "not found" }, 404);
    const statusFilter = urlObj.searchParams.get("status") ?? undefined;
    const all = await approvals.listByAgent(agentId, 200);
    const filtered = statusFilter ? all.filter((r) => r.status === statusFilter).slice(0, 50) : all.slice(0, 50);
    return json(res, { agentId, approvals: filtered });
  }

  async function handleUpdateAgentStatus(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/status$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const canChange = await authorizationService.canChangeAgentStatus(requestCtx, agentId);
    if (!canChange) return json(res, { error: "not found" }, 404);
    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }
    const status = (body as any)?.status;
    if (!["active", "paused", "disabled"].includes(status)) {
      return json(res, { error: "invalid status" }, 400);
    }
    const agent = await agentStore.update(agentId, { status: status as any });
    if (!agent) return json(res, { error: "not found" }, 404);
    return json(res, { id: agent.id, status: agent.status });
  }

  async function handleListSchedules(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const allowed = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!allowed) return json(res, { error: "not found" }, 404);
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const all = await schedules.listByAgent(agentId, limit);
    return json(res, { agentId, schedules: all });
  }

  async function handleGetSchedule(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return json(res, { error: "invalid path" }, 400);
    const allowed = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!allowed) return json(res, { error: "not found" }, 404);
    const schedule = await schedules.get(scheduleId);
    if (!schedule || schedule.ownerId !== requestCtx.ownerId) {
      return json(res, { error: "not found" }, 404);
    }
    return json(res, { schedule });
  }

  async function handleCreateSchedule(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const canCreate = await authorizationService.canCreateSchedule(requestCtx, agentId);
    if (!canCreate) return json(res, { error: "not found" }, 404);

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }

    const intent = (body as any)?.intent;
    const scheduleExpression = (body as any)?.scheduleExpression;
    const timezone = (body as any)?.timezone ?? "UTC";

    const { validateScheduleExpression, validateScheduleIntent } = await import("@4evergent/database");

    const intentValidation = validateScheduleIntent(intent);
    if (!intentValidation.valid) {
      return json(res, { error: intentValidation.error }, 400);
    }

    const exprValidation = validateScheduleExpression(scheduleExpression, timezone);
    if (!exprValidation.valid) {
      return json(res, { error: exprValidation.error }, 400);
    }

    const now = new Date().toISOString();
    const schedule = await schedules.create({
      id: crypto.randomUUID(),
      agentId,
      ownerId: requestCtx.ownerId,
      status: "active",
      intent,
      scheduleExpression,
      timezone,
      nextRunAt: exprValidation.nextRunAt ?? now,
      lastRunAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return json(res, { schedule }, 201);
  }

  async function handleUpdateSchedule(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return json(res, { error: "invalid path" }, 400);
    const canUpdate = await authorizationService.canUpdateSchedule(requestCtx, scheduleId);
    if (!canUpdate) return json(res, { error: "not found" }, 404);

    let body: unknown;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }

    const schedule = await schedules.get(scheduleId);
    if (!schedule) return json(res, { error: "not found" }, 404);

    const patch: any = {};
    if ((body as any)?.scheduleExpression !== undefined) {
      const { validateScheduleExpression } = await import("@4evergent/database");
      const result = validateScheduleExpression((body as any)?.scheduleExpression, schedule.timezone);
      if (!result.valid) return json(res, { error: result.error }, 400);
      patch.scheduleExpression = (body as any).scheduleExpression;
      patch.nextRunAt = result.nextRunAt ?? schedule.nextRunAt;
    }

    const updated = await schedules.update(scheduleId, patch);
    return json(res, { schedule: updated });
  }

  async function handleDeleteSchedule(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    if (!agentId || !scheduleId) return json(res, { error: "invalid path" }, 400);
    const canDelete = await authorizationService.canDeleteSchedule(requestCtx, scheduleId);
    if (!canDelete) return json(res, { error: "not found" }, 404);
    const deleted = await schedules.delete(scheduleId);
    if (!deleted) return json(res, { error: "not found" }, 404);
    return json(res, { deleted: true });
  }

  async function handleScheduleAction(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/schedules\/([^/]+)\/(pause|resume|disable)$/);
    const agentId = match?.[1];
    const scheduleId = match?.[2];
    const action = match?.[3] as "pause" | "resume" | "disable";
    if (!agentId || !scheduleId || !action) return json(res, { error: "invalid path" }, 400);

    let allowed: boolean;
    if (action === "pause") {
      allowed = await authorizationService.canPauseSchedule(requestCtx, scheduleId);
    } else if (action === "resume") {
      allowed = await authorizationService.canResumeSchedule(requestCtx, scheduleId);
    } else {
      allowed = await authorizationService.canDisableSchedule(requestCtx, scheduleId);
    }
    if (!allowed) return json(res, { error: "not found" }, 404);

    const schedule = await schedules.get(scheduleId);
    if (!schedule) return json(res, { error: "not found" }, 404);

    const status = action === "pause" ? "paused" : action === "resume" ? "active" : "disabled";
    const updated = await schedules.update(scheduleId, { status });
    return json(res, { schedule: updated });
  }

  async function handleAgentExecutions(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/executions$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const allowed = await authorizationService.canAccessAgent(requestCtx, agentId);
    if (!allowed) return json(res, { error: "not found" }, 404);
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const all = await executionStore.listByAgent(agentId, limit);
    return json(res, { agentId, executions: all });
  }

  async function handleExecutionDetail(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)$/);
    const executionId = match?.[1];
    if (!executionId) return json(res, { error: "invalid execution id in path" }, 400);
    const execution = await executionStore.getForOwner(executionId, requestCtx.ownerId);
    if (!execution) return json(res, { error: "not found" }, 404);
    return json(res, { execution });
  }

  async function handleQueueStatus(_req: any, res: any) {
    if (!executionQueue) {
      return json(res, { error: "execution queue not enabled" }, 404);
    }
    const all = await executionStore.listByOwner(requestCtx.ownerId, 200);
    const byStatus: Record<string, number> = {};
    for (const e of all) {
      byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    }
    return json(res, {
      running: executionQueue.isRunning(),
      byStatus,
    });
  }

  async function handleRetryExecution(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)\/retry$/);
    const executionId = match?.[1];
    if (!executionId) return json(res, { error: "invalid execution id in path" }, 400);

    if (!executionQueue) {
      return json(res, { error: "execution queue not enabled" }, 404);
    }

    const execution = await executionStore.getForOwner(executionId, requestCtx.ownerId);
    if (!execution) return json(res, { error: "not found" }, 404);

    if (execution.status !== "failed" && execution.status !== "dead_letter") {
      return json(res, { error: `cannot retry execution in status '${execution.status}'` }, 409);
    }

    const maxRetries = executionQueue["retryPolicy"]?.maxRetries ?? 3;
    if (execution.attempt >= maxRetries) {
      return json(res, { error: `max retry attempts (${maxRetries}) reached` }, 409);
    }

    const result = await executionQueue.retry(executionId, maxRetries);
    if (result.status === "not_found") return json(res, { error: "not found" }, 404);
    if (result.status === "invalid_state") return json(res, { error: `cannot retry execution in status '${execution.status}'` }, 409);
    if (result.status === "max_retries_reached") return json(res, { error: `max retry attempts (${maxRetries}) reached` }, 409);
    if (result.status === "conflict") return json(res, { error: "execution state changed; please refresh" }, 409);

    return json(res, { execution: result.execution, message: "execution queued for retry" });
  }

  async function handleCancelExecution(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/executions\/([^/]+)\/cancel$/);
    const executionId = match?.[1];
    if (!executionId) return json(res, { error: "invalid execution id in path" }, 400);

    if (!executionQueue) {
      return json(res, { error: "execution queue not enabled" }, 404);
    }

    const execution = await executionStore.getForOwner(executionId, requestCtx.ownerId);
    if (!execution) return json(res, { error: "not found" }, 404);

    if (execution.status !== "queued" && execution.status !== "executing") {
      return json(res, { error: `cannot cancel execution in status '${execution.status}'` }, 409);
    }

    const result = await executionQueue.cancel(executionId);
    if (result.status === "not_found") return json(res, { error: "not found" }, 404);
    if (result.status === "invalid_state") return json(res, { error: `cannot cancel execution in status '${execution.status}'` }, 409);
    if (result.status === "conflict") return json(res, { error: "execution state changed; please refresh" }, 409);

    return json(res, { execution: result.execution, message: "execution cancelled" });
  }

  async function handleIntent(req: any, res: any) {
    const agentId = extractAgentId(req.url);
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);

    let body: unknown;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }

    if (isRawTransaction(body)) {
      return json(res, { error: "raw XDR and transaction blobs are not accepted; submit a typed intent" }, 400);
    }

    let intent: AgentIntent;
    try {
      intent = parseIntent(body);
    } catch (e) {
      return json(res, { error: (e as Error).message }, 400);
    }

    const validation = IntentValidator.validate(intent);
    if (!validation.valid) {
      return json(res, { error: `Intent validation failed: ${validation.error}` }, 400);
    }

    if (!agents.has(agentId)) return json(res, { error: "agent not found" }, 404);
    const canSubmit = await authorizationService.canSubmitIntent(requestCtx, agentId);
    if (!canSubmit) return json(res, { error: "not found" }, 404);

    // Idempotency key from header (scoped to owner+agent)
    const idempotencyKey = extractHeader(req, "Idempotency-Key");
    if (idempotencyKey) {
      // Enforce bounded key length to prevent abuse
      if (idempotencyKey.length > 256) {
        return json(res, { error: "Idempotency-Key must be 256 characters or fewer" }, 400);
      }
      const existing = await store.getByIdempotencyKey(requestCtx.ownerId, agentId, idempotencyKey);
      if (existing) {
        // Same key + different intent → conflict
        const existingIntentJson = JSON.stringify(existing.intent);
        const newIntentJson = JSON.stringify(intent);
        if (existingIntentJson !== newIntentJson) {
          return json(res, { error: "Idempotency-Key already used with a different intent" }, 409);
        }
        // Duplicate request → return existing activity (idempotent success)
        return json(res, toIntentResponse(existing), 200);
      }
    }

    const decision = await policy.evaluate(intent, agentId);

    if (decision.result === "deny") {
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId, ownerId: requestCtx.ownerId } as any, idempotencyKey });
      const denied = outcome.activityId ? await store.get(outcome.activityId) : null;
      return json(res, toIntentResponse(denied!), 403);
    }

    if (decision.result === "requires_approval") {
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId, ownerId: requestCtx.ownerId } as any, idempotencyKey });
      if (outcome.status === "requires_approval" && outcome.activityId) {
        const pending = await store.get(outcome.activityId);
        assertNoSecrets(pending!);
        return json(res, { ...toIntentResponse(pending!), approvalId: outcome.approvalId }, 202);
      }
      const pending = await store.get(outcome.activityId ?? "");
      return json(res, toIntentResponse(pending!), 202);
    }

    // ALLOW → full execution path
    // Phase 26A: Sequence coordinator MUST wrap the entire sequence-sensitive
    // execution including getSourceAccount(). The coordinator key is the
    // Stellar public key (options.signer.getAccountId()).
    //
    // WHY: Without this, two concurrent ALLOW intents for the same Stellar
    // account could read the same Horizon sequence and build transactions with
    // the same sequence number. One would fail at Horizon.
    //
    // getSourceAccount() is called INSIDE the lock to prevent the race where
    // both executions read the sequence before either acquires the lock.
    const accountId = options.signer.getAccountId();
    const outcome = await sequenceCoordinator.runExclusive(accountId, async () => {
      let sourceAccount: any;
      try {
        const account = await adapter.getAccount(options.signer.getAccountId());
        sourceAccount = {
          accountId: () => account.address,
          sequenceNumber: () => account.sequence,
          incrementSequenceNumber: () => {},
          agentId,
          ownerId: requestCtx.ownerId,
        };
      } catch (e) {
        throw new Error(`Unable to load source account: ${(e as Error).message}`);
      }

      return pipeline.execute({ intent, sourceAccount });
    }).catch((e: any) => {
      return { status: "failed", message: e?.message ?? "Unknown error" } as any;
    });

    // Handle the failure case from getSourceAccount() inside the lock
    if (outcome.status === "failed") {
      const failed = makeActivity(intent, agentId, requestCtx.ownerId, decision, "failed", null, outcome.message ?? "Unknown error");
      await store.record(failed);
      return json(res, toIntentResponse(failed), 502);
    }

    if (outcome.status === "submitted") {
      if (outcome.activityId) {
        const submitted = await store.get(outcome.activityId);
        if (submitted) {
          assertNoSecrets(submitted);
          return json(res, toIntentResponse(submitted), 200);
        }
      }
      // Fallback: pipeline returned submitted but no activity id (store-less mode)
      return json(res, {
        activityId: "",
        agentId,
        status: "submitted",
        policyDecision: decision,
        authorizationStatus: "approved",
        simulationResult: outcome.simulationResult,
        txHash: outcome.txHash,
        error: null,
      }, 200);
    }

    if (outcome.status === "simulation_failed") {
      const failed = outcome.activityId ? await store.get(outcome.activityId) : null;
      return json(res, toIntentResponse(failed!), 422);
    }

    const rejected = outcome.activityId ? await store.get(outcome.activityId) : null;
    return json(res, toIntentResponse(rejected!), 403);
  }

  async function handleApprove(req: any, res: any) {
    const approvalId = extractApprovalId(req.url);
    if (!approvalId) return json(res, { error: "invalid approval id in path" }, 400);

    let body: unknown = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }

    if (isRawTransaction(body)) {
      return json(res, { message: "raw XDR and transaction blobs are not accepted at the approve endpoint" }, 400);
    }

    const approver = typeof (body as any)?.approver === "string" ? (body as any).approver : undefined;

    const approval = await approvals.get(approvalId);
    if (!approval) {
      return json(res, toApprovalResponse(approvalId, "", "rejected", "approval not found"), 404);
    }

    const canApprove = await authorizationService.canApprove(requestCtx, approvalId);
    if (!canApprove) return json(res, toApprovalResponse(approvalId, "", "rejected", "approval not found"), 404);

    const transitionError = validateApprovalTransition(approval.status, "approved");
    if (transitionError) {
      return json(res, toApprovalResponse(approvalId, approval.activityId, approval.status, `cannot approve: ${transitionError}`), 409);
    }

    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      await approvals.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
      return json(res, toApprovalResponse(approvalId, approval.activityId, "expired", "approval expired"), 410);
    }

    await approvals.update(approvalId, { status: "approved", approvedAt: new Date().toISOString(), approver: approver ?? null });

    // Enqueue for execution via the persistent execution queue.
    // If the queue is not enabled, fall back to setImmediate (Phase 8 behavior).
    if (options.deferExecution) {
      // execution deferred intentionally — no action taken here
    } else if (executionQueue) {
      const now = new Date().toISOString();
      const executionRecord: ExecutionRecord = {
        id: crypto.randomUUID(),
        ownerId: approval.ownerId,
        agentId: approval.agentId,
        approvalId,
        activityId: approval.activityId,
        intent: approval.intent,
        status: "queued",
        policyDecision: approval.policyDecision,
        simulationResult: null,
        txHash: null,
        submittedHash: null,
        error: null,
        attempt: 0,
        nextRetryAt: null,
        startedAt: null,
        completedAt: null,
        errorClass: null,
        createdAt: now,
        updatedAt: now,
      };
      void executionQueue.enqueue(executionRecord);
    } else {
      // Fallback: Phase 8 fire-and-forget behavior
      // Phase 26A: Must also use sequence coordinator
      const accountId = options.signer.getAccountId();
      setImmediate(() => {
        sequenceCoordinator.runExclusive(accountId, async () => {
          return pipeline.executeApproved(approvalId, approver);
        }).catch(() => {});
      });
    }

    return json(res, toApprovalResponse(approvalId, approval.activityId, "approved", "approval accepted; transaction queued for execution"), 200);

  }

  async function handleReject(req: any, res: any) {
    const approvalId = extractApprovalId(req.url);
    if (!approvalId) return json(res, { error: "invalid approval id in path" }, 400);

    let body: unknown = {};
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch {
      return json(res, { error: "invalid JSON body" }, 400);
    }

    if (isRawTransaction(body)) {
      return json(res, { message: "raw XDR and transaction blobs are not accepted at the reject endpoint" }, 400);
    }

    const approval = await approvals.get(approvalId);
    if (!approval) {
      return json(res, toApprovalResponse(approvalId, "", "rejected", "approval not found"), 404);
    }

    const canReject = await authorizationService.canReject(requestCtx, approvalId);
    if (!canReject) return json(res, toApprovalResponse(approvalId, "", "rejected", "approval not found"), 404);

    const transitionError = validateApprovalTransition(approval.status, "rejected");
    if (transitionError) {
      return json(res, toApprovalResponse(approvalId, approval.activityId, approval.status, `cannot reject: ${transitionError}`), 409);
    }

    await approvals.update(approvalId, { status: "rejected", rejectedAt: new Date().toISOString() });
    await store.update(approval.activityId, { status: "rejected", authorizationStatus: "denied_by_policy", error: "approval rejected by human" });

    return json(res, toApprovalResponse(approvalId, approval.activityId, "rejected", "approval rejected"), 200);
  }

  function toIntentResponse(rec: ActivityRecord): IntentResponse {
    return {
      activityId: rec.id,
      agentId: rec.agentId,
      status: rec.status,
      policyDecision: rec.policyDecision,
      authorizationStatus: rec.authorizationStatus ?? "not_required",
      simulationResult: rec.simulationResult,
      txHash: rec.txHash,
      error: rec.error,
    };
  }

  function toApprovalResponse(approvalId: string, activityId: string, status: ApprovalStatus, message: string): ApprovalResponse {
    return { approvalId, activityId, agentId: "", status, message };
  }

  return {
    server,
    listen: (port: number) => new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => new Promise<void>((resolve) => {
      if (scheduler) {
        scheduler.stop();
        console.log("[scheduler] stopped");
      }
      if (executionQueue) {
        executionQueue.stop();
        console.log("[execution-queue] stopped");
      }
      if (reconciler) {
        reconciler.stop();
        console.log("[reconciler] stopped");
      }
      // Abort lingering keep-alive connections so the server actually shuts
      // down (Node's http close() waits for active sockets otherwise).
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
    registerAgent: (agent: Agent) => {
      agents.set(agent.id, agent);
      void agentStore.create({
        id: agent.id,
        displayName: agent.displayName,
        description: agent.description,
        capabilities: agent.capabilities,
        ownerId: agent.ownerId,
        stellarAddress: agent.stellarAddress,
        status: agent.status,
      }).catch(() => {});
    },
    store,
    approvals,
    executionStore,
    agentStore,
    scheduler,
    executionQueue,
    recoveryService,
  };
}

function makeActivity(
  intent: AgentIntent,
  agentId: string,
  ownerId: string,
  policyDecision: PolicyDecision,
  status: string,
  authorizationStatus: string | null,
  error: string | null
): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId,
    ownerId,
    intent,
    policyDecision,
    authorizationStatus: authorizationStatus as any,
    simulationResult: null,
    txHash: null,
    status: status as any,
    error,
    createdAt: now,
    updatedAt: now,
  };
}

function json(res: any, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function extractHeader(req: any, name: string): string | null {
  const raw = req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] || null;
  if (typeof raw === "string") return raw;
  return null;
}

function extractAgentId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/agents\/([^/]+)\/intents$/);
  return match?.[1] ?? null;
}

function extractApprovalId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/^\/approvals\/([^/]+)\/(approve|reject)$/);
  return match?.[1] ?? null;
}

function isRawTransaction(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.xdr === "string" ||
    typeof b.envelope === "string" ||
    typeof b.transaction === "string" ||
    Array.isArray(b.operations) ||
    typeof b.tx_blob === "string"
  );
}

function parseIntent(body: unknown): AgentIntent {
  if (typeof body !== "object" || body === null) throw new Error("intent must be an object");
  const b = body as Record<string, unknown>;
  if (typeof b.type !== "string") throw new Error("intent.type is required");
  switch (b.type) {
    case "payment": {
      if (typeof b.asset !== "string") throw new Error("payment.asset is required");
      if (typeof b.destination !== "string") throw new Error("payment.destination is required");
      if (typeof b.amount !== "string") throw new Error("payment.amount is required as string");
      if (typeof b.reason !== "string") throw new Error("payment.reason is required");
      let validatedDetails: { code: string; issuer: string | null } | undefined;
      const assetDetails = (b.assetDetails as { code?: unknown; issuer?: unknown } | undefined);
      if (assetDetails !== undefined) {
        if (typeof assetDetails.code !== "string" || assetDetails.code.length < 1 || assetDetails.code.length > 12) {
          throw new Error("payment.assetDetails.code must be a Stellar asset code (1-12 characters)");
        }
        if (assetDetails.code === "XLM") {
          if (assetDetails.issuer != null && assetDetails.issuer !== "") {
            throw new Error("payment.assetDetails.issuer must be null for XLM");
          }
          validatedDetails = { code: "XLM", issuer: null };
        } else {
          if (typeof assetDetails.issuer !== "string" || !assetDetails.issuer.startsWith("G") || assetDetails.issuer.length !== 56) {
            throw new Error("payment.assetDetails.issuer must be a valid Stellar address (G...)");
          }
          validatedDetails = { code: assetDetails.code, issuer: assetDetails.issuer };
        }
      }
      return {
        type: "payment",
        asset: b.asset,
        assetDetails: validatedDetails,
        destination: b.destination,
        amount: b.amount,
        reason: b.reason,
        memo: typeof b.memo === "string" ? b.memo : undefined,
      };
    }
    case "trustline": {
      if (typeof b.assetCode !== "string" || b.assetCode.length < 1 || b.assetCode.length > 12) {
        throw new Error("trustline.assetCode must be a Stellar asset code (1-12 characters)");
      }
      if (b.assetCode === "XLM") throw new Error("XLM cannot be used as a trustline asset");
      if (typeof b.issuer !== "string" || !b.issuer.startsWith("G") || b.issuer.length !== 56) {
        throw new Error("trustline.issuer must be a valid Stellar address (G...)");
      }
      if (typeof b.reason !== "string") throw new Error("trustline.reason is required");
      return {
        type: "trustline",
        assetCode: b.assetCode,
        issuer: b.issuer,
        limit: typeof b.limit === "string" && b.limit.trim().length > 0 ? b.limit : undefined,
        reason: b.reason,
      };
    }
    case "contract_call":
    case "account_settings":
      throw new Error(`intent type '${b.type}' is not yet supported by the transaction pipeline`);
    default:
      throw new Error(`unknown intent type: ${b.type}`);
  }
}

void randomUUID;
void TESTNET_PASSPHRASE;
