/**
 * 4evergent Operator CLI — HTTP client for the 4evergent API.
 *
 * This is an operator client only — it does NOT sign, build, or submit
 * Stellar transactions directly. All transaction work is delegated to the
 * API server over HTTP.
 *
 * Configuration:
 *   FOREGENT_API_URL  — API base URL (default: http://127.0.0.1:3000)
 *   FOREGENT_API_KEY  — Bearer API key (production auth mode)
 */

import { exit } from "node:process";

const API_URL = process.env.FOREGENT_API_URL ?? "http://127.0.0.1:3000";
const API_KEY = process.env.FOREGENT_API_KEY;

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.name = "ApiError";
  }
}

interface ApiResponse {
  status: number;
  body: any;
}

async function request(path: string, init: RequestInit = {}): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> ?? {}),
  };

  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers,
    });
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED" || err.cause?.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      throw new ApiError(0, `Cannot connect to API at ${API_URL}. Is the server running?`);
    }
    throw new ApiError(0, `Network error: ${err.message ?? "unknown"}`);
  }

  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (!res.ok) {
    const msg = body?.error ?? body?.message ?? `Request failed`;
    throw new ApiError(res.status, msg);
  }

  return { status: res.status, body };
}

// --- Formatters ---

function formatAgent(agent: any) {
  return `Agent:
  ID:           ${agent.id}
  Name:         ${agent.displayName}
  Description:  ${agent.description ?? "-"}
  Owner:        ${agent.ownerId ?? "-"}
  Stellar:      ${agent.stellarAddress ?? "-"}
  Status:       ${agent.status ?? (agent.active ? "active" : "paused")}
  Created:      ${agent.createdAt ?? "-"}
`;
}

function formatExecution(e: any) {
  return `Execution:
  ID:            ${e.id}
  Agent:         ${e.agentId}
  Status:        ${e.status}
  Amount:        ${e.intent?.amount ?? "-"} ${(e.intent?.assetDetails as any)?.code ?? e.intent?.asset ?? ""}
  TxHash:        ${e.txHash ?? "-"}
  Attempt:       ${e.attempt ?? 0}
  Error:         ${e.error ?? "-"}
  Started:       ${e.startedAt ?? "-"}
  Completed:     ${e.completedAt ?? "-"}
  Created:       ${e.createdAt ?? "-"}
`;
}

function formatApproval(a: any) {
  return `Approval:
  ID:           ${a.id}
  Agent:        ${a.agentId}
  Activity:     ${a.activityId ?? "-"}
  Status:       ${a.status}
  Created:      ${a.createdAt ?? "-"}
  Expires:      ${a.expiresAt ?? "-"}
  Approver:     ${a.approver ?? "-"}
`;
}

// --- Commands ---

async function cmdHealth() {
  try {
    const { body } = await request("/health");
    console.log(`API Status: ${body.status === "ok" ? "healthy" : "unhealthy"}`);
    console.log(`Signer: ${body.signerAccountId?.slice(0, 12)}...`);
    return 0;
  } catch (err: any) {
    console.error(`Health check failed: ${err.message}`);
    return 1;
  }
}

