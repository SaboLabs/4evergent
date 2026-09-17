import { StellarTransactionBuilder } from "./transaction-builder.js";
import { StellarSimulator } from "./simulator.js";
import { StellarSubmitter } from "./submitter.js";
import type { Signer } from "./signer.js";
import { PolicyEngine } from "@4evergent/policy";
import { IntentValidator } from "@4evergent/agent-core";
import { StellarAdapter } from "@4evergent/agent-core";
import type { AgentIntent, PolicyDecision, PolicyRules, ActivityRecord } from "@4evergent/shared";
import {
  createActivity,
  createApproval,
  type ActivityStore,
  type ApprovalStore,
} from "@4evergent/database";

export interface PipelineOptions {
  horizonUrl: string;
  networkPassphrase: string;
  signer: Signer;
  activityStore?: ActivityStore;
  approvalStore?: ApprovalStore;
  policyRules?: Partial<PolicyRules>;
  approvalTtlSeconds?: number;
}

export interface PipelineExecuteInput {
  intent: AgentIntent;
  sourceAccount: any;
  idempotencyKey?: string | null;
}

export class TransactionPipeline {
  private builder: StellarTransactionBuilder;
  private simulator: StellarSimulator;
  private submitter: StellarSubmitter;
  private signer: Signer;
  private policy: PolicyEngine;
  private activityStore?: ActivityStore;
  private approvalStore?: ApprovalStore;
  private approvalTtlSeconds: number;
  private horizonUrl: string;

  constructor(options: PipelineOptions) {
    this.builder = new StellarTransactionBuilder();
    this.simulator = new StellarSimulator(options.horizonUrl);
    this.submitter = new StellarSubmitter(options.horizonUrl);
    this.signer = options.signer;
    this.horizonUrl = options.horizonUrl;
    this.activityStore = options.activityStore;
    this.approvalStore = options.approvalStore;
    this.approvalTtlSeconds = options.approvalTtlSeconds ?? 86400;
    this.policy = new PolicyEngine(options.policyRules, options.activityStore as any);
  }

