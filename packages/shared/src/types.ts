export type Network = "testnet" | "mainnet";

export interface Agent {
  id: string;
  displayName: string;
  description: string;
  owner: string;
  stellarAddress: string;
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
  active: boolean;
  metadata: Record<string, unknown>;
}

export type IntentType = "payment" | "trustline" | "contract_call" | "account_settings";

export interface PaymentIntent {
  type: "payment";
  asset: string;
  destination: string;
  amount: string;
  reason: string;
  memo?: string;
}

export interface TrustlineIntent {
  type: "trustline";
  assetCode: string;
  issuer: string;
  limit?: string;
  reason: string;
}

export interface ContractCallIntent {
  type: "contract_call";
  contractId: string;
  function: string;
  args: unknown[];
  reason: string;
}

export interface AccountSettingsIntent {
  type: "account_settings";
  setting: string;
  value: unknown;
  reason: string;
}

export type AgentIntent = PaymentIntent | TrustlineIntent | ContractCallIntent | AccountSettingsIntent;

export type PolicyResult = "allow" | "deny" | "requires_approval";

export interface PolicyDecision {
  result: PolicyResult;
  reason: string;
  rule: string;
  intent: AgentIntent;
}

export type ActivityStatus = "pending" | "simulated" | "approved" | "rejected" | "submitted" | "failed";

export interface ActivityRecord {
  id: string;
  agentId: string;
  intent: AgentIntent;
  policyDecision: PolicyDecision;
  simulationResult: SimulationResult | null;
  txHash: string | null;
  status: ActivityStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SimulationResult {
  success: boolean;
  fee: string;
  operations: number;
  warnings: string[];
  error?: string;
}

export interface StellarAccount {
  address: string;
  sequence: string;
  balances: Balance[];
  subentryCount: number;
  thresholds?: { low: number; med: number; high: number };
  signers?: Signer[];
  data?: Record<string, string>;
}

export interface Balance {
  asset: string;
  balance: string;
  limit?: string;
  buyingLiabilities?: string;
  sellingLiabilities?: string;
}

export interface Signer {
  key: string;
  weight: number;
  type: string;
}

export interface NetworkInfo {
  network: string;
  horizonUrl: string;
  passphrase: string;
  protocolVersion: number;
  coreVersion: string;
  ingestLatestLedger: number;
  historyLatestLedger: number;
  oldestLedger: number;
}
