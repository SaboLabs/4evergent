import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clearAgents, createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";

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

const BASE_RULES: Partial<PolicyRules> = {
  maxTxAmount: { XLM: "1000" },
  requireHumanApprovalForAmountAbove: "10",
};

function makeAgent(id: string, ownerId: string, status = "active") {
  return {
    id,
    displayName: `Agent ${id}`,
    description: "test agent",
    ownerId,
    stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    capabilities: ["payment"],
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    metadata: {},
  };
}

async function startServer(opts: { authProvider: DevAuthProvider }) {
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: BASE_RULES,
    deferExecution: true,
    authProvider: opts.authProvider,
  });

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    registerAgent: (agent: any) => void;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        registerAgent: (agent: any) => server.registerAgent(agent),
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function patch(baseUrl: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  clearAgents();
});

test("AUTHZ: PATCH /agents/:id/status — owner can pause/resume", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a/status", { status: "paused" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "paused");

    const check = await get(baseUrl, "/agents/agent-a");
    assert.equal(check.status, 200);
    assert.equal(check.body.status, "paused");
  } finally {
    await close();
  }
});

test("AUTHZ: PATCH /agents/:id/status — non-owner cannot change status", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await patch(baseUrl, "/agents/agent-b/status", { status: "paused" });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("AUTHZ: PATCH /agents/:id/status — invalid status", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));
  try {
    const res = await patch(baseUrl, "/agents/agent-a/status", { status: "bogus" });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id — owner can read own agent", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a", "paused"));
  try {
    const res = await get(baseUrl, "/agents/agent-a");
    assert.equal(res.status, 200);
    assert.equal(res.body.id, "agent-a");
    assert.equal(res.body.status, "paused");
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id — non-owner cannot read", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await get(baseUrl, "/agents/agent-b");
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/activity/:activityId — owner can read own activity", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));

  const intentRes = await fetch(`${baseUrl}/agents/agent-a/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "detail test",
    }),
  });
  const body = await intentRes.json();
  const activityId = body.activityId;

  try {
    const res = await get(baseUrl, `/agents/agent-a/activity/${activityId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.id, activityId);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/activity/:activityId — non-owner cannot read", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await get(baseUrl, `/agents/agent-b/activity/some-id`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/approvals — owner can list own agent approvals", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-a", "owner-a"));

  await fetch(`${baseUrl}/agents/agent-a/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "approvals test",
    }),
  });

  try {
    const res = await get(baseUrl, "/agents/agent-a/approvals");
    assert.equal(res.status, 200);
    assert.equal(res.body.approvals.length, 1);
    assert.equal(res.body.agentId, "agent-a");
  } finally {
    await close();
  }
});

test("AUTHZ: GET /agents/:id/approvals — non-owner cannot list", async () => {
  const { baseUrl, close, registerAgent } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
  });
  registerAgent(makeAgent("agent-b", "owner-b"));
  try {
    const res = await get(baseUrl, "/agents/agent-b/approvals");
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});
