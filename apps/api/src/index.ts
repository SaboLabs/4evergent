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
import { PolicyEngine } from "@4evergent/policy";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "@4evergent/stellar";
import type { Signer } from "@4evergent/stellar";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  SQLiteActivityStore,
  SQLiteApprovalStore,
  assertNoSecrets,
  validateApprovalTransition,
  type ActivityStore,
  type ApprovalStore,
  type ApprovalRecord,
  type ApprovalStatus,
  type ActivityRecord,
} from "@4evergent/database";
import type { PolicyRules, Agent } from "@4evergent/shared";

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

export interface ServerOptions {
  port: number;
  horizonUrl: string;
  signer: Signer;
  policyRules?: Partial<PolicyRules>;
  activityStore?: ActivityStore;
  approvalStore?: ApprovalStore;
  dbPath?: string;
  deferExecution?: boolean; // if true, approve() only marks approved, doesn't execute
}

export function createApiServer(options: ServerOptions) {
  const store: ActivityStore =
    options.activityStore ??
    (options.dbPath ? new SQLiteActivityStore(options.dbPath) : new InMemoryActivityStore());
  const approvals: ApprovalStore =
    options.approvalStore ??
    (options.dbPath ? new SQLiteApprovalStore(options.dbPath) : new InMemoryApprovalStore());
  const pipeline = new TransactionPipeline({
    horizonUrl: options.horizonUrl,
    networkPassphrase: TESTNET_PASSPHRASE,
    signer: options.signer,
    activityStore: store,
    approvalStore: approvals,
    policyRules: options.policyRules,
  });
  const policy = new PolicyEngine(options.policyRules, store as any);
  const adapter = new StellarAdapter(options.horizonUrl);

  const server = createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

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
    if (method === "GET" && url === "/agents") {
      return handleListAgents(req, res);
    }
    if (method === "GET" && /^\/agents\/[^/]+\/activity(\?.*)?$/.test(url)) {
      return handleAgentActivity(req, res);
    }
    if (method === "GET" && /^\/approvals(\?.*)?$/.test(url)) {
      return handleListApprovals(req, res);
    }
    json(res, { error: "not found" }, 404);
  });

  async function handleListAgents(_req: any, res: any) {
    const agentList = [...agents.values()].map((a) => ({
      id: a.id,
      displayName: a.displayName,
      description: a.description,
      owner: a.owner,
      stellarAddress: a.stellarAddress,
      capabilities: a.capabilities,
      active: a.active,
      createdAt: a.createdAt,
    }));
    return json(res, { agents: agentList });
  }

  async function handleAgentActivity(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const match = urlObj.pathname.match(/^\/agents\/([^/]+)\/activity$/);
    const agentId = match?.[1];
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);
    const limit = Math.max(1, Math.min(100, Number(urlObj.searchParams.get("limit") ?? 50) || 50));
    const activity = await store.listByAgent(agentId, limit);
    return json(res, { agentId, activity });
  }

  async function handleListApprovals(req: any, res: any) {
    const urlObj = new URL(req.url ?? "", "http://localhost");
    const statusFilter = urlObj.searchParams.get("status") ?? undefined;
    const all = await approvals.listAll(200);
    const filtered = statusFilter
      ? all.filter((r) => r.status === statusFilter).slice(0, 50)
      : all.slice(0, 50);
    return json(res, { approvals: filtered });
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

    const decision = await policy.evaluate(intent, agentId);

    if (decision.result === "deny") {
      // Pipeline creates the record and returns its id.
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId } as any });
      const denied = outcome.activityId ? await store.get(outcome.activityId) : null;
      return json(res, toIntentResponse(denied!), 403);
    }

    if (decision.result === "requires_approval") {
      // Delegate to pipeline — it persists activity + approval atomically.
      const outcome = await pipeline.execute({ intent, sourceAccount: { agentId } as any });
      if (outcome.status === "requires_approval" && outcome.activityId) {
        const pending = await store.get(outcome.activityId);
        assertNoSecrets(pending!);
        return json(res, { ...toIntentResponse(pending!), approvalId: outcome.approvalId }, 202);
      }
      const pending = await store.get(outcome.activityId ?? "");
      return json(res, toIntentResponse(pending!), 202);
    }

    // ALLOW → full execution path
    let sourceAccount: any;
    try {
      const account = await adapter.getAccount(options.signer.getAccountId());
      sourceAccount = {
        accountId: () => account.address,
        sequenceNumber: () => account.sequence,
        incrementSequenceNumber: () => {},
        agentId,
      };
    } catch (e) {
      const failed = makeActivity(intent, agentId, decision, "failed", null, `Unable to load source account: ${(e as Error).message}`);
      await store.record(failed);
      return json(res, toIntentResponse(failed), 502);
    }

    const outcome = await pipeline.execute({ intent, sourceAccount });

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

    const transitionError = validateApprovalTransition(approval.status, "approved");
    if (transitionError) {
      return json(res, toApprovalResponse(approvalId, approval.activityId, approval.status, `cannot approve: ${transitionError}`), 409);
    }

    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      await approvals.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
      return json(res, toApprovalResponse(approvalId, approval.activityId, "expired", "approval expired"), 410);
    }

    await approvals.update(approvalId, { status: "approved", approvedAt: new Date().toISOString(), approver: approver ?? null });

    // Fire-and-forget execution. The HTTP response returns immediately;
    // the approval status will transition to submitted/failed asynchronously.
    if (!options.deferExecution) {
      setImmediate(() => {
        pipeline.executeApproved(approvalId, approver).catch(() => {});
      });
    }

    return json(res, toApprovalResponse(approvalId, approval.activityId, "approved", "approval accepted; transaction will execute asynchronously"), 200);

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
      // Abort lingering keep-alive connections so the server actually shuts
      // down (Node's http close() waits for active sockets otherwise).
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
    registerAgent: (agent: Agent) => agents.set(agent.id, agent),
    store,
    approvals,
  };
}

function makeActivity(
  intent: AgentIntent,
  agentId: string,
  policyDecision: PolicyDecision,
  status: string,
  authorizationStatus: string | null,
  error: string | null
): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId,
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
    case "payment":
      if (typeof b.asset !== "string") throw new Error("payment.asset is required");
      if (typeof b.destination !== "string") throw new Error("payment.destination is required");
      if (typeof b.amount !== "string") throw new Error("payment.amount is required as string");
      if (typeof b.reason !== "string") throw new Error("payment.reason is required");
      return {
        type: "payment",
        asset: b.asset,
        destination: b.destination,
        amount: b.amount,
        reason: b.reason,
        memo: typeof b.memo === "string" ? b.memo : undefined,
      };
    case "trustline":
    case "contract_call":
    case "account_settings":
      throw new Error(`intent type '${b.type}' is not yet supported by the transaction pipeline`);
    default:
      throw new Error(`unknown intent type: ${b.type}`);
  }
}

void randomUUID;
void TESTNET_PASSPHRASE;
