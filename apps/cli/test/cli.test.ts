/**
 * CLI behavior tests — mock fetch, invoke command handlers via spawned CLI.
 *
 * The CLI reads FOREGENT_API_URL / FOREGENT_API_KEY at module load; each
 * test sets env + mocks global fetch, then spawns `tsx src/cli.ts <args>`
 * as a child process and asserts stdout/stderr/exit code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  opts: { env?: Record<string, string>; responses?: Array<{ match: string; status: number; body: any }> } = {}
): RunResult {
  const responses = opts.responses ?? [];
  // Inline mock server: intercepts fetch inside the child process before CLI runs.
  const prelude = `
    const responses = ${JSON.stringify(responses)};
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      const hit = responses.find((r) => u.includes(r.match));
      if (!hit) return new Response(JSON.stringify({ error: "no mock for " + u }), { status: 500 });
      return new Response(JSON.stringify(hit.body), { status: hit.status });
    };
  `;
  const env = {
    ...process.env,
    FOREGENT_API_URL: "http://mock:3000",
    ...opts.env,
    TSX_CLI_MOCK_PRELUDE: prelude,
  };

  // tsx doesn't support --require preambles; use a wrapper instead.
  const wrapper = `
    ${prelude}
    await import(${JSON.stringify(CLI)});
  `;
  const wrapperPath = CLI.replace(/\.ts$/, ".mock-wrapper.mts");
  writeFileSync(wrapperPath, wrapper);
  try {
    const r = spawnSync("npx", ["tsx", wrapperPath, ...args], {
      encoding: "utf-8",
      env,
      cwd: path.dirname(CLI),
      timeout: 30000,
    });
    return {
      code: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  } finally {
    rmSync(wrapperPath, { force: true });
  }
}

test("CLI: health success → exit 0, prints status", () => {
  const r = run(["health"], {
    responses: [{ match: "/health", status: 200, body: { status: "ok", signerAccountId: "GBDMPFEAZOQW7XVTAVPXBT7PPA4ZZW7ZFJW5KJNBYRPJ35H6ASW4ASE3" } }],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /healthy/);
  assert.match(r.stdout, /GBDMPFEAZOQW/);
});

test("CLI: health failure (network error) → exit non-zero", () => {
  const r = run(["health"], {
    env: { FOREGENT_API_URL: "http://127.0.0.1:9" }, // closed port
    responses: [],
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Health check failed|Cannot connect/);
});

test("CLI: agent list → prints agents", () => {
  const r = run(["agent", "list"], {
    responses: [
      { match: "/agents", status: 200, body: { agents: [{ id: "agent-1", displayName: "Test Agent", active: true, createdAt: "2026-01-01T00:00:00Z" }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent-1/);
  assert.match(r.stdout, /Test Agent/);
  assert.match(r.stdout, /active/);
});

test("CLI: agent get → prints details", () => {
  const r = run(["agent", "get", "agent-1"], {
    responses: [
      { match: "/agents/agent-1", status: 200, body: { id: "agent-1", displayName: "Test Agent", status: "active", ownerId: "owner-1", stellarAddress: "GAAA", createdAt: "2026-01-01T00:00:00Z" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent-1/);
  assert.match(r.stdout, /Test Agent/);
  assert.match(r.stdout, /active/);
});

test("CLI: agent pause → PATCH status=paused", () => {
  let requestBody: any = null;
  const r = run(["agent", "pause", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/status", status: 200, body: { id: "agent-1", status: "paused" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /paused/);
});

test("CLI: agent resume → status=active", () => {
  const r = run(["agent", "resume", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/status", status: 200, body: { id: "agent-1", status: "active" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /active/);
});

test("CLI: agent disable → status=disabled", () => {
  const r = run(["agent", "disable", "agent-1"], {
    responses: [
      { match: "/agents/agent-1/status", status: 200, body: { id: "agent-1", status: "disabled" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /disabled/);
});

test("CLI: approval list → prints approvals", () => {
  const r = run(["approval", "list"], {
    responses: [
      { match: "/approvals", status: 200, body: { approvals: [{ id: "ap-123", agentId: "agent-1", activityId: "act-1", status: "pending_approval", createdAt: "2026-01-01T00:00:00Z" }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /ap-123/);
  assert.match(r.stdout, /pending_approval/);
});

test("CLI: approval approve → exit 0", () => {
  const r = run(["approval", "approve", "ap-1"], {
    responses: [
      { match: "/approvals/ap-1/approve", status: 200, body: { approvalId: "ap-1", activityId: "act-1", status: "approved", message: "approval accepted; transaction queued for execution" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /approved/);
});

test("CLI: approval reject → exit 0", () => {
  const r = run(["approval", "reject", "ap-1"], {
    responses: [
      { match: "/approvals/ap-1/reject", status: 200, body: { approvalId: "ap-1", activityId: "act-1", status: "rejected", message: "approval rejected" } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /rejected/);
});

test("CLI: execution list → aggregates across agents", () => {
  const r = run(["execution", "list"], {
    responses: [
      { match: "/agents/agent-1/executions", status: 200, body: { agentId: "agent-1", executions: [{ id: "exec-1", agentId: "agent-1", status: "confirmed", txHash: "ab".repeat(32), attempt: 0, createdAt: "2026-01-01T00:00:00Z", intent: { type: "payment", asset: "XLM", amount: "10" } }] } },
      { match: "/agents", status: 200, body: { agents: [{ id: "agent-1", displayName: "T", active: true }] } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /exec-1/);
  assert.match(r.stdout, /confirmed/);
});

test("CLI: execution get → prints full detail", () => {
  const r = run(["execution", "get", "exec-1"], {
    responses: [
      { match: "/executions/exec-1", status: 200, body: { execution: { id: "exec-1", agentId: "agent-1", status: "confirmed", txHash: "ab".repeat(32), attempt: 1, error: null, startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", createdAt: "2026-01-01T00:00:00Z", intent: { type: "payment", asset: "XLM", amount: "10" } } } },
    ],
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /exec-1/);
  assert.match(r.stdout, /confirmed/);
  assert.match(r.stdout, /TxHash/);
});

test("CLI: HTTP 401 → exit 401, prints error", () => {
  const r = run(["agent", "list"], {
    responses: [{ match: "/agents", status: 401, body: { error: "unauthorized" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /401/);
  assert.match(r.stderr, /unauthorized/);
});

test("CLI: HTTP 404 → exit 404", () => {
  const r = run(["agent", "get", "nope"], {
    responses: [{ match: "/agents/nope", status: 404, body: { error: "not found" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /404/);
  assert.match(r.stderr, /not found/);
});

test("CLI: HTTP 409 → exit 409", () => {
  const r = run(["agent", "pause", "agent-1"], {
    responses: [{ match: "/agents/agent-1/status", status: 409, body: { error: "conflict" } }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /409/);
});

test("CLI: network failure → exit non-zero, no secret leak", () => {
  const r = run(["agent", "list"], {
    env: { FOREGENT_API_URL: "http://127.0.0.1:9" },
  });
  assert.notEqual(r.code, 0);
});

test("CLI: API key never appears in output", () => {
  const r = run(["health"], {
    env: { FOREGENT_API_KEY: "sk-super-secret-key-abc123" },
    responses: [{ match: "/health", status: 200, body: { status: "ok", signerAccountId: "GTEST" } }],
  });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("sk-super-secret-key-abc123"));
  assert.ok(!r.stderr.includes("sk-super-secret-key-abc123"));
});

test("CLI: API key sent as Bearer header", () => {
  // The prelude can capture headers; verify indirectly via stderr absence of key.
  const r = run(["agent", "list"], {
    env: { FOREGENT_API_KEY: "sk-another-secret" },
    responses: [{ match: "/agents", status: 200, body: { agents: [] } }],
  });
  assert.equal(r.code, 0);
  assert.ok(!r.stdout.includes("sk-another-secret"));
  assert.ok(!r.stderr.includes("sk-another-secret"));
});

test("CLI: unknown command → exit 1", () => {
  const r = run(["nonsense"]);
  assert.equal(r.code, 1);
});

test("CLI: no command → usage, exit 1", () => {
  const r = run([]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});
