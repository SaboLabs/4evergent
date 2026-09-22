# 4evergent HTTP API Reference

Current API surface of `apps/api`, accurate to the source at
`apps/api/src/index.ts`. All examples use placeholders — never real
credentials.

## Authentication

All endpoints except `GET /health` require authentication.

- **Development mode** (default): `DevAuthProvider` authenticates every
  request as the development owner (`DEV_OWNER_ID`, default `operator`).
  No `Authorization` header needed.
- **Production mode**: set `API_KEYS` (format
  `key:ownerId[:subject]`, comma-separated). Requests must send
  `Authorization: Bearer <key>`. Invalid/missing credentials → `401`.
  See [security-model.md](security-model.md) — API Authentication.

Unauthenticated requests to protected endpoints return
`{"error":"unauthorized"}` with status `401`.

## Ownership

All data is owner-scoped. Requests only see records owned by the
authenticated `ownerId`. Access to another owner's resource returns
`404` (not `403`) to avoid leaking existence.

## General error behavior

Errors are ad-hoc JSON — most follow `{"error": "<message>"}` with an
appropriate 4xx/5xx status, but some endpoints return message-shaped
bodies (noted where they differ). Unknown paths return
`{"error":"not found"}` with `404`. Request bodies are limited to 1 MB.

---

## Health

### GET /health

Public (no authentication). Returns `{"status":"ok","signerAccountId":"G..."}`.

---

## Agents

### POST /agents

Create an agent. Auth: any authenticated owner.

Body: `{ "displayName": string (required, ≤100 chars, trimmed),
"description"?: string, "capabilities"?: string[], "stellarAddress"?: string }`

