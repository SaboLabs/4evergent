import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentIntent } from "@4evergent/shared";

/**
 * TransactionBuilder — constructs a Stellar Transaction from a validated,
 * typed PaymentIntent.
 *
 * SECURITY: This builder accepts ONLY a PaymentIntent that has already passed
 * IntentValidator and PolicyEngine. It does NOT accept raw XDR, transaction
 * blobs, or arbitrary operation arrays from the LLM.
 *
 * MVP scope: payment only (native XLM). Trustline, contract_call, and
 * account_settings are validated by IntentValidator but NOT yet supported by
 * the transaction pipeline — they will be added in later phases.
 */
export class StellarTransactionBuilder {
  /**
   * Builds an unsigned Transaction from a validated payment intent.
   *
   * @param sourceAccount  The Stellar account object (from Horizon) for the agent.
   * @param intent         A validated PaymentIntent.
   * @param networkPassphrase  The Stellar network passphrase.
   * @returns An unsigned Transaction object (ready for simulation).
   */
  async buildPayment(
    sourceAccount: Account,
    intent: PaymentIntent,
    networkPassphrase: string
  ): Promise<Transaction> {
    if (intent.type !== "payment") {
      throw new Error(
        `StellarTransactionBuilder: expected payment intent, got ${intent.type}`
      );
    }

    const amount = intent.amount.trim();
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      throw new Error("StellarTransactionBuilder: amount must be a positive number");
    }

    const destination = intent.destination.trim();
    if (!destination || !destination.startsWith("G")) {
      throw new Error("StellarTransactionBuilder: destination must be a valid Stellar account");
    }

    // MVP: payment only supports XLM (native). Non-XLM assets would require
    // trustline handling which is NOT yet supported in the transaction pipeline.
    if (intent.asset !== "XLM") {
      throw new Error(
        `StellarTransactionBuilder: unsupported asset '${intent.asset}'. MVP supports XLM only.`
      );
    }
    const asset = Asset.native();

    const paymentOp = Operation.payment({
      destination,
      asset,
      amount,
    });

    const builder = new TransactionBuilder(sourceAccount, {
      networkPassphrase,
      fee: "100000", // 0.01 XLM base fee — will be replaced by simulation
    });
    builder.addMemo(Memo.text(truncateToMemo(intent.reason)));
    builder.addOperation(paymentOp);
    builder.setTimeout(30);

    return builder.build();
  }
}

/**
 * Truncates a string to fit in a Stellar MemoText (28 bytes).
 * Byte-safe: handles multibyte characters correctly.
 */
function truncateToMemo(text: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= 28) return text;
  // Walk back so we don't split a multibyte UTF-8 sequence mid-character.
  let cutoff = 28;
  while (cutoff > 0 && (encoded[cutoff]! & 0xc0) === 0x80) cutoff--;
  return new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, cutoff));
}
