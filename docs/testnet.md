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
# 1. Generate a keypair (using any Stellar SDK)
# Example with @stellar/stellar-base:
node -e "const {Keypair}=require('@stellar/stellar-base'); const k=Keypair.random(); console.log(k.publicKey()); console.log(k.secret()); "

# 2. Fund the public key via friendbot:
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"
```

## Verify connectivity

The `StellarAdapter` in `packages/agent-core/src/` has a `getNetworkInfo()` method that queries Horizon. You can test it:

```bash
cd packages/agent-core
npx tsx -e "import { StellarAdapter } from './src/index.ts'; const a=new StellarAdapter('https://horizon-testnet.stellar.org'); console.log(await a.getNetworkInfo()); "
```

## Funding in CI

For automated tests, use the friendbot to fund test accounts. The test suite (`tests/`) includes helpers for this.
