# 4evergent

**4evergent** — Autonomous AI Agents on Stellar.

An open-source framework for deploying AI agents that hold permissioned Stellar wallets and execute on-chain actions through a deterministic authorization pipeline. The agent's LLM proposes *intents*, and an independent policy engine decides whether each intent is allowed, denied, or requires human approval.

> **Testnet-first.** No mainnet assumptions in the MVP. No project token. No speculative tokenomics.

---

## Table of Contents

1. [What 4evergent is](#what-4evergent-is)
2. [Why AI agents need permissioned blockchain actions](#why-ai-agents-need-permissioned-blockchain-actions)
3. [Why Stellar](#why-stellar)
4. [Architecture](#architecture)
5. [Security model](#security-model)
6. [Local development](#local-development)
7. [Testnet setup](#testnet-setup)
8. [Adding a new agent capability](#adding-a-new-agent-capability)
9. [Roadmap](#roadmap)

---

## What 4evergent is

4evergent is a framework for running AI agents — software entities with an LLM-driven decision layer — that can act on the Stellar network. Each agent has a persistent identity, a Stellar address, and a set of declared capabilities.

The key invariant: **the LLM never holds unrestricted authority over a wallet.** The LLM produces a strongly typed intent. That intent flows through:

```
Agent → Intent → Schema validation → Policy evaluation
→ Stellar transaction construction → Simulation → Approval gate
→ Signing → Submission → Confirmation → Activity record
```

A deterministic policy engine — independent of the LLM — decides authorization. Transactions are simulated before signing. Spending limits, allowed assets, allowed contract IDs, and approval thresholds are explicit.

## Why AI agents need permissioned blockchain actions

An autonomous LLM with direct wallet access can be manipulated, jailbroken, or simply drift toward unintended behavior. Giving an LLM unrestricted signing authority is equivalent to handing a stranger your private key.

4evergent enforces a strict separation of concerns:
- **LLM layer**: produces natural-language intents translated into typed schema.
- **Policy layer**: deterministic rules evaluate every intent — no ML, no heuristics.
- **Execution layer**: simulation-first, with human-in-the-loop for high-value actions.

This lets agents act autonomously within a bounded envelope, while the owner retains control over spending, destination, and asset restrictions.

## Why Stellar

Stellar is purpose-built for asset issuance and payments with native low-fee, fast-finality design. Its architecture is ideal for an agent economy:

- **Native asset**: XLM settles any action without wrapping.
- **Federated consensus**: no proof-of-stake staking requirements.
- **Soroban smart contracts**: WASM-based, memory-safe, with native support for complex contracts.
- **Built-in token standard**: no Solidity-style approval race conditions for basic payments.
- **Low, predictable fees**: cents or less per operation.

## Architecture

```
4evergent/
├── apps/
│   ├── web/              # React + TS frontend (agent dashboard)
│   └── api/              # Express-style backend API
├── packages/
│   ├── agent-core/       # Agent runtime, intent validation, Stellar adapter
│   ├── policy/           # Deterministic authorization engine
│   ├── stellar/          # Transaction construction + simulation helpers
│   ├── database/         # DB schema/ORM client
│   └── shared/           # Shared types & schemas
├── contracts/
│   ├── agent-registry/   # Soroban contract (agent identity on-chain)
│   └── permissions/      # Soroban authorization primitives
├── docs/
├── tests/
├── scripts/
└── README.md
```

**MVP vertical slice** (verified, runnable):

```
Create Agent → Persist Agent → Display Agent → Read Stellar Account
→ Generate Payment Intent → Evaluate Policy → Simulate Transaction
→ Require Approval → Execute on Testnet → Record Activity
```

Everything outside this slice is marked as **Future Work** in source comments.

## Security model

See [docs/security-model.md](docs/security-model.md) for the full write-up.

Key guarantees:
- **No unrestricted wallet authority**: the LLM cannot sign or broadcast directly.
- **Policy engine is independent**: pure functions, no network or LLM calls.
- **Simulation before execution**: every transaction is simulated against the testnet before signing.
- **Explicit allowlists**: assets, destinations, contract IDs, and transaction types are deny-by-default.
- **Spending limits**: per-transaction and per-day ceilings per asset.
- **Approval thresholds**: amounts above a configurable limit require human approval.
- **Key management**: private keys never in source, env examples, logs, or tests.
- **Frontend/backend trust boundary**: the frontend never receives secret material; all signing happens server-side through a hardened path.

## Local development

```bash
# clone
git clone https://github.com/SaboLabs/4evergent
cd 4evergent

# install
pnpm install

# build all packages (bottom-up)
pnpm build

# run tests
pnpm test
```

Each package has its own `package.json` with `build`, `dev`, `test`, and `typecheck` scripts.

## Testnet setup

```bash
# The Stellar adapter defaults to testnet
export STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org

# Generate a testnet keypair (funded via friendbot):
#   curl "https://friendbot.stellar.org?addr=<PUBLIC_KEY>"
```

The MVP is validated against the testnet Horizon API. See [docs/testnet.md](docs/testnet.md) for details.

## Adding a new agent capability

1. Add the new intent type to `packages/shared/src/index.ts` (extend the `AgentIntent` union).
2. Add validation logic to `IntentValidator` in `packages/agent-core/src/`.
3. Add a corresponding policy rule entry in `packages/policy/src/types.ts`.
4. Add the transaction builder in `packages/stellar/src/`.
5. Write unit + integration tests for steps 2–4.
6. Document the capability in `docs/capabilities.md`.

No capability is considered complete without: schema validation, policy coverage, intent test, and a negative policy-engine test.

## Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| 1 | Agent identity, policy engine, intent validation, Stellar read adapter, activity logging | ✅ MVP slice |
| 2 | Full transaction pipeline (construct → simulate → sign → submit) on testnet | Future |
| 3 | Soroban AgentRegistry contract (register/update/deactivate/query) | Future |
| 4 | Soroban Permissions contract (delegation + revocation) | Future |
| 5 | Frontend agent dashboard (discover, profile, activity) | Future |
| 6 | Multi-agent capability discovery & economy | Future |

---

## License

MIT. See [LICENSE](LICENSE).
