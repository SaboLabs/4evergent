import { Horizon, type Transaction } from "@stellar/stellar-sdk";

/**
 * Submitter — broadcasts a signed Stellar transaction to the network.
 *
 * SUBMISSION PRECONDITIONS (enforced by the pipeline, NOT by this class):
 *   1. Intent passed IntentValidator
 *   2. PolicyEngine returned allow (no approval required) or approved
 *   3. StellarSimulator.simulate() returned success
 *   4. The Signer signed the transaction
 *   5. This is the ONLY code path that calls submitTransaction()
 *
 * This class performs no signing — it accepts an already-signed Transaction.
 */
export class StellarSubmitter {
  private server: Horizon.Server;

  constructor(horizonUrl: string) {
    this.server = new Horizon.Server(horizonUrl);
  }

  /**
   * Submits a signed transaction to the Stellar network.
   *
   * @param signedTransaction  A signed Transaction object (MUST be signed).
   * @returns The transaction hash on success.
   * @throws Error if Horizon rejects the transaction.
   */
  async submit(signedTransaction: Transaction): Promise<{ hash: string; ledger: number }> {
    // Verify the transaction has at least one signature — this is a sanity
    // check; the real gate is the pipeline not calling submit() on unsigned
    // transactions.
    const envelope = signedTransaction.toEnvelope();
    const signatures = envelope.v1().signatures;

    if (signatures.length === 0) {
      throw new Error(
        "StellarSubmitter: transaction has no signatures — signing required before submission"
      );
    }

    try {
      const result = await this.server.submitTransaction(signedTransaction);
      return {
        hash: result.hash,
        ledger: result.ledger,
      };
    } catch (e: any) {
      // Horizon returns detailed error info on failure. We surface it so the
      // pipeline can record it and surface it to the operator.
      const detail = e?.response?.data?.detail ?? e?.message ?? "unknown submission error";
      throw new Error(`StellarSubmitter: submission failed: ${detail}`);
    }
  }
}