async function cmdAgentList() {
  try {
    const { body } = await request("/agents");
    if (!body.agents || body.agents.length === 0) {
      console.log("No agents found.");
      return 0;
    }
    for (const a of body.agents) {
      console.log(`${a.id}\t${a.displayName}\t${a.status ?? (a.active ? "active" : "paused")}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdAgentGet(agentId: string) {
  if (!agentId) {
    console.error("Usage: 4evergent agent get <id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}`);
    console.log(formatAgent(body));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdAgentStatus(agentId: string, status: "active" | "paused" | "disabled") {
  if (!agentId) {
    console.error("Usage: 4evergent agent <pause|resume|disable> <id>");
    return 1;
  }
  try {
    const { body } = await request(`/agents/${encodeURIComponent(agentId)}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    console.log(`Agent ${body.id} status: ${body.status}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdApprovalList() {
  try {
    const { body } = await request("/approvals");
    if (!body.approvals || body.approvals.length === 0) {
      console.log("No approvals found.");
      return 0;
    }
    console.log(`ID\t\t\tAgent\t\t\tStatus\t\t\tCreated`);
    for (const a of body.approvals) {
      console.log(`${a.id.slice(0, 18)}\t${a.agentId.slice(0, 14)}\t\t${a.status}\t\t${new Date(a.createdAt).toLocaleString()}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdApprovalAction(approvalId: string, action: "approve" | "reject") {
  if (!approvalId) {
    console.error(`Usage: 4evergent approval ${action} <id>`);
    return 1;
  }
  try {
    const { body } = await request(`/approvals/${encodeURIComponent(approvalId)}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    console.log(`Approval ${body.status}: agent=${body.agentId} activity=${body.activityId}`);
    if (body.message) console.log(`  ${body.message}`);
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdExecutionList() {
  try {
    // Gather across all agents (same approach as frontend api.listAllExecutions)
    const { body: agentsBody } = await request("/agents");
    const agents = agentsBody.agents ?? [];
    const all: any[] = [];
    for (const a of agents) {
      const res = await request(`/agents/${encodeURIComponent(a.id)}/executions?limit=100`);
      for (const e of res.body.executions ?? []) {
        all.push(e);
      }
    }
    if (all.length === 0) {
      console.log("No executions found.");
      return 0;
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    console.log(`ID\t\tAgent\t\tStatus\t\tTxHash\t\t\tAttempt\tCreated`);
    for (const e of all) {
      const txh = e.txHash ? e.txHash.slice(0, 16) + "…" : "-";
      console.log(`${e.id.slice(0, 14)}\t${e.agentId.slice(0, 10)}\t${e.status}\t${txh}\t${e.attempt}\t${new Date(e.createdAt).toLocaleString()}`);
    }
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

async function cmdExecutionGet(executionId: string) {
  if (!executionId) {
    console.error("Usage: 4evergent execution get <id>");
    return 1;
  }
  try {
    const { body } = await request(`/executions/${encodeURIComponent(executionId)}`);
    console.log(formatExecution(body.execution));
    return 0;
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    return 1;
  }
}

// --- CLI dispatch ---

const argv = process.argv.slice(2);

async function main(): Promise<number> {
  const cmd = argv[0];
  const sub = argv[1];

  if (!cmd) {
    console.error("Usage: 4evergent <command> [args...]\n\nCommands:\n  health\n  agent list | get <id> | pause <id> | resume <id> | disable <id>\n  approval list | approve <id> | reject <id>\n  execution list | get <id>");
    return 1;
  }

  switch (cmd) {
    case "health":
      return cmdHealth();
    case "agent":
      switch (sub) {
        case "list": return cmdAgentList();
        case "get": return cmdAgentGet(argv[2] ?? "");
        case "pause": return cmdAgentStatus(argv[2] ?? "", "paused");
        case "resume": return cmdAgentStatus(argv[2] ?? "", "active");
        case "disable": return cmdAgentStatus(argv[2] ?? "", "disabled");
        default:
          console.error(`Unknown agent subcommand: ${sub}`);
          console.error("Usage: 4evergent agent <list|get|pause|resume|disable> [id]");
          return 1;
      }
    case "approval":
      switch (sub) {
        case "list": return cmdApprovalList();
        case "approve": return cmdApprovalAction(argv[2] ?? "", "approve");
        case "reject": return cmdApprovalAction(argv[2] ?? "", "reject");
        default:
          console.error(`Unknown approval subcommand: ${sub}`);
          console.error("Usage: 4evergent approval <list|approve|reject> [id]");
          return 1;
      }
    case "execution":
      switch (sub) {
        case "list": return cmdExecutionList();
        case "get": return cmdExecutionGet(argv[2] ?? "");
        default:
          console.error(`Unknown execution subcommand: ${sub}`);
          console.error("Usage: 4evergent execution <list|get> [id]");
          return 1;
      }
    case "--help":
    case "-h":
    case "help":
      console.log("4evergent Operator CLI\n\nCommands:\n  health\n  agent list | get <id> | pause <id> | resume <id> | disable <id>\n  approval list | approve <id> | reject <id>\n  execution list | get <id>");
      return 0;
    default:
      console.error(`Unknown command: ${cmd}`);
      return 1;
  }
}

main().then((code) => exit(code)).catch((err) => {
  console.error(`Fatal: ${err.message}`);
  exit(1);
});
