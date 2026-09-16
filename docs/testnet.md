# Testnet Setup Guide

## Prerequisites

- Node.js >= 20 with pnpm
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
pnpm test  # all packages, 55 tests (16+3+9+1+11+15)
```

Integration tests run against in-memory HTTP servers with deterministic mocks. No live testnet calls are made by CI tests. A separate live testnet smoke test can be added when useful.

## Testnet Local Signer

`TestnetLocalSigner` (`packages/stellar/src/testnet-local-signer.ts`) is development infrastructure. It:

- Loads a secret key from `STELLAR_TESTNET_SECRET_KEY`
- Is testnet-only (the pipeline asserts the network passphrase matches)
- Never exposes the secret key through any method
- Never returns the secret key through the `Signer` interface
- Is never returned through API responses
- Is never logged

It exists for controlled development/testing against the Stellar **testnet only**. It is NOT the final wallet architecture.
