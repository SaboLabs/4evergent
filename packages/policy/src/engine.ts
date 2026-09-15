import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import { DEFAULT_RULES, type PolicyRules } from "./types.js";

export class PolicyEngine {
  private rules: PolicyRules;

  constructor(rules?: Partial<PolicyRules>) {
    this.rules = { ...DEFAULT_RULES, ...rules };
  }

  evaluate(intent: AgentIntent, agentAddress: string): PolicyDecision {
    const decide = (result: PolicyDecision["result"], reason: string, rule: string): PolicyDecision => ({
      result,
      reason,
      rule,
      intent,
    });

    const typeAllowed = this.rules.txTypeRestrictions[intent.type];
    if (typeAllowed !== true) {
      return decide("deny", `Transaction type '${intent.type}' is not permitted`, "txTypeRestrictions");
    }

    const amount = extractAmount(intent);
    const asset = extractAsset(intent);

    if (amount !== null) {
      const maxForAsset = this.rules.maxTxAmount[asset] ?? this.rules.maxTxAmount["native"];
      if (maxForAsset && compareAmounts(amount, maxForAsset) > 0) {
        return decide("deny", `Amount ${amount} ${asset} exceeds max_tx_amount ${maxForAsset}`, "maxTxAmount");
      }

      const dailyLimit = this.rules.dailySpendingLimit[asset] ?? this.rules.dailySpendingLimit["native"];
      if (dailyLimit && compareAmounts(amount, dailyLimit) > 0) {
        return decide("deny", `Amount ${amount} ${asset} exceeds daily limit ${dailyLimit}`, "dailySpendingLimit");
      }

      const threshold = this.rules.requireHumanApprovalForAmountAbove;
      if (threshold && compareAmounts(amount, threshold) >= 0) {
        return decide("requires_approval", `Amount ${amount} ${asset} requires human approval (>= ${threshold})`, "approvalThreshold");
      }
    }

    if (this.rules.allowedAssets.length > 0 && !this.rules.allowedAssets.includes(asset)) {
      return decide("deny", `Asset '${asset}' is not in allowed_assets`, "allowedAssets");
    }

    if (intent.type === "payment" && this.rules.allowedDestinations.length > 0) {
      if (!this.rules.allowedDestinations.includes(intent.destination)) {
        return decide("deny", `Destination '${intent.destination}' not in allowed_destinations`, "allowedDestinations");
      }
    }

    if (intent.type === "contract_call" && this.rules.allowedContractIds.length > 0) {
      if (!this.rules.allowedContractIds.includes(intent.contractId)) {
        return decide("deny", `Contract '${intent.contractId}' not in allowed list`, "allowedContractIds");
      }
    }

    return decide("allow", "All policy checks passed", "default");
  }
}

function extractAmount(intent: AgentIntent): string | null {
  if (intent.type === "payment") return intent.amount;
  if (intent.type === "trustline" && intent.limit) return intent.limit;
  return null;
}

function extractAsset(intent: AgentIntent): string {
  if (intent.type === "payment") return intent.asset;
  return "native";
}

function compareAmounts(a: string, b: string): number {
  const pa = parseFloat(a);
  const pb = parseFloat(b);
  if (isNaN(pa) || isNaN(pb)) return 0;
  return pa > pb ? 1 : pa < pb ? -1 : 0;
}