- `201` → `{ "agent": AgentRecord }` (bound to caller's `ownerId`)
- `400` → invalid JSON / missing `displayName` / `displayName` too long /
  `capabilities` not string array / `stellarAddress` not a string

### GET /agents

List caller's agents. Returns `{ "agents": AgentRecord[] }`.

### GET /agents/:id

Get one agent (owner-scoped). `404` if not found or not owned.

### PATCH /agents/:id/status

Body: `{ "status": "active" | "paused" | "disabled" }`

- `200` → `{ "id", "status" }`
- `400` → invalid status / invalid JSON
- `404` → not found or not owned

---

## Intents

### POST /agents/:id/intents

Submit a typed intent for execution. The core endpoint.

Body: an `AgentIntent` union member (`packages/shared/src/types.ts`):

- `payment`: `{ type, asset, assetDetails?, destination, amount, reason, memo? }`
- `trustline`: `{ type, assetCode, issuer, limit?, reason }`
- `contract_call`: `{ type, contractId, function, args, reason }`
- `account_settings`: `{ type, setting, value, reason }`

Headers: optional `Idempotency-Key` (≤256 chars, scoped to owner+agent).
Same key + same intent → returns the original activity (`200`).
Same key + different intent → `409`.

Agent status admission: the agent must be `active`. A `paused` or
`disabled` agent rejects new intents before any activity, approval,
execution, or queue record is created:

- `409` → `{ "error": "agent is paused; new intents are rejected" }`
- `409` → `{ "error": "agent is disabled; new intents are rejected" }`

Existing approvals and in-flight executions are unaffected by a status
change — the gate applies to new intents only.

Behavior (policy decision):

- Policy `deny` → `403` with intent response recording the denial
- Policy `requires_approval` → `202` with `approvalId` in the response
- Policy `allow` → executes: `200` (submitted, includes `txHash`),
  `422` (simulation failed), `502` (source account load failed),
  `403` (rejected)

Response (success/denied): `{ "activityId", "agentId", "status",
"policyDecision", "authorizationStatus", "simulationResult",
"txHash", "error" }`

Raw XDR / transaction blobs in the body are rejected with `400`
(typed intents only — no raw transaction acceptance by design).

---

## Approvals

### POST /approvals/:id/approve

Approve a pending approval. Owner-scoped (`canApprove`). The approver
identity is taken from the authenticated principal's `subject`.

- `200` → `{ approvalId, activityId, agentId:"", status:"approved",
  message }` — execution is enqueued (persistent queue) or deferred
- `409` → invalid state transition (e.g. already approved)
- `410` → approval expired
- `404` → not found or not owned (response body is approval-response
  shaped with status `rejected`, not `{"error"}`)

Raw XDR in body → `400` with `{"message": ...}` (message-shaped).

### POST /approvals/:id/reject

Reject a pending approval. Owner-scoped (`canReject`).

- `200` → approval-response shaped, status `rejected`
- `409` → invalid state transition
- `404` → not found or not owned (approval-response shaped)

Raw XDR in body → `400` with `{"message": ...}`.

### GET /approvals

List caller's approvals (most recent 50). Query: `?status=<status>`
optional filter. Returns `{ "approvals": ApprovalRecord[] }`.

### GET /agents/:id/approvals

List approvals for one agent (owner-scoped). Query: `?status=` filter.
Returns `{ "agentId", "approvals": ApprovalRecord[] }`.

---

## Activity

### GET /agents/:id/activity

List activity records for an agent (owner-scoped).
Query: `?limit=` (default 50, clamped 1–100).
Returns `{ "agentId", "activity": ActivityRecord[] }`.

### GET /agents/:id/activity/:activityId

Single activity record (owner-scoped). `404` if not found/not owned.
Returns `{ "activity": ActivityRecord }`.

---

## Policy

### GET /agents/:id/policy

Get the agent's effective policy rules (owner-scoped). Returns
`{ "agentId", "policy": PolicyRules, "version": number, "updatedAt" }`.
Agents without a custom policy return `DEFAULT_RULES` with `version: 0`.

### PUT /agents/:id/policy

Set the agent's policy (owner-scoped). Body: a `PolicyRules` object.
Validated by `validatePolicyRules`; normalized before storage.

- `200` → `{ "agentId", "policy", "version" }`
- `400` → `{"error":"invalid policy","details":[...]}` / invalid JSON /
  body not an object

---

## Schedules

### POST /agents/:id/schedules

Create a schedule (owner-scoped). Body:

`{ "intent": AgentIntent, "scheduleExpression": "<cron-like>",
"timezone"?: string (default "UTC") }`

Intent and expression are validated (`validateScheduleIntent`,
`validateScheduleExpression`); invalid input → `400` with the
validator's error message. `201` → `{ "schedule": ScheduleRecord }`.

### GET /agents/:id/schedules

List schedules for an agent (owner-scoped). Query: `?limit=`
(default 50, clamped 1–100). Returns `{ "agentId", "schedules": [] }`.

### GET /agents/:id/schedules/:scheduleId

Single schedule (owner-scoped). Returns `{ "schedule": ScheduleRecord }`.

### PATCH /agents/:id/schedules/:scheduleId

Update a schedule's `scheduleExpression` (re-validated against the
schedule's timezone). `200` → `{ "schedule" }`.

### DELETE /agents/:id/schedules/:scheduleId

Delete a schedule. `200` → `{ "deleted": true }`.

### POST /agents/:id/schedules/:scheduleId/pause | /resume | /disable

Transition schedule status (`paused` / `active` / `disabled`).
`200` → `{ "schedule" }`.

---

## Executions

Execution records are created when an approved intent is enqueued for
on-chain execution (retry, dead-letter, reconciliation).

### GET /agents/:id/executions

List executions for an agent (owner-scoped). Query: `?limit=`
(default 50, clamped 1–100). Returns `{ "agentId", "executions": [] }`.

### GET /executions/:id

Single execution (owner-scoped via `getForOwner`). Returns
`{ "execution": ExecutionRecord }`.

### POST /executions/:id/retry

Retry a `failed` or `dead_letter` execution. Requires the execution
queue to be enabled.

- `200` → `{ "execution", "message": "execution queued for retry" }`
- `409` → wrong status / max retries reached / state conflict
- `404` → not found / queue not enabled

### POST /executions/:id/cancel

Cancel a `queued` or `executing` execution. Requires the queue.

- `200` → `{ "execution", "message": "execution cancelled" }`
- `409` → wrong status / conflict
- `404` → not found / queue not enabled

### GET /agent-queue

Queue summary for the caller's executions. Returns
`{ "running": boolean, "byStatus": Record<string, number> }`.
`404` with `{"error":"execution queue not enabled"}` if the queue is off.

---

## Notes

- Response shapes above are the primary success shapes; record fields
  (`AgentRecord`, `ActivityRecord`, `ApprovalRecord`, `ScheduleRecord`,
  `ExecutionRecord`, `PolicyRules`) are defined in
  `packages/shared/src/types.ts` and `packages/database/src/*-types.ts`.
- This API is served by `apps/api` (`pnpm --filter @4evergent/api start`,
  default port 3000). Configuration via environment — see
  [testnet.md](testnet.md) and `.env.example`.
