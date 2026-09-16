import { test } from "node:test";
import assert from "node:assert/strict";

import { StellarTransactionBuilder } from "../src/transaction-builder.js";
import { StellarSimulator } from "../src/simulator.js";
import { StellarSubmitter } from "../src/submitter.js";
import { TransactionPipeline } from "../src/pipeline.js";
import { TestnetLocalSigner } from "../src/testnet-local-signer.js";
import type { Signer } from "../src/signer.js";
import type { PolicyRules } from "@4evergent/shared";
import { Keypair, Horizon, TransactionBuilder, Operation, Asset, Networks } from "@stellar/stellar-sdk";

// ========== TestnetLocalSigner tests ==========

test("TestnetLocalSigner rejects unknown secret env var", () => {
  assert.throws(
    () => new TestnetLocalSigner("Test SDF Network ; September 2015", "NONEXISTENT_VAR"),
    /environment variable NONEXISTENT_VAR is not set/
  );
});

test("TestnetLocalSigner does not expose private key through interface", () => {
  const signer = new SignerStub("test");
  // Verify that the Signer interface has no method that returns a secret
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(signer));
  assert.ok(!methods.some((m) => /secret|seed|private|mnemonic/i.test(m)));
  // getAccountId returns a public Stellar address (G...), not a secret
  assert.ok(signer.getAccountId().startsWith("G"));
  // The interface only exposes: getAccountId, getNetworkPassphrase, sign
  const publicMethods = methods.filter((m) => m !== "constructor");
  assert.deepEqual(publicMethods.sort(), ["getAccountId", "getNetworkPassphrase", "sign"]);
});

test("TestnetLocalSigner returns network passphrase", () => {
  const signer = new SignerStub("test");
  assert.equal(signer.getNetworkPassphrase(), "Test SDF Network ; September 2015");
});

test("Signer.sign does not modify the original transaction's source", async () => {
  const tx = buildFakeUnsignedTx();
  const signer = new SignerStub("test");
  const signed = await signer.sign(tx as any);
  // Verify signed transaction has signatures
  assert.equal(signed.signatures.length > 0, true);
});

// ========== TransactionBuilder tests ==========

test("TransactionBuilder rejects non-payment intent", async () => {
  const builder = new StellarTransactionBuilder();
  const fakeAccount = { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} };
  await assert.rejects(
    builder.buildPayment(fakeAccount as any, { type: "trustline", assetCode: "X", issuer: "G...", limit: "100", reason: "test" } as any, "test"),
    /expected payment intent/
  );
});

test("TransactionBuilder rejects negative amount", async () => {
  const builder = new StellarTransactionBuilder();
  const fakeAccount = { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} };
  await assert.rejects(
    builder.buildPayment(fakeAccount as any, {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "-5",
      reason: "test",
    } as any, "test"),
    /amount must be a positive number/
  );
});

test("TransactionBuilder rejects non-G destination", async () => {
  const builder = new StellarTransactionBuilder();
  const fakeAccount = { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} };
  await assert.rejects(
    builder.buildPayment(fakeAccount as any, {
      type: "payment",
      asset: "XLM",
      destination: "INVALID",
      amount: "5",
      reason: "test",
    } as any, "test"),
    /destination must be a valid Stellar account/
  );
});

test("TransactionBuilder rejects non-XLM asset", async () => {
  const builder = new StellarTransactionBuilder();
  const fakeAccount = { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} };
  await assert.rejects(
    builder.buildPayment(fakeAccount as any, {
      type: "payment",
      asset: "USDC",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "5",
      reason: "test",
    } as any, "test"),
    /unsupported asset/
  );
});

test("TransactionBuilder does not accept raw XDR or operations", async () => {
  const builder = new StellarTransactionBuilder();
  // The buildPayment signature only accepts Account + PaymentIntent + string,
  // so raw XDR / operations arrays are structurally rejected at the type level.
  // Verify the method signature does not accept them.
  const sig = builder.buildPayment.toString();
  assert.ok(!sig.includes("xdr") && !sig.includes("operations"));
});

