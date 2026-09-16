# 4evergent Development Roadmap

| Phase | Goal | Status |
|-------|------|--------|
| 1 | Agent identity types, policy engine, intent validation, Stellar read adapter | Shipped |
| 2 | Full transaction pipeline (construct → simulate → authorize → sign → submit) with Signer abstraction | **Shipped (this phase)** |
| 3 | Soroban AgentRegistry contract (register/update/deactivate/query) | Scaffolded, not compiled |
| 4 | Soroban Permissions contract (delegation + revocation) | Scaffolded, not compiled |
| 5 | Frontend agent dashboard (discovery, profile, activity) | Future |
| 6 | Multi-agent capability discovery & agent-to-agent economy | Future |

## Phase 2 Details (Shipped)

### What was implemented

- **Signer interface** (`packages/stellar/src/signer.ts`): abstraction with `getAccountId()`, `getNetworkPassphrase()`, `sign()`. No key-exposing methods.
- **TestnetLocalSigner** (`packages/stellar/src/testnet-local-signer.ts`): testnet-only development signer. Loads from env, never exposes secrets, never committed.
- **StellarTransactionBuilder** (`packages/stellar/src/transaction-builder.ts`): constructs unsigned Stellar transactions from validated `PaymentIntent` only. Does NOT accept raw XDR or arbitrary operation arrays. MVP supports XLM payments only.
- **StellarSimulator** (`packages/stellar/src/simulator.ts`): mandatory simulation gate. Calls real Horizon API (`fetchBaseFee`, `accounts().accountId()`). No fake results. A failed simulation prevents signing.
- **StellarSubmitter** (`packages/stellar/src/submitter.ts`): submits signed transactions. Rejects unsigned transactions (no signatures).
- **TransactionPipeline** (`packages/stellar/src/pipeline.ts`): orchestrates the ordered gate chain — validate → policy → authorize → construct → simulate → sign → submit → record. The only public entry point.
- **Activity storage** (`packages/database/src/index.ts`): in-memory activity log with `assertNoSecrets()` guard. Records intent, policy decision, authorization status, simulation result, tx hash, status, timestamps.
- **API server** (`apps/api/src/index.ts`): `POST /agents/:id/intents` endpoint implementing the full pipeline. Returns 400 for malformed/raw input, 403 for policy DENY, 202 for requires_approval, 200 for submitted. `GET /health` endpoint.
- **Security tests** (16 tests): verify DENY prevents construction, failed simulation prevents signing, amount above limit never reaches signer, unauthorized asset/destination never reach signer, approval-required never reaches signer before approval, signer interface has no key-exposing methods, mainnet config cannot use TestnetLocalSigner.
- **Integration tests** (15 tests): verify API rejects raw XDR, returns 403 for denied intents, 202 for approval-required, 400 for unsupported intent types, records activity for all outcomes, never leaks secrets in responses.

### Known Limitations

- **Signer**: `TestnetLocalSigner` is testnet-only. `UserWalletSigner`, `AgentPermissionSigner`, `HardwareSigner`, `KmsSigner` are NOT implemented — the interface is ready but the implementations are deferred.
- **Approval storage**: No persistent approval store. The API returns `requires_approval` with in-memory state only. No `POST /agents/:id/intents/:activityId/approve` endpoint.
- **Activity persistence**: `InMemoryActivityStore` is process-local. Records are lost on process restart. A Postgres-backed implementation is planned.
- **Agent registry**: In-memory agent map in the API server. No persistent agent storage.
- **Simulation**: For classic (non-Soroban) transactions, Horizon has no dry-run API. Simulation checks sequence, fee, balance, and envelope validity — but signature correctness is only checked at submission time. For Soroban contract calls, the Soroban-RPC `simulateTransaction` endpoint should be used (not yet implemented).
- **Transaction types**: Only XLM payments are supported. Trustline, contract_call, and account_settings intents pass validation but return 400 from the API ("not yet supported by the transaction pipeline").
- **Mainnet**: Not tested. The pipeline asserts the network passphrase of the signer matches the signer passphrase, and `TestnetLocalSigner` is wired to the testnet passphrase in the pipeline constructor.
- **Soroban contracts**: Not compiled or tested. `contracts/` directory has scaffolded Cargo files.
- **Daily spending limit**: Policy evaluation does not track per-agent daily totals (the rule exists in the schema but is not enforced with state — it would require persisting spent amounts per agent per day).

### Live Testnet Calls

No live Stellar testnet calls were executed during Phase 2 implementation. All tests use deterministic mocks and in-process HTTP servers. The simulation and submission code paths call real Horizon APIs, but they are only reachable through the pipeline after policy ALLOW (which the test suite gates via DENY or requires_approval). A separate live testnet smoke test should be added when a funded testnet account with real XLM is available.
