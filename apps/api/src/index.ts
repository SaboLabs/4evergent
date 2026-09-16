import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { Agent, AgentIntent, ActivityStatus, AuthorizationStatus, PolicyDecision, SimulationResult } from "@4evergent/shared";
import { IntentValidator } from "@4evergent/agent-core";
import { PolicyEngine, DEFAULT_RULES } from "@4evergent/policy";
import { StellarAdapter } from "@4evergent/agent-core";
import { TransactionPipeline } from "@4evergent/stellar";
import type { Signer } from "@4evergent/stellar";
import { InMemoryActivityStore, createActivity, updateActivity, assertNoSecrets } from "@4evergent/database";
import type { ActivityRecord, ActivityStore } from "@4evergent/database";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

interface PipelineResponse {
  activityId: string;
  agentId: string;
  status: ActivityStatus;
  policyDecision: PolicyDecision;
  authorizationStatus: AuthorizationStatus;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  error: string | null;
}

interface PendingApprovalResponse {
  activityId: string;
  agentId: string;
  status: "requires_approval";
  policyDecision: PolicyDecision;
  authorizationStatus: "pending_approval";
  message: string;
}

const agents = new Map<string, Agent>();

export interface ServerOptions {
  port: number;
  horizonUrl: string;
  signer: Signer;
  policyRules?: Partial<typeof DEFAULT_RULES>;
  activityStore?: ActivityStore;
}

export function createApiServer(options: ServerOptions) {
  const store = options.activityStore ?? new InMemoryActivityStore();
  const pipeline = new TransactionPipeline({
    horizonUrl: options.horizonUrl,
    networkPassphrase: TESTNET_PASSPHRASE,
    signer: options.signer,
  });
  const policy = new PolicyEngine(options.policyRules);
  const adapter = new StellarAdapter(options.horizonUrl);

  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/agents/") && req.url.endsWith("/intents")) {
      return handleIntent(req, res);
    }
    if (req.method === "GET" && req.url === "/health") {
      return json(res, { status: "ok", signerAccountId: options.signer.getAccountId() });
    }
    json(res, { error: "not found" }, 404);
  });

  async function handleIntent(req: any, res: any) {
    const agentId = extractAgentId(req.url);
    if (!agentId) return json(res, { error: "invalid agent id in path" }, 400);

    let body: unknown;
    try {
      const text = await readBody(req);
      body = JSON.parse(text);
    } catch (e) {
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

    const agent = agents.get(agentId);
    if (!agent) return json(res, { error: "agent not found" }, 404);

    const decision = policy.evaluate(intent, options.signer.getAccountId());

    const activity = createActivity(agentId, intent, decision);
    await store.record(activity);

    if (decision.result === "deny") {
      const denied = updateActivity(activity, {
        status: "rejected",
        authorizationStatus: "denied_by_policy",
        error: decision.reason,
      });
      await store.record(denied);
      return json(res, toPipelineResponse(denied), 403);
    }

    if (decision.result === "requires_approval") {
      const pending = updateActivity(activity, {
        status: "requires_approval",
        authorizationStatus: "pending_approval",
        error: null,
      });
      await store.record(pending);
      return json(res, toPendingResponse(pending, decision), 202);
    }

    let sourceAccount: any;
    try {
      const account = await adapter.getAccount(options.signer.getAccountId());
      sourceAccount = {
        accountId: () => account.address,
        sequenceNumber: () => account.sequence,
        incrementSequenceNumber: () => {},
      };
    } catch (e) {
      const failed = updateActivity(activity, {
        status: "failed",
        error: `Unable to load source account: ${(e as Error).message}`,
      });
      await store.record(failed);
      return json(res, toPipelineResponse(failed), 502);
    }

    const outcome = await pipeline.execute({ intent, sourceAccount });

    if (outcome.status === "submitted") {
      const submitted = updateActivity(activity, {
        status: "submitted",
        authorizationStatus: "approved",
        simulationResult: outcome.simulationResult,
        txHash: outcome.txHash,
      });
      assertNoSecrets(submitted);
      await store.record(submitted);
      return json(res, toPipelineResponse(submitted), 200);
    }

    if (outcome.status === "simulation_failed") {
      const failed = updateActivity(activity, {
        status: "failed",
        authorizationStatus: "denied_by_simulation",
        simulationResult: outcome.simulationResult,
        error: outcome.message,
      });
      await store.record(failed);
      return json(res, toPipelineResponse(failed), 422);
    }

    const rejected = updateActivity(activity, {
      status: "rejected",
      error: outcome.message,
      simulationResult: outcome.simulationResult ?? null,
    });
    await store.record(rejected);
    return json(res, toPipelineResponse(rejected), 403);
  }

  function toPipelineResponse(rec: ActivityRecord): PipelineResponse {
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

  function toPendingResponse(rec: ActivityRecord, decision: PolicyDecision): PendingApprovalResponse {
    return {
      activityId: rec.id,
      agentId: rec.agentId,
      status: "requires_approval",
      policyDecision: decision,
      authorizationStatus: "pending_approval",
      message:
        "Policy ALLOW with approval_required=true. Transaction is NOT signed or submitted. " +
        "Persistent approval storage is not implemented yet (see docs/roadmap.md).",
    };
  }

  return {
    server,
    listen: (port: number) =>
      new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    registerAgent: (agent: Agent) => agents.set(agent.id, agent),
    store,
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