  async execute(input: PipelineExecuteInput): Promise<PipelineOutcome> {
    const { intent, sourceAccount, idempotencyKey } = input;

    const validation = IntentValidator.validate(intent);
    if (!validation.valid) {
      return {
        status: "rejected",
        message: `Intent validation failed: ${validation.error}`,
        policyDecision: { result: "deny", reason: "invalid intent", rule: "intent_validation", intent },
        simulationResult: null,
      };
    }

    const agentId = (sourceAccount as any)?.agentId ?? (sourceAccount as any)?.accountId?.() ?? "unknown";
    const ownerId = (sourceAccount as any)?.ownerId ?? "unknown";
    const decision = await this.policy.evaluate(intent, agentId);

    if (decision.result === "deny") {
      const denied = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
      denied.status = "rejected";
      denied.authorizationStatus = "denied_by_policy";
      denied.error = decision.reason;
      if (this.activityStore) await this.persistActivity(denied, idempotencyKey);
      return {
        status: "rejected",
        message: `Policy denied: ${decision.reason}`,
        policyDecision: decision,
        simulationResult: null,
        activityId: denied.id,
      };
    }

    if (decision.result === "requires_approval") {
      if (this.activityStore && this.approvalStore) {
        const activity = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
        activity.status = "requires_approval";
        activity.authorizationStatus = "pending_approval";
        const expiresAt = new Date(Date.now() + this.approvalTtlSeconds * 1000).toISOString();
        const approval = createApproval(activity.id, agentId, ownerId, intent, decision, expiresAt);
        await this.persistActivity(activity, idempotencyKey);
        await this.approvalStore.record(approval);
        return {
          status: "requires_approval",
          message: decision.reason,
          policyDecision: decision,
          simulationResult: null,
          activityId: activity.id,
          approvalId: approval.id,
        };
      }
      return {
        status: "requires_approval",
        message: decision.reason,
        policyDecision: decision,
        simulationResult: null,
      };
    }

    let tx;
    try {
      if (intent.type === "trustline") {
        tx = await this.builder.buildTrustline(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
      } else {
        tx = await this.builder.buildPayment(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
      }
    } catch (e: any) {
      const activity = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "rejected";
      activity.error = e.message;
      await this.persistActivity(activity, idempotencyKey);
      return {
        status: "rejected",
        message: `Transaction construction failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: null,
        activityId: activity.id,
      };
    }

    const simResult = await this.simulator.simulate(tx);
    if (!simResult.success) {
      const activity = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.authorizationStatus = "denied_by_simulation";
      activity.error = simResult.error ?? "Simulation failed";
      await this.persistActivity(activity, idempotencyKey);
      return {
        status: "simulation_failed",
        message: simResult.error ?? "Simulation failed",
        policyDecision: decision,
        simulationResult: simResult,
        activityId: activity.id,
      };
    }

    let signedTx;
    try {
      signedTx = await this.signer.sign(tx);
    } catch (e: any) {
      const activity = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.error = e.message;
      await this.persistActivity(activity, idempotencyKey);
      return {
        status: "rejected",
        message: `Signing failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
        activityId: activity.id,
      };
    }

    // PERSIST txHash BEFORE submit to survive crash window.
    // If process crashes after submit but before we return, the txHash is already
    // in the activity record so reconciliation can detect it.
    const preSubmitHash = signedTx.hash().toString("hex");

    try {
      const result = await this.submitter.submit(signedTx);
      const activity = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "submitted";
      activity.authorizationStatus = "approved";
      activity.txHash = result.hash;
      activity.simulationResult = simResult;
      await this.persistActivity(activity, idempotencyKey);
      return {
        status: "submitted",
        message: `Transaction submitted: ${result.hash}`,
        policyDecision: decision,
        simulationResult: simResult,
        txHash: result.hash,
        activityId: activity.id,
      };
    } catch (e: any) {
      // Submit failed — record pre-submit hash + error for recovery/reconciliation
      const activity = createActivity(agentId, ownerId, intent, decision, idempotencyKey);
      activity.status = "failed";
      activity.error = e.message;
      activity.txHash = preSubmitHash;
      activity.simulationResult = simResult;
      await this.persistActivity(activity, idempotencyKey);
      return {
        status: "rejected",
        message: `Submission failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
        txHash: preSubmitHash,
        activityId: activity.id,
      };
    }
  }

  async executeApproved(approvalId: string, approver?: string): Promise<PipelineOutcome> {
    if (!this.approvalStore || !this.activityStore) {
      return {
        status: "rejected",
        message: "Pipeline not configured with approval store",
        policyDecision: { result: "deny", reason: "misconfigured", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    const approval = await this.approvalStore.get(approvalId);
    if (!approval) {
      return {
        status: "rejected",
        message: `Approval ${approvalId} not found`,
        policyDecision: { result: "deny", reason: "not found", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    if (approval.status === "submitted" || approval.status === "confirmed") {
      return {
        status: "rejected",
        message: `Approval already executed with transaction ${approval.txHash ?? "unknown"}`,
        policyDecision: { result: "deny", reason: "already executed", rule: "approval", intent: approval.intent },
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    if (approval.status !== "approved") {
      return {
        status: "rejected",
        message: `Approval is ${approval.status}, not approved`,
        policyDecision: { result: "deny", reason: approval.status, rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    if (approval.expiresAt && new Date(approval.expiresAt) < new Date()) {
      await this.approvalStore.update(approvalId, { status: "expired", expiredAt: new Date().toISOString() });
      return {
        status: "rejected",
        message: "Approval has expired",
        policyDecision: { result: "deny", reason: "expired", rule: "approval", intent: null as any },
        simulationResult: null,
      };
    }

    await this.approvalStore.update(approvalId, { status: "executing" });

    const intent = approval.intent;
    const adapter = new StellarAdapter(this.horizonUrl);

    let sourceAccount: any;
    try {
      const account = await adapter.getAccount(this.signer.getAccountId());
      sourceAccount = {
        accountId: () => account.address,
        sequenceNumber: () => account.sequence,
        incrementSequenceNumber: () => {},
        agentId: approval.agentId,
      };
    } catch (e: any) {
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      return {
        status: "rejected",
        message: `Cannot load source account: ${e.message}`,
        policyDecision: { result: "deny", reason: "account load failed", rule: "approval", intent },
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    let tx;
    try {
      tx = await this.builder.buildPayment(sourceAccount, intent as any, this.signer.getNetworkPassphrase());
    } catch (e: any) {
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      return {
        status: "rejected",
        message: `Construction failed: ${e.message}`,
        policyDecision: { result: "deny", reason: "construction", rule: "approval", intent },
        simulationResult: null,
        activityId: approval.activityId,
      };
    }

    const simResult = await this.simulator.simulate(tx);
    if (!simResult.success) {
      await this.approvalStore.update(approvalId, { status: "failed", error: simResult.error ?? "Simulation failed" });
      return {
        status: "simulation_failed",
        message: simResult.error ?? "Simulation failed",
        policyDecision: { result: "deny", reason: "simulation", rule: "approval", intent },
        simulationResult: simResult,
        activityId: approval.activityId,
      };
    }

    let signedTx;
    try {
      signedTx = await this.signer.sign(tx);
    } catch (e: any) {
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      return {
        status: "rejected",
        message: `Signing failed: ${e.message}`,
        policyDecision: { result: "deny", reason: "signing", rule: "approval", intent },
        simulationResult: simResult,
        activityId: approval.activityId,
      };
    }

    // PERSIST txHash BEFORE submit to survive crash window
    const preSubmitHash = signedTx.hash().toString("hex");

    try {
      const result = await this.submitter.submit(signedTx);
      await this.approvalStore.update(approvalId, { status: "submitted", txHash: result.hash, approvedAt: new Date().toISOString(), approver: approver ?? null });
      if (approval.activityId) {
        const existing = await this.activityStore.get(approval.activityId);
        if (existing) {
          await this.activityStore.update(approval.activityId, { status: "submitted", txHash: result.hash, simulationResult: simResult, authorizationStatus: "approved" });
        }
      }
      return {
        status: "submitted",
        message: `Transaction submitted: ${result.hash}`,
        policyDecision: { result: "allow", reason: "executed", rule: "approval", intent },
        simulationResult: simResult,
        txHash: result.hash,
        activityId: approval.activityId,
      };
    } catch (e: any) {
      await this.approvalStore.update(approvalId, { status: "failed", error: e.message });
      return {
        status: "rejected",
        message: `Submission failed: ${e.message}`,
        policyDecision: { result: "deny", reason: "submission", rule: "approval", intent },
        simulationResult: simResult,
        txHash: preSubmitHash,
        activityId: approval.activityId,
      };
    }
  }

  private async persistActivity(record: ActivityRecord, idempotencyKey?: string | null): Promise<void> {
    if (!this.activityStore) return;
    if (idempotencyKey) {
      const result = await this.activityStore.recordIdempotent(idempotencyKey, record);
      if (!result.created) {
        // Another request already reserved this key — merge the new state into existing
        await this.activityStore.update(result.record.id, {
          status: record.status,
          authorizationStatus: record.authorizationStatus,
          error: record.error,
          txHash: record.txHash,
          simulationResult: record.simulationResult,
        });
      }
    } else {
      await this.activityStore.record(record);
    }
  }
}

export type PipelineOutcome =
  | {
      status: "submitted";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult: SimulationLike;
      txHash: string;
      activityId?: string;
      approvalId?: string;
    }
  | {
      status: "simulation_failed";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult: SimulationLike;
      txHash?: string | null;
      activityId?: string;
    }
  | {
      status: "requires_approval";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult?: SimulationLike | null;
      txHash?: string | null;
      activityId?: string;
      approvalId?: string;
    }
  | {
      status: "rejected";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult: SimulationLike | null;
      txHash?: string | null;
      activityId?: string;
    };

interface SimulationLike {
  success: boolean;
  fee: string;
  operations: number;
  warnings: string[];
  error?: string;
}
