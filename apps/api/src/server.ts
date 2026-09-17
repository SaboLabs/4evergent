#!/usr/bin/env node
/**
 * 4evergent API server entry point.
 *
 * Usage:
 *   node apps/api/dist/server.js
 *
 * Environment:
 *   STELLAR_TESTNET_SECRET_KEY  — Testnet secret key (required for signing)
 *   STELLAR_HORIZON_URL         — Horizon URL (default: https://horizon-testnet.stellar.org)
 *   PORT                        — Server port (default: 3000)
 *   DATABASE_PATH               — SQLite file path (optional, in-memory if unset)
 *
 * LIVE_SUBMIT must be explicitly set to "1" to enable real Testnet submission.
 */

import { createApiServer } from "./index.js";
import { TestnetLocalSigner, TESTNET_HORIZON_URL } from "@4evergent/stellar";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

async function main() {
  const horizonUrl = process.env.STELLAR_HORIZON_URL || TESTNET_HORIZON_URL;
  const port = Number(process.env.PORT || 3000);
  const dbPath = process.env.DATABASE_PATH || undefined;

  // Validate network configuration at startup
  if (!horizonUrl.includes("testnet")) {
    console.error(
      `FATAL: STELLAR_HORIZON_URL must point to Testnet (got: ${horizonUrl}). Mainnet execution is not supported.`
    );
    process.exit(1);
  }

  let signer;
  try {
    signer = new TestnetLocalSigner(TESTNET_PASSPHRASE);
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }

  console.log(`[4evergent] Starting API server on port ${port}`);
  console.log(`[4evergent] Horizon: ${horizonUrl}`);
  console.log(`[4evergent] Network: Testnet`);
  console.log(`[4evergent] Signer: ${signer.getAccountId().slice(0, 12)}...`);
  console.log(`[4evergent] Database: ${dbPath ?? "in-memory"}`);
  console.log(`[4evergent] Live submission: ${process.env.LIVE_SUBMIT === "1" ? "ENABLED" : "disabled"}`);

  try {
    const server = await createApiServer({
      port,
      horizonUrl,
      signer,
      dbPath,
      executionQueue: { enabled: true },
      reconciliation: { enabled: true },
      requestContext: { ownerId: "operator" },
    });

    await server.listen(port);
    console.log(`[4evergent] Server listening on http://127.0.0.1:${port}`);
  } catch (err: any) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
}

void main();
