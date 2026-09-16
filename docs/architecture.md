# Architecture Decisions

All decisions recorded via the ADR-lite convention. Each entry: **Status | Context | Decision | Consequences.**

## ADR-001: Monorepo with pnpm workspaces

**Status:** Accepted  
**Context:** Need independent contributor workflows across frontend, backend, policy engine, Stellar adapter, shared types, and Soroban contracts.  
**Decision:** Use a pnpm-workspace monorepo at the root with `apps/` and `packages/` layout.  
**Consequences:** Enables independent versioning, incremental builds, and clear ownership boundaries. Soroban contracts live in `contracts/` with their own Cargo workspace.

## ADR-002: Policy engine is pure & deterministic

**Status:** Accepted  
**Context:** The LLM must never have unrestricted wallet authority. Authorization must be separable and auditable.  
**Decision:** Policy engine (`packages/policy`) is a pure function: `evaluate(intent, agentAddress) => PolicyDecision`. No network, no LLM, no randomness. Rules are data (allowlists, limits, thresholds).  
**Consequences:** Policy decisions are fully testable and reproducible. New rules added as data, not code paths.

## ADR-003: Intent-first, never raw transactions

**Status:** Accepted  
**Context:** If the LLM can produce arbitrary transaction blobs, it can bypass the policy layer.  
**Decision:** The LLM produces intents (typed schema). The Stellar adapter constructs transactions from validated intents. No raw blob acceptance from the LLM path.  
**Consequences:** All on-chain actions are schema-bound and policy-checked.

## ADR-004: Simulation before signing

**Status:** Accepted  
**Context:** Transactions should not be signed if they will fail on-chain.  
**Decision:** Every transaction is simulated against the testnet before signing. Simulation results (fee, warnings, errors) are recorded in the activity log.  
**Consequences:** Reduces failed transactions and wasted fees. Simulation failures abort the pipeline.

## ADR-005: Testnet-first, no mainnet assumptions in MVP

**Status:** Accepted  
**Context:** MVP must be safe to deploy and iterate on without risking real value.  
**Decision:** All Stellar interactions default to testnet (`https://horizon-testnet.stellar.org`). Mainnet config is a deploy-time environment variable, never a code assumption.  
**Consequences:** Contributors can run the full pipeline locally without real XLM.

## ADR-006: No project token in MVP

**Status:** Accepted  
**Context:** Tokenomics distracts from the core agent-permission problem and introduces speculative risk.  
**Decision:** MVP contains no token, no token sale, no bonding curve, no speculative mechanics. All actions use XLM or native testnet assets.  
**Consequences:** Avoids regulatory surface and keeps focus on the permissioned-execution layer.

## ADR-007: Node 26 + tsx for test runner

**Status:** Accepted  
**Context:** Node.js 26 ESM requires explicit `.ts` extensions for local imports when running via tsx without a bundler.  
**Decision:** All intra-project relative imports use `.ts` extensions. Test runner is `tsx --test`.  
**Consequences:** Tests run without a separate build step. Production build uses `tsc` which rewrites extensions appropriately, or a bundler handles it.

## ADR-008: Signer abstraction, never LLM-held keys

**Status:** Accepted  
**Context:** A server-held private key that the LLM can ask to sign anything defeats the purpose of the policy engine. The backend must NEVER give the LLM direct signing authority.  
**Decision:** The `Signer` interface abstracts signing authority. The pipeline holds a `Signer` reference; callers never receive one. Initial implementation is `TestnetLocalSigner` (testnet-only, env-loaded, never exposed to LLM). Future implementations (user-wallet, permissioned-agent, hardware/KMS) plug in via the same interface.  
**Consequences:** The LLM can propose intents but cannot sign. Signing is a capability, not a function the LLM can call. Production wallets are swappable without touching the pipeline.

## ADR-009: Transaction pipeline as a single ordered gate chain

**Status:** Accepted  
**Context:** Multiple gates (validation → policy → authorization → construction → simulation → signing → submission) must run in order. Any shortcut (e.g., allowing callers to invoke the signer directly) creates a bypass.  
**Decision:** `TransactionPipeline.execute()` is the ONLY public entry point. It runs each gate in sequence and stops at the first failure. No individual step is exposed as a public method that callers can chain arbitrarily.  
**Consequences:** The gate order is structural, not conventional. Tests can prove that a policy DENY, a failed simulation, or an approval-required state cannot reach the signer.

## ADR-010: Activity log records decisions, not secrets

**Status:** Accepted  
**Context:** The activity log must be auditable (shareable with operators, displayed in the UI) but must never leak key material.  
**Decision:** `ActivityRecord` stores `policyDecision`, `authorizationStatus`, `simulationResult`, `txHash`, and `error`. It has NO field for private keys, seeds, or mnemonics. The store's `record()` method runs `assertNoSecrets()` before persisting.  
**Consequences:** The activity log can be safely returned through the API and shown in the frontend without redaction.

## ADR-011: SQLite-backed persistence via node:sqlite

**Status:** Accepted
**Context:** Phase 3 needs durable activity and approval storage without introducing an external database dependency.
**Decision:** `SQLiteActivityStore` and `SQLiteApprovalStore` in `packages/database/src/sqlite-store.ts` use Node.js built-in `node:sqlite` (`DatabaseSync`). Schema is versioned in `_meta` (version 1). The default API server auto-selects SQLite when `dbPath` is provided; otherwise falls back to in-memory stores. No external `better-sqlite3` or server process.
**Consequences:** Single dependency (Node.js stdlib), file-backed persistence with cross-restart durability tested via reopen simulation. `initSchema()` idempotent. Partial unique index `idx_approvals_activity_one` enforces one PENDING_APPROVAL per activity.

## ADR-012: Persistent Execution Queue for Retry & Dead-Letter

**Status:** Accepted | Phase 9 | 2026-09-16

**Context:** Phase 8 used `setImmediate` for fire-and-forget execution after approval. If the process exits or execution throws, the approval stays in `approved`/`executing` state with no retry or recovery. Scheduled intents also had no persistent execution record.

**Decision:** Introduce `ExecutionStore` (InMemory + SQLite via `node:sqlite`) and `ExecutionQueue` that:
- Persists execution records with full state: `queued → executing → submitted → confirmed → failed → dead_letter`
- Retries transient failures (network/Horizon/submission errors) with exponential backoff (baseDelayMs \* 2^attempt, capped at maxDelayMs)
- Moves permanent failures (policy deny, invalid intent, validation error) directly to `dead_letter`
- Bounded retries: max 3 (configurable) after which execution moves to `dead_letter`
- Duplicate safety: claims via status check (executing records are skipped), suitable for single-process SQLite architecture
- Owner-scoped: all execution records are tied to `ownerId`, endpoints enforce owner isolation via `getForOwner/listByOwner`
- Crash recovery: records in `failed` state with `nextRetryAt` are picked up on restart via `listDue`
- Approval boundary: execution records carry `approvalId`; the queue does NOT bypass approval — it only executes after approval has been recorded

**Consequences:**
- Execution state survives process restarts (when SQLite store is configured)
- Transient failures are automatically retried with backoff
- Permanent failures are visible in `dead_letter` for manual intervention
- Scheduler (Phase 8) and approval flow both enqueue through the same queue
- Exactly-once is not guaranteed (single-process SQLite provides at-most-once deduplication via status claims); document as known limitation
- Records in `executing` at crash time are stuck — a recovery scan on startup can re-queue them (deferred to future phase)
