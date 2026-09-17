# Testnet Setup Guide

## Prerequisites

- Node.js >= 22 with pnpm
- Rust toolchain (for Soroban contracts, Phase 3+)

## Horizon endpoint

Default testnet endpoint:

```
https://horizon-testnet.stellar.org
```

Set via environment:

```bash
export STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
```

## Generate & fund a testnet account

```bash
# 1. Generate a keypair (using the Stellar SDK)
node -e "const {Keypair}=require('@stellar/stellar-sdk'); const k=Keypair.random(); console.log(k.publicKey()); console.log(k.secret()); "

# 2. Fund the public key via friendbot:
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
```

## Set the testnet secret key

The `TestnetLocalSigner` reads from the `STELLAR_TESTNET_SECRET_KEY` environment variable:

```bash
export STELLAR_TESTNET_SECRET_KEY=S...  # your testnet secret key
```

**WARNING:** Never commit this value. Never put it in `.env.example` or source code. Never log it. Never expose it through the API.

## Verify connectivity

The `StellarAdapter` in `packages/agent-core/src/stellar-adapter.ts` has a `getNetworkInfo()` method that queries Horizon. You can test it:

```bash
cd packages/agent-core
npx tsx -e "import { StellarAdapter } from './src/index.ts'; const a=new StellarAdapter('https://horizon-testnet.stellar.org'); console.log(await a.getNetworkInfo()); "
```

## Run the test suite

```bash
pnpm test  # all packages (195 tests: shared 3, agent-core 11, policy 15, database 8, stellar 8, api 138, web 12)
```

A React web dashboard is included (`apps/web`). Start it with `pnpm --filter @4evergent/web dev` (API must be running on port 3000). The dashboard is a local development tool — read-only views of agents/activity/approvals and an XLM payment intent form. All signing and policy enforcement happen on the backend.

Integration tests run against in-memory HTTP servers with deterministic mocks. No live testnet calls are made by CI tests. The SQLite stores are tested with on-disk temp files under `os.tmpdir()` and verified to survive store reopen (restart simulation). Live testnet submission has NOT been performed in this phase.

## Testnet Local Signer

`TestnetLocalSigner` (`packages/stellar/src/testnet-local-signer.ts`) is development infrastructure. It:

- Loads a secret key from `STELLAR_TESTNET_SECRET_KEY`
- Is testnet-only (the pipeline asserts the network passphrase matches)
- Never exposes the secret key through any method
- Never returns the secret key through the `Signer` interface
- Is never returned through API responses
- Is never logged

It exists for controlled development/testing against the Stellar **testnet only**. It is NOT the final wallet architecture.