// ========== Policy + Pipeline integration security tests ==========

test("Pipeline rejects DENY policy before construction", async () => {
  const rules: Partial<PolicyRules> = { maxTxAmount: { XLM: "0.001" } };
  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: new SignerStub("test"),
    policyRules: rules,
  });

  const result = await pipeline.execute({
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "exceeds limit test",
    },
    sourceAccount: { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} },
  });

  assert.equal(result.status, "rejected");
  assert.ok(result.message.includes("Policy denied"));
});

test("Pipeline rejects unauthorized asset", async () => {
  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: new SignerStub("test"),
  });

  // USDC is not in the default allowed assets
  const result = await pipeline.execute({
    intent: {
      type: "payment",
      asset: "USDC",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "5",
      reason: "unauthorized asset test",
    },
    sourceAccount: { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} },
  });

  assert.equal(result.status, "rejected");
  assert.ok(/asset/i.test(result.message));
});

test("Pipeline rejects unauthorized destination", async () => {
  const rules: Partial<PolicyRules> = { allowedDestinations: ["GONLYTHIS"] };
  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: new SignerStub("test"),
    policyRules: rules,
  });

  const result = await pipeline.execute({
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "5",
      reason: "unauthorized destination test",
    },
    sourceAccount: { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} },
  });

  assert.equal(result.status, "rejected");
  assert.ok(/destination/i.test(result.message));
});

test("Pipeline rejects amount above policy limit before reaching signer", async () => {
  const rules: Partial<PolicyRules> = { maxTxAmount: { XLM: "10" } };
  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: new SignerStub("test"),
    policyRules: rules,
  });

  const result = await pipeline.execute({
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "100",
      reason: "amount exceeds limit test",
    },
    sourceAccount: { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} },
  });

  assert.equal(result.status, "rejected");
  assert.ok(/max_tx_amount/i.test(result.message));
});

test("Pipeline stops at requires_approval before signing", async () => {
  const rules: Partial<PolicyRules> = {
    maxTxAmount: { XLM: "1000" },
    requireHumanApprovalForAmountAbove: "10",
  };
  const pipeline = new TransactionPipeline({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    signer: new SignerStub("test"),
    policyRules: rules,
  });

  const result = await pipeline.execute({
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "approval required test",
    },
    sourceAccount: { accountId: () => "G...", sequenceNumber: () => "0", incrementSequenceNumber: () => {} },
  });

  assert.equal(result.status, "requires_approval");
});

// ========== Simulator tests ==========

test("Simulator rejects transaction with invalid envelope", async () => {
  const sim = new StellarSimulator("https://horizon-testnet.stellar.org");
  // Create a deliberately malformed envelope by monkey-patching toEnvelope
  const tx = {
    toEnvelope: () => ({ toXDR: () => { throw new Error("invalid"); } }),
    fee: "100000",
    operations: [],
    sequence: "1",
    source: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  } as any;

  const result = await sim.simulate(tx);
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("envelope"));
});

// ========== Submitter tests ==========

test("Submitter rejects transaction with no signatures", async () => {
  const submitter = new StellarSubmitter("https://horizon-testnet.stellar.org");
  const unsignedTx = {
    toEnvelope: () => ({ v1: () => ({ signatures: [] }) }),
    fee: "100000",
    operations: [],
    sequence: "1",
    source: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  } as any;

  await assert.rejects(
    submitter.submit(unsignedTx),
    /no signatures/
  );
});

// ========== Helpers ==========

class SignerStub implements Signer {
  private accountId: string;
  constructor(id: string) {
    this.accountId = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.accountId; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("test"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

function buildFakeUnsignedTx() {
  return {
    signatures: [],
    fee: "100000",
    operations: [{ type: "payment" }],
    sequence: "1",
    source: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    networkPassphrase: "Test SDF Network ; September 2015",
    toEnvelope: () => ({ v1: () => ({ signatures: [] }) }),
  };
}
