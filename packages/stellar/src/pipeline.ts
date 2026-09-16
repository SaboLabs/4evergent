import { StellarTransactionBuilder } from "./transaction-builder.js";
import { StellarSimulator } from "./simulator.js";
import { StellarSubmitter } from "./submitter.js";
import type { Signer } from "./signer.js";
import { PolicyEngine } from "@4evergent/policy";
import { IntentValidator } from "@4evergent/agent-core";
import type { AgentIntent, PolicyDecision, PolicyRules } from "@4evergent/shared";

export interface PipelineOptions {
  horizonUrl: string;
  networkPassphrase: string;
  signer: Signer;
  policyRules?: Partial<PolicyRules>;
}

export interface PipelineExecuteInput {
  intent: AgentIntent;
  sourceAccount: any;
}

/**
 * TransactionPipeline — orchestrates the secure transaction lifecycle.
 *
 * GATE ORDER (each must pass before the next runs):
 *   1. Intent validation  (IntentValidator)
 *   2. Policy evaluation (PolicyEngine)
 *   3. Authorization gate (allow + !requires_approval, or pre-approved)
 *   4. Transaction construction (StellarTransactionBuilder)
 *   5. Simulation (StellarSimulator)
 *   6. Signing (Signer — interface-abstracted)
 *   7. Submission (StellarSubmitter)
 *   8. Activity record
 *
 * No single function in this class bypasses the gate order. Callers go through
 * execute(), which invokes each step in sequence and stops at the first gate
 * that fails.
 */
export class TransactionPipeline {
  private builder: StellarTransactionBuilder;
  private simulator: StellarSimulator;
  private submitter: StellarSubmitter;
  private signer: Signer;
  private policy: PolicyEngine;

  constructor(options: PipelineOptions) {
    this.builder = new StellarTransactionBuilder();
    this.simulator = new StellarSimulator(options.horizonUrl);
    this.submitter = new StellarSubmitter(options.horizonUrl);
    this.signer = options.signer;
    this.policy = new PolicyEngine(options.policyRules);
  }

  /**
   * Executes the full pipeline for a payment intent.
   *
   * @param input  The intent + source account (from Horizon).
   * @param preApproved  Whether human approval has been recorded (for requires_approval flows).
   */
  async execute(input: PipelineExecuteInput, preApproved = false): Promise<PipelineOutcome> {
    const { intent, sourceAccount } = input;

    // 1. Intent validation
    const validation = IntentValidator.validate(intent);
    if (!validation.valid) {
      return {
        status: "rejected",
        message: `Intent validation failed: ${validation.error}`,
        policyDecision: { result: "deny", reason: "invalid intent", rule: "intent_validation", intent },
        simulationResult: null,
      };
    }

    // 2. Policy evaluation
    const decision = this.policy.evaluate(intent, this.signer.getAccountId());

    // 3. Authorization gate
    if (decision.result === "deny") {
      return {
        status: "rejected",
        message: `Policy denied: ${decision.reason}`,
        policyDecision: decision,
        simulationResult: null,
      };
    }
    if (decision.result === "requires_approval" && !preApproved) {
      return {
        status: "requires_approval",
        message: decision.reason,
        policyDecision: decision,
        simulationResult: null,
      };
    }

    // 4. Construct transaction
    let tx;
    try {
      tx = await this.builder.buildPayment(
        sourceAccount,
        intent as any,
        this.signer.getNetworkPassphrase()
      );
    } catch (e: any) {
      return {
        status: "rejected",
        message: `Transaction construction failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: null,
      };
    }

    // 5. Simulate
    const simResult = await this.simulator.simulate(tx);
    if (!simResult.success) {
      return {
        status: "simulation_failed",
        message: simResult.error ?? "Simulation failed",
        policyDecision: decision,
        simulationResult: simResult,
      };
    }

    // 6. Sign
    let signedTx;
    try {
      signedTx = await this.signer.sign(tx);
    } catch (e: any) {
      return {
        status: "rejected",
        message: `Signing failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
      };
    }

    // 7. Submit
    try {
      const result = await this.submitter.submit(signedTx);
      return {
        status: "submitted",
        message: `Transaction submitted: ${result.hash}`,
        policyDecision: decision,
        simulationResult: simResult,
        txHash: result.hash,
      };
    } catch (e: any) {
      return {
        status: "rejected",
        message: `Submission failed: ${e.message}`,
        policyDecision: decision,
        simulationResult: simResult,
      };
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
    }
  | {
      status: "simulation_failed";
      message: string;
      policyDecision: PolicyDecision;
      simulationResult: SimulationLike;
    }
  | {
   status: "requires_approval";
   message: string;
   policyDecision: PolicyDecision;
   simulationResult: null;
 }
 | {
   status: "rejected";
   message: string;
   policyDecision: PolicyDecision;
   simulationResult: SimulationLike | null;
 };

interface SimulationLike {
  success: boolean;
  fee: string;
  operations: number;
  warnings: string[];
  error?: string;
}
