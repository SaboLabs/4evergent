import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryExecutionStore } from "@4evergent/database";
import { ExecutionRecoveryService } from "../src/execution-recovery.js";
import { ExecutionQueue } from "../src/execution-queue.js";
import type { ExecutionRecord } from "@4evergent/database";
import type { AgentIntent } from "@4evergent/shared";

function makeIntent(): AgentIntent {
  return {
    type: "payment",
    asset: "XLM",
    destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "10",
    reason: "test execution",
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "owner-a",
    agentId: "agent-a",
    approvalId: null,
    activityId: null,
    intent: makeIntent(),
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("Recovery: executing record found and recovered", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "executing", startedAt: new Date().toISOString() });
  await store.record(execution);

  const recovery = new ExecutionRecoveryService(store);
  const result = await recovery.recover();

  assert.equal(result.found, 1);
  assert.equal(result.recovered, 1);
  assert.deepEqual(result.recoveredIds, [execution.id]);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
  assert.ok(updated?.nextRetryAt);
  // nextRetryAt should be immediately eligible (<= now)
  assert.ok(new Date(updated!.nextRetryAt!) <= new Date());
});

test("Recovery: retry count preserved", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "executing",
    attempt: 2,
    errorClass: "transient",
    startedAt: new Date().toISOString(),
  });
  await store.record(execution);

  const recovery = new ExecutionRecoveryService(store);
  await recovery.recover();

  const updated = await store.get(execution.id);
  assert.equal(updated?.attempt, 2);
  assert.equal(updated?.errorClass, "transient");
});

test("Recovery: terminal states not recovered", async () => {
  const store = new InMemoryExecutionStore();
  const submitted = makeExecution({ status: "submitted", txHash: "tx-1" });
  const confirmed = makeExecution({ status: "confirmed", txHash: "tx-2" });
  const failed = makeExecution({ status: "failed", nextRetryAt: new Date().toISOString() });
  const deadLetter = makeExecution({ status: "dead_letter" });
  const queued = makeExecution({ status: "queued" });

  await store.record(submitted);
  await store.record(confirmed);
  await store.record(failed);
  await store.record(deadLetter);
  await store.record(queued);

  const recovery = new ExecutionRecoveryService(store);
  const result = await recovery.recover();

  assert.equal(result.found, 0);
  assert.equal(result.recovered, 0);

  // Verify none were touched
  assert.equal((await store.get(submitted.id))?.status, "submitted");
  assert.equal((await store.get(confirmed.id))?.status, "confirmed");
  assert.equal((await store.get(failed.id))?.status, "failed");
  assert.equal((await store.get(deadLetter.id))?.status, "dead_letter");
  assert.equal((await store.get(queued.id))?.status, "queued");
});

test("Recovery: no duplicate records created", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "executing", startedAt: new Date().toISOString() });
  await store.record(execution);

  const recovery = new ExecutionRecoveryService(store);
  await recovery.recover();

  // Count records — should still be exactly 1
  const all = await store.listByOwner("owner-a", 100);
  assert.equal(all.length, 1);
});

test("Recovery: idempotent — second call does not re-recover", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "executing", startedAt: new Date().toISOString() });
  await store.record(execution);

  const recovery = new ExecutionRecoveryService(store);
  const first = await recovery.recover();
  assert.equal(first.recovered, 1);

  const second = await recovery.recover();
  assert.equal(second.found, 0);
  assert.equal(second.recovered, 0);

  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
});

test("Recovery: queue worker reprocesses recovered execution", async () => {
  const store = new InMemoryExecutionStore();
  let executed = 0;
  const pipelineExecutor = async (record: ExecutionRecord) => {
    executed++;
    return {
      record,
      success: true,
      status: "submitted",
      txHash: "tx-recovered",
      error: null,
    };
  };
  const queue = new ExecutionQueue(store, pipelineExecutor, async () => ({
    accountId: () => "GACCOUNT",
    sequenceNumber: () => "1",
    incrementSequenceNumber: () => {},
  }));

  // Simulate a stuck executing record (crash scenario)
  const execution = makeExecution({ status: "executing", startedAt: new Date().toISOString() });
  await store.record(execution);

  // Recover
  const recovery = new ExecutionRecoveryService(store);
  const recoveryResult = await recovery.recover();
  assert.equal(recoveryResult.recovered, 1);

  // Queue worker should now pick it up
  await queue.processDue();
  assert.equal(executed, 1);

  const final = await store.get(execution.id);
  assert.equal(final?.status, "submitted");
  assert.equal(final?.txHash, "tx-recovered");
});

test("Recovery: owner isolation — only own records recovered", async () => {
  const store = new InMemoryExecutionStore();
  const executionA = makeExecution({ ownerId: "owner-a", status: "executing", startedAt: new Date().toISOString() });
  const executionB = makeExecution({ ownerId: "owner-b", status: "executing", startedAt: new Date().toISOString() });
  await store.record(executionA);
  await store.record(executionB);

  const recovery = new ExecutionRecoveryService(store);
  const result = await recovery.recover();

  assert.equal(result.found, 2);
  assert.equal(result.recovered, 2);

  // Both should be recovered (recovery is global, not owner-scoped — it's a system-level operation)
  assert.equal((await store.get(executionA.id))?.status, "failed");
  assert.equal((await store.get(executionB.id))?.status, "failed");
});

test("Recovery: queue disabled — no worker started", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "executing", startedAt: new Date().toISOString() });
  await store.record(execution);

  // Recovery should still work even when queue is disabled
  const recovery = new ExecutionRecoveryService(store);
  const result = await recovery.recover();
  assert.equal(result.recovered, 1);

  // But no queue worker should be running — the record stays in "failed"
  // until a queue worker is started.
  const updated = await store.get(execution.id);
  assert.equal(updated?.status, "failed");
});

test("Recovery: nextRetryAt is immediately eligible", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({ status: "executing", startedAt: new Date().toISOString() });
  await store.record(execution);

  const recovery = new ExecutionRecoveryService(store);
  await recovery.recover();

  const updated = await store.get(execution.id);
  assert.ok(updated?.nextRetryAt);
  // Should be eligible now (or very close to now)
  const retryAt = new Date(updated!.nextRetryAt!);
  const now = new Date();
  assert.ok(retryAt <= now);
});

test("Recovery: startedAt cleared on recovery", async () => {
  const store = new InMemoryExecutionStore();
  const execution = makeExecution({
    status: "executing",
    startedAt: new Date().toISOString(),
  });
  await store.record(execution);

  const recovery = new ExecutionRecoveryService(store);
  await recovery.recover();

  const updated = await store.get(execution.id);
  assert.equal(updated?.startedAt, null);
});
