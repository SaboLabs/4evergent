# Security Model

## Threat Model

| Threat | Mitigation |
|--------|-----------|
| LLM produces unintended/malicious intent | Intent schema validation + deterministic policy engine deny-by-default |
| Unauthorized transaction signing | Private keys never in source; signing isolated; simulation gate |
| Asset theft via unexpected asset | Allowed-assets allowlist (deny by default) |
| Funds sent to wrong/blacklisted destination | Allowed-destinations allowlist + destination format validation |
| Excessive spending | Per-tx and daily spending limits; approval threshold |
| Replay attacks | Stellar sequence numbers + timebounds on all transactions |
| Policy bypass via malformed intent | Strict schema validation before policy evaluation |
| Frontend compromise exposes secrets | Frontend never receives private keys; all signing server-side |
| Activity tampering | Activity records are append-only; hashed/checksummed |
| Contract call injection | Contract calls disabled by default; explicit allowlist required |

## Key Management

- **Never**: private keys in source code, environment example files, frontend code, logs, or tests.
- **Server-side**: keys loaded from a secrets manager or KMS at runtime, never committed.
- **Testnet**: ephemeral test keys generated via friendbot for development.
- **Production planning**: HSM or MPC-based signing with policy-gated access.

## LLM Authority Boundaries

The LLM's role is strictly **intent generation**:

```
LLM output (natural language) → Intent schema (typed, validated) → Policy engine → Transaction
```

The LLM:
- May NOT produce raw transaction envelopes or XDR.
- May NOT choose which rules to apply.
- May NOT bypass policy evaluation.
- May NOT sign transactions directly.

The policy engine is a **pure function** with no dependency on the LLM or any external state except the explicit rule set.

## Policy Enforcement

Rules are evaluated in order:

1. **Transaction type restriction** — is this intent type allowed at all? (deny by default)
2. **Amount checks** — exceeds per-tx max? daily limit? requires approval?
3. **Asset allowlist** — is the asset permitted?
4. **Destination allowlist** — is the destination permitted? (payments only)
5. **Contract ID allowlist** — is the contract permitted? (contract calls only)

A single deny short-circuits to `deny`. Amounts at or above the approval threshold return `requires_approval`, routing to a human review queue.

## Transaction Simulation

Every intent that passes policy evaluation enters the **simulation gate**:

1. Construct the transaction (unsigned) from the validated intent.
2. Call `horizon simulate` (testnet).
3. If simulation succeeds: record fee, warnings, operation count. Proceed to approval gate.
4. If simulation fails: record error, abort. Activity status = `failed`.

Simulation is also the primary defense against gas-limit and balance issues surfacing at signing time.

## Replay Protection

Stellar's native sequence numbers are used. Each transaction includes:
- Current account sequence number
- Timebounds (valid window)
- (Future) Memo for intent correlation

## Spending Limits

| Limit | Default | Scope |
|-------|---------|-------|
| `maxTxAmount` | 100 XLM | Per-transaction |
| `dailySpendingLimit` | 500 XLM | Per-agent per-day |
| `approvalThreshold` | 50 XLM | Amount at/above requires human approval |

Limits are configurable per-agent via policy rules. The policy engine is the single source of truth.

## Approval Flow

```
Intent passes policy → Simulation succeeds → Decision = requires_approval?
   → YES → Queue for human approval (owner or designated approver)
   → NO  → Proceed to signing
```

Approval state is recorded in the activity log. An approval is bound to a specific intent hash — it cannot be reused for a different intent.

## Emergency Disable Mechanism

(Future work in MVP, but planned as a core primitive)

- The policy engine reads rules from a config that can be hot-swapped.
- An emergency "kill switch" key (held by the deployment operator) can push an all-deny policy to all agents instantly.
- On-chain agent registry supports `deactivate_agent` to freeze an agent's wallet permissions.

## Frontend / Backend Trust Boundary

```
Frontend (web) ———— no secrets ————> Backend API (api)
   |                                      |
   |  reads public agent data             |  holds keys, policy engine,
   |  displays activity                  |  Stellar adapter, orchestrator
   |  submits intents for approval        |
```

The frontend NEVER receives:
- Private keys or seeds
- Raw signing capability
- Policy rule definitions (only the resulting decision)

All signing happens in the backend through a hardened, isolated path. The frontend can request approval status and view activity records, but cannot trigger signing directly.

## Logging & Audit Trail

Every action produces an `ActivityRecord`:

```
agentId | intent | policyDecision | simulationResult | txHash | status | timestamp | error
```

Records are append-only. In the MVP they are stored in the database; future work moves critical fields on-chain via the AgentRegistry contract.
