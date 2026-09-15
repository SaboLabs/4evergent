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
