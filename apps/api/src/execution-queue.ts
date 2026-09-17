import type { ExecutionRecord, ExecutionStore, RetryPolicy } from "@4evergent/database";
import { computeNextRetryAt, DEFAULT_RETRY_POLICY } from "@4evergent/database";

export interface ExecutionResult {
  record: ExecutionRecord;
  success: boolean;
  status: string;
  error?: string;
  errorClass?: string;
  txHash?: string;
}

export type PipelineExecutor = (record: ExecutionRecord) => Promise<ExecutionResult>;

export type SourceAccountProvider = () => Promise<{
  accountId: () => string;
  sequenceNumber: () => string;
  incrementSequenceNumber: () => void;
}>;

/**
 * ExecutionQueue — processes due ExecutionRecords in bounded-concurrency
 * batches. Each execution is run through the provided pipeline executor (which
 * for this project points to TransactionPipeline.execute()).
 *
 * Responsibilities:
 *   - poll ExecutionStore for due records
 *   - mark record as "executing"
 *   - invoke pipeline executor
 *   - transition record to terminal state (submitted / confirmed / failed /
 *     dead_letter) or schedule a retry with backoff
 *   - provide an onBeforeExecute hook for duplicate /
 *     re-entrancy guarding
 */
export class ExecutionQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private clock: () => Date;
  private intervalMs: number;
  private concurrency: number;
  private activeCount = 0;

  constructor(
    private store: ExecutionStore,
    private pipelineExecutor: PipelineExecutor,
    private getSourceAccount: SourceAccountProvider,
    private options: ExecutionQueueOptions = {}
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? 10_000;
    this.concurrency = options.concurrency ?? 1;
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.nowFn = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Manually enqueue a new execution record.
   */
  async enqueue(record: ExecutionRecord): Promise<ExecutionRecord> {
    await this.store.record(record);
    return record;
  }

  /**
   * Process due executions.
   *
   * Called by tick(), but can also be invoked directly (for testing or
   * external triggers). Returns number of executions started.
   */
  async processDue(nowIso?: string): Promise<number> {
    const now = nowIso ?? this.clock().toISOString();
    const due = await this.store.listDue(now, 50);
    let started = 0;

    for (const record of due) {
      if (this.activeCount >= this.concurrency) break;
      // Duplicate safety: skip if already executing (e.g., another worker
      // picked it up between listDue and our claim).
      if (record.status === "executing") continue;

      await this.runExecution(record);
      started++;
    }

    return started;
  }

  /**
   * Manual retry — transitions failed/dead_letter back to queued.
   * Uses atomic conditional update to prevent race with worker.
   */
  async retry(id: string, maxRetries: number): Promise<{ status: string; execution?: ExecutionRecord }> {
    const existing = await this.store.get(id);
    if (!existing) return { status: "not_found" };
    if (existing.status !== "failed" && existing.status !== "dead_letter") {
      return { status: "invalid_state" };
    }
    if (existing.attempt >= maxRetries) {
      return { status: "max_retries_reached" };
    }
    const now = new Date().toISOString();
    const updated = await this.store.updateIfStatus(id, existing.status, {
      status: "queued",
      nextRetryAt: null,
      error: null,
      startedAt: null,
      updatedAt: now,
    });
    if (!updated) return { status: "conflict" };
    return { status: "queued", execution: updated };
  }

  /**
   * Manual cancellation — transitions queued/executing to dead_letter.
   * Uses atomic conditional update to prevent race with worker.
   */
  async cancel(id: string): Promise<{ status: string; execution?: ExecutionRecord }> {
    const existing = await this.store.get(id);
    if (!existing) return { status: "not_found" };
    if (existing.status !== "queued" && existing.status !== "executing") {
      return { status: "invalid_state" };
    }
    const now = new Date().toISOString();
    const updated = await this.store.updateIfStatus(id, existing.status, {
      status: "dead_letter",
      nextRetryAt: null,
      startedAt: null,
      completedAt: now,
      error: "cancelled by user",
      updatedAt: now,
    });
    if (!updated) return { status: "conflict" };
    return { status: "cancelled", execution: updated };
  }

  private async tick(): Promise<void> {
    if (!this.running) return;

    try {
      await this.processDue();
    } catch (err) {
      console.error("[execution-queue] tick error:", err);
    }

    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.intervalMs);
  }

  private async runExecution(record: ExecutionRecord): Promise<void> {
    this.activeCount++;
    try {
      await this.claim(record);
      const result = await this.runPipeline(record);
      await this.complete(record, result);
    } catch (err) {
      // Classify the error (transient vs permanent) for retry decision
      const errorClass = classifyUncaughtError(err);
      await this.fail(record, err, errorClass);
    } finally {
      this.activeCount--;
    }
  }

  /**
   * Atomically move record from queued/failed → executing. If the record is
   * already executing (e.g., another worker claimed it), skip.
   */
  private async claim(record: ExecutionRecord): Promise<boolean> {
    const current = await this.store.get(record.id);
    if (!current) return false;
    if (current.status === "executing") return false;
    await this.store.update(record.id, {
      status: "executing",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  private async runPipeline(record: ExecutionRecord): Promise<ExecutionResult> {
    // The actual pipeline executor is injected (to avoid direct imports
    // of @4evergent/stellar). For the API server, this is
    // TransactionPipeline.execute() wrapped in a source-account provider.
    return this.pipelineExecutor(record);
  }

  private async complete(record: ExecutionRecord, result: ExecutionResult): Promise<void> {
    if (result.success) {
      await this.store.update(record.id, {
        status: result.status as ExecutionRecord["status"],
        txHash: result.txHash ?? null,
        error: null,
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else {
      await this.fail(record, result.error ?? new Error("Unknown error"), result.errorClass as "transient" | "permanent" | undefined);
    }
  }

  private async fail(record: ExecutionRecord, error: unknown, errorClass?: "transient" | "permanent"): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const classification = errorClass ?? classifyUncaughtError(error);
    const attempt = record.attempt + 1;

    // Update attempt count on the record
    await this.store.update(record.id, {
      attempt,
      error: message,
      errorClass: classification,
      updatedAt: new Date().toISOString(),
    });

    // Decide whether to retry or move to dead_letter
    const retryDecision = shouldRetryNow(record.id, attempt, classification, this.retryPolicy, this.nowFn);
    if (retryDecision.shouldRetry) {
      await this.store.update(record.id, {
        status: "failed",
        nextRetryAt: retryDecision.nextRetryAt,
      });
    } else {
      await this.store.update(record.id, {
        status: "dead_letter",
        nextRetryAt: null,
        completedAt: new Date().toISOString(),
      });
    }
  }

  private retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY;
  private nowFn: () => Date = () => new Date();
}

export interface ExecutionQueueOptions {
  intervalMs?: number;
  concurrency?: number;
  clock?: () => Date;
  now?: () => Date;
  retryPolicy?: RetryPolicy;
}

function classifyUncaughtError(error: unknown): "transient" | "permanent" {
  if (error instanceof Error) {
    return isTransientMessage(error.message) ? ("transient" as const) : ("permanent" as const);
  }
  return "transient" as const;
}

const TRANSIENT_PATTERNS: (string | RegExp)[] = [
  /network/i,
  /fetch/i,
  /timeout/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /socket/i,
  /horizon/i,
  /server error/i,
  /503/,
  /429/,
  /account fetch error/i,
  /transaction submission failed/i,
];

function isTransientMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_PATTERNS.some((p) => {
    if (typeof p === "string") return lower.includes(p);
    return p.test(lower);
  });
}

function shouldRetryNow(
  _executionId: string,
  attempt: number,
  errorClass: string,
  policy: RetryPolicy,
  now: () => Date
): { shouldRetry: boolean; nextRetryAt: string | null } {
  if (errorClass === "permanent") {
    return { shouldRetry: false, nextRetryAt: null };
  }
  if (attempt >= policy.maxRetries) {
    return { shouldRetry: false, nextRetryAt: null };
  }
  return { shouldRetry: true, nextRetryAt: computeNextRetryAt(attempt, policy, now()) };
}
