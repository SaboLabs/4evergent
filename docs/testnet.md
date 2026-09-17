# Testnet Setup Guide

## Prerequisites

- **Node.js >= 22** (required for `node:sqlite` built-in module)
- **pnpm >= 9** (workspace package manager)
- Rust toolchain (for Soroban contracts, Phase 3+)

## Full Testnet Execution Workflow

### 1. Install dependencies

```bash
pnpm install --frozen-lockfile
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your testnet credentials
```

### 3. Verify Horizon Testnet connectivity

```bash
# Run live smoke test (no secrets required, only reads Horizon root)
npx tsx packages/stellar/test/live-smoke.ts
```

This verifies:
- Horizon endpoint is reachable
- Network passphrase matches Testnet
- StellarSimulator can call real Horizon API (simulation gate works)

### 4. Configure Testnet account

```bash
# Generate a testnet keypair
node -e "const {Keypair}=require('@stellar/stellar-sdk'); const k=Keypair.random(); console.log('Public:', k.publicKey()); console.log('Secret:', k.secret());"

# Fund the account via friendbot
curl "https://friendbot.stellar.org?addr=<YOUR_PUBLIC_KEY>"

# Set environment
export STELLAR_TESTNET_SECRET_KEY=<YOUR_SECRET_KEY>
```

### 5. Verify account funding

```bash
node -e "
const {StellarAdapter} = require('./packages/agent-core/dist/index.js');
const a = new StellarAdapter('https://horizon-testnet.stellar.org');
a.getAccount('<YOUR_PUBLIC_KEY>').then(acc => {
  console.log('Address:', acc.address);
  console.log('Sequence:', acc.sequence);
  console.log('Balances:', acc.balances);
});
"
```

### 6. Run tests (deterministic, no secrets required)

```bash
pnpm test  # 195 tests PASS
```

### 7. Run simulation (no submission)

```bash
# Start API server (without LIVE_SUBMIT)
pnpm --filter @4evergent/api start

# Submit intent for simulation/approval
curl -X POST http://localhost:3000/agents/<agent-id>/intents \
  -H "Content-Type: application/json" \
  -d '{"type":"payment","asset":"XLM","destination":"G...","amount":"0.001","reason":"test"}'
```

Intent will be simulated against real Testnet Horizon. If policy allows and no approval required, it will be submitted ONLY if `LIVE_SUBMIT=1`.

### 8. Enable live submission (explicit)

```bash
# Stop server, restart with LIVE_SUBMIT=1
LIVE_SUBMIT=1 pnpm --filter @4evergent/api start
```

### 9. Execute Testnet transaction

With `LIVE_SUBMIT=1`, intents that pass policy + simulation + approval will be signed and submitted to Testnet.

### 10. Verify transaction status

```bash
curl http://localhost:3000/agents/<agent-id>/executions
```

Or check on [Stellar Expert](https://stellar.expert/explorer/testnet) with your txHash.

## Live Smoke Test

```bash
# Without secrets — only verify network + simulation
npx tsx packages/stellar/test/live-smoke.ts

# With secrets + LIVE_SUBMIT — full pipeline with real transaction
STELLAR_TESTNET_SECRET_KEY=S... LIVE_SUBMIT=1 npx tsx packages/stellar/test/live-smoke.ts
```

## Testnet Local Signer

`TestnetLocalSigner` (`packages/stellar/src/testnet-local-signer.ts`) is development infrastructure. It:
- Loads a secret key from `STELLAR_TESTNET_SECRET_KEY`
- Is testnet-only (the pipeline asserts the network passphrase matches)
- Never exposes the secret key through any method
- Never returns the secret key through the `Signer` interface
- Is never returned through API responses
- Is never logged

## Safety Guards (Phase 21)

- **Network validation**: Only Testnet URL + passphrase accepted. Mainnet explicitly rejected.
- **Live submission gate**: `LIVE_SUBMIT=1` required. Default = disabled.
- **Secret isolation**: Private key never in database, logs, API responses, error messages.
- **Atomic claim**: `updateIfStatus(queued→executing)` CAS prevents concurrent execution.
- **Idempotency**: `Idempotency-Key` header prevents duplicate financial execution.
- **Pre-check**: Horizon lookup before blind retry prevents duplicate submission.

## Known Limitations

- Only Stellar Testnet supported. Mainnet execution not supported.
- Exactly-once not guaranteed (Stellar classic limitation).
- Single-process architecture (no distributed workers).
- Production authentication not implemented.
- No live transaction has been executed by CI. All tests use deterministic mocks.
