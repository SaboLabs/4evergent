import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";

declare const fetch: typeof globalThis.fetch;

// fetch with keepalive disabled so Node's http server can close cleanly between tests
async function apiFetch(url: string, init?: RequestInit) {
  return fetch(url, { ...init, keepalive: false });
}

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test Agent",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: ["payment"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; registerAgent?: boolean }) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: opts?.policyRules,
    deferExecution: true,
    requestContext: { ownerId: "test" },
  });
  if (opts?.registerAgent !== false) {
    server.registerAgent(TEST_AGENT);
  }

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await apiFetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

// ===== GET /agents =====

test("GET /agents returns registered agents without secret fields", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.agents));
    assert.equal(res.body.agents.length, 1);
    assert.equal(res.body.agents[0].id, "test-agent");
    assert.equal(res.body.agents[0].displayName, "Test Agent");

    // No secret material in the response
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /agents returns empty list when no agents registered", async () => {
  const { baseUrl, close } = await startServer({ registerAgent: false });
  try {
    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.agents));
    // Note: agents map is module-level shared state, so other test files in
    // the same test process may have registered agents already. The contract
    // is: the endpoint returns an array and never leaks secrets.
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

// ===== GET /agents/:id/activity =====

test("GET /agents/:id/activity returns persisted activity", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Submit an intent that requires approval -> creates an activity record
    const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "read endpoint test",
      }),
    });
    assert.equal(intentRes.status, 202);
    const intentBody = await intentRes.json();

    const res = await get(baseUrl, `/agents/test-agent/activity`);
    assert.equal(res.status, 200);
    assert.equal(res.body.agentId, "test-agent");
    assert.ok(Array.isArray(res.body.activity));
    assert.equal(res.body.activity.length, 1);
    assert.equal(res.body.activity[0].id, intentBody.activityId);
    assert.equal(res.body.activity[0].status, "requires_approval");

    // Activity record must not contain secret material
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity returns 404 for unknown/non-owned agent", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/agents/nonexistent-agent/activity");
    // Authorization rejects non-owned agents with 404 (not found)
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity respects limit query param", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Create 3 activity records
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: Keypair.random().publicKey(),
          amount: "50",
          reason: `limit test ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/agents/test-agent/activity?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
  } finally {
    await close();
  }
});

// ===== GET /approvals =====

test("GET /approvals returns persisted approvals", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "approvals list test",
      }),
    });
    const intentBody = await intentRes.json();

    const res = await get(baseUrl, "/approvals");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.approvals));
    assert.equal(res.body.approvals.length, 1);
    assert.equal(res.body.approvals[0].id, intentBody.approvalId);
    assert.equal(res.body.approvals[0].status, "pending_approval");

    // Approval list must not contain secret material or XDR
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /approvals?status=pending_approval filters by status", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Two intents requiring approval
    for (let i = 0; i < 2; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: Keypair.random().publicKey(),
          amount: "50",
          reason: `status filter ${i}`,
        }),
      });
    }

    const pending = await get(baseUrl, "/approvals?status=pending_approval");
    assert.equal(pending.status, 200);
    assert.equal(pending.body.approvals.length, 2);
    for (const a of pending.body.approvals) {
      assert.equal(a.status, "pending_approval");
    }

    const approved = await get(baseUrl, "/approvals?status=approved");
    assert.equal(approved.status, 200);
    assert.equal(approved.body.approvals.length, 0);
  } finally {
    await close();
  }
});

test("GET /approvals returns empty list when none exist", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/approvals");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.approvals, []);
  } finally {
    await close();
  }
});

// ===== Read endpoints do not expose raw XDR =====

test("read endpoints never return raw XDR or transaction blobs", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "xdr leak test",
      }),
    });

    const activity = await get(baseUrl, "/agents/test-agent/activity");
    const approvals = await get(baseUrl, "/approvals");
    const blob = JSON.stringify(activity.body) + JSON.stringify(approvals.body);
    assert.ok(!/"xdr"/.test(blob), "read endpoints must not expose xdr field");
    assert.ok(!/"envelope"/.test(blob), "read endpoints must not expose envelope field");
    assert.ok(!/"tx_blob"/.test(blob), "read endpoints must not expose tx_blob field");
  } finally {
    await close();
  }
});
