import type { AgentIntent, PolicyDecision } from "@4evergent/shared";
import { DEFAULT_RULES, type PolicyRules } from "./types.js";

/**
 * PolicyEngine — deterministic, pure policy evaluation.
 *
 * SECURITY: Policy evaluation is the single gate that decides whether an
 * intent is allowed to proceed toward signing. It MUST be:
 *   - deterministic (same input → same output)
 *   - LLM-independent (no LLM involvement)
 *   - side-effect free (no network, no signing)
 *
 * The daily spending limit check requires reading persisted activity data.
 * For this reason, `evaluate()` is async. An ActivityStore can be provided
 * at construction time; without it, the daily limit check is skipped.
 */
export class PolicyEngine {
  private rules: PolicyRules;
  private activityStore?: {
    listByAgent: (agentId: string, limit?: number) => Promise<ActivityRecord[]>;
  };

  constructor(
    rules?: Partial<PolicyRules>,
    activityStore?: {
      listByAgent: (agentId: string, limit?: number) => Promise<ActivityRecord[]>;
    }
  ) {
    this.rules = { ...DEFAULT_RULES, ...rules } as PolicyRules;
    this.activityStore = activityStore;
  }

  async evaluate(intent: AgentIntent, agentId: string): Promise<PolicyDecision> {
    const decide = (
      result: PolicyDecision["result"],
      reason: string,
      rule: string
    ): PolicyDecision => ({
      result,
      reason,
      rule,
      intent,
    });

    // 1. Transaction type restriction
    const typeAllowed = this.rules.txTypeRestrictions[intent.type];
    if (typeAllowed !== true) {
      return decide("deny", `Transaction type '${intent.type}' is not permitted`, "txTypeRestrictions");
    }

    const amount = extractAmount(intent);
    const asset = extractAsset(intent);

    // 2. Per-transaction max amount
    if (amount !== null) {
      const maxForAsset = this.rules.maxTxAmount[asset] ?? this.rules.maxTxAmount["native"];
      if (maxForAsset && compareAmounts(amount, maxForAsset) > 0) {
        return decide("deny", `Amount ${amount} ${asset} exceeds max_tx_amount ${maxForAsset}`, "maxTxAmount");
      }
    }

    // 3. Daily spending limit (requires persisted activity data)
    if (amount !== null && this.activityStore) {
      const dailyLimit = this.rules.dailySpendingLimit[asset] ?? this.rules.dailySpendingLimit["native"];
      if (dailyLimit) {
        const spent = await this.getDailySpent(asset, agentId);
        const limit = parseFloat(dailyLimit);
        const remaining = limit - spent;
        if (parseFloat(amount) > remaining) {
          return decide(
            "deny",
            `Amount ${amount} ${asset} exceeds daily limit: spent ${spent.toFixed(7)}, limit ${limit}, remaining ${remaining.toFixed(7)}`,
            "dailySpendingLimit"
          );
        }
      }
    }

    // 4. Approval threshold
    if (amount !== null) {
      const threshold = this.rules.requireHumanApprovalForAmountAbove;
      if (threshold && compareAmounts(amount, threshold) >= 0) {
        return decide("requires_approval", `Amount ${amount} ${asset} requires human approval (>= ${threshold})`, "approvalThreshold");
      }
    }

    // 5. Asset allowlist
    if (this.rules.allowedAssets.length > 0 && !this.rules.allowedAssets.includes(asset)) {
      return decide("deny", `Asset '${asset}' is not in allowed_assets`, "allowedAssets");
    }

    // 6. Destination allowlist (payments only)
    if (intent.type === "payment" && this.rules.allowedDestinations.length > 0) {
      if (!this.rules.allowedDestinations.includes(intent.destination)) {
        return decide("deny", `Destination '${intent.destination}' not in allowed_destinations`, "allowedDestinations");
      }
    }

    // 7. Contract ID allowlist (contract calls only)
    if (intent.type === "contract_call" && this.rules.allowedContractIds.length > 0) {
      if (!this.rules.allowedContractIds.includes(intent.contractId)) {
        return decide("deny", `Contract '${intent.contractId}' not in allowed list`, "allowedContractIds");
      }
    }

    return decide("allow", "All policy checks passed", "default");
  }

  /**
   * Calculates the total amount of `asset` spent by the agent today
   * (UTC day boundary), based on submitted activities.
   *
   * Only activities with status "submitted" are counted. Pending, rejected,
   * and failed activities do NOT count toward the daily limit.
   */
  private async getDailySpent(asset: string, agentId: string): Promise<number> {
    if (!this.activityStore) return 0;

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfDayIso = startOfDay.toISOString();

    const activities = await this.activityStore.listByAgent(agentId, 200);

    let total = 0;
    for (const activity of activities) {
      // Only count submitted transactions
      if (activity.status !== "submitted") continue;
      // Only count transactions within the current UTC day
      if (activity.createdAt < startOfDayIso) continue;
      // Only count the same asset
      const activityAsset = extractAsset(activity.intent);
      if (activityAsset !== asset) continue;
      const amount = extractAmount(activity.intent);
      if (amount !== null) {
        total += parseFloat(amount);
      }
    }

    return total;
  }
}

function extractAmount(intent: AgentIntent): string | null {
  if (intent.type === "payment") return intent.amount;
  if (intent.type === "trustline" && intent.limit) return intent.limit;
  return null;
}

function extractAsset(intent: AgentIntent): string {
  if (intent.type === "payment") {
    if (intent.assetDetails) {
      if (intent.assetDetails.code === "XLM") return "XLM";
      return `${intent.assetDetails.code}:${intent.assetDetails.issuer}`;
    }
    return intent.asset;
  }
  if (intent.type === "trustline") {
    return `trustline:${intent.assetCode}:${intent.issuer}`;
  }
  return "native";
}

function compareAmounts(a: string, b: string): number {
  const pa = parseFloat(a);
  const pb = parseFloat(b);
  if (isNaN(pa) || isNaN(pb)) return 0;
  return pa > pb ? 1 : pa < pb ? -1 : 0;
}

interface ActivityRecord {
  id: string;
  agentId: string;
  intent: AgentIntent;
  status: string;
  createdAt: string;
}
