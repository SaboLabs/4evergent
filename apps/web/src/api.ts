const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    keepalive: false,
    ...init,
  });
  const body = res.status !== 204 ? await res.json() : null;
  if (!res.ok) {
    const message = body?.error ?? `API error ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return body as T;
}

import type {
  AgentRecord,
  ActivityRecord,
  ApprovalRecord,
  SubmitPaymentIntent,
  SubmitTrustlineIntent,
  ScheduleRecord,
  ScheduleStatus,
  ExecutionRecord,
  QueueSummary,
  PolicyRules,
} from './types';

export interface IntentResponse {
  activityId: string;
  agentId: string;
  status: string;
  policyDecision: {
    result: string;
    reason: string;
    rule: string;
    intent: any;
  };
  authorizationStatus: string;
  simulationResult: any;
  txHash: string | null;
  error: string | null;
  approvalId?: string;
}

export const api = {
  health: () => request<{ status: string; signerAccountId: string }>('/health'),

  listAgents: () => request<{ agents: AgentRecord[] }>('/agents'),

  getAgent: (agentId: string) => request<AgentRecord>(`/agents/${encodeURIComponent(agentId)}`),

  agentActivity: (agentId: string, limit = 50) =>
    request<{ agentId: string; activity: ActivityRecord[] }>(
      `/agents/${encodeURIComponent(agentId)}/activity?limit=${limit}`
    ),

  activityDetail: (agentId: string, activityId: string) =>
    request<{ activity: ActivityRecord }>(`/agents/${encodeURIComponent(agentId)}/activity/${encodeURIComponent(activityId)}`),

  agentApprovals: (agentId: string, statusFilter?: string) => {
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    return request<{ agentId: string; approvals: ApprovalRecord[] }>(`/agents/${encodeURIComponent(agentId)}/approvals${qs}`);
  },

  updateAgentStatus: (agentId: string, status: string) =>
    request<{ id: string; status: string }>(`/agents/${encodeURIComponent(agentId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  // ===== Policy =====

  getPolicy: (agentId: string) =>
    request<{ agentId: string; policy: PolicyRules; version: number; updatedAt: string | null }>(
      `/agents/${encodeURIComponent(agentId)}/policy`
    ),

  updatePolicy: (agentId: string, policy: Partial<PolicyRules>) =>
    request<{ agentId: string; policy: PolicyRules; version: number }>(
      `/agents/${encodeURIComponent(agentId)}/policy`,
      {
        method: 'PUT',
        body: JSON.stringify(policy),
      },
    ),

  listApprovals: (statusFilter?: string) => {
    const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    return request<{ approvals: ApprovalRecord[] }>(`/approvals${qs}`);
  },

  approve: (approvalId: string, approver?: string) =>
    request<{ approvalId: string; activityId: string; status: string; message: string }>(
      `/approvals/${encodeURIComponent(approvalId)}/approve`,
      { method: 'POST', body: JSON.stringify({ approver }) }
    ),

  reject: (approvalId: string) =>
    request<{ approvalId: string; activityId: string; status: string; message: string }>(
      `/approvals/${encodeURIComponent(approvalId)}/reject`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  submitPayment: (agentId: string, intent: SubmitPaymentIntent) =>
    request<IntentResponse>(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: 'POST',
      body: JSON.stringify(intent),
    }),

  submitTrustline: (agentId: string, intent: SubmitTrustlineIntent) =>
    request<IntentResponse>(`/agents/${encodeURIComponent(agentId)}/intents`, {
      method: 'POST',
      body: JSON.stringify({ ...intent, type: 'trustline' }),
    }),

  createAgent: (body: { displayName: string; description?: string; capabilities?: string[]; stellarAddress?: string }) =>
    request<{ agent: AgentRecord }>('/agents', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ===== Executions =====

  listAllExecutions: async (limit = 50): Promise<{ executions: ExecutionRecord[] }> => {
    const agents = await request<{ agents: AgentRecord[] }>('/agents');
    const results = await Promise.all(
      agents.agents.map((a) =>
        request<{ agentId: string; executions: ExecutionRecord[] }>(
          `/agents/${encodeURIComponent(a.id)}/executions?limit=${limit}`
        )
      )
    );
    const executions = results.flatMap((r) => r.executions);
    executions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { executions };
  },

  listAgentExecutions: (agentId: string, limit = 50) =>
    request<{ agentId: string; executions: ExecutionRecord[] }>(
      `/agents/${encodeURIComponent(agentId)}/executions?limit=${limit}`
    ),

  getExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord }>(`/executions/${encodeURIComponent(executionId)}`),

  getQueueStatus: () =>
    request<QueueSummary>('/agent-queue'),

  retryExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord; message: string }>(
      `/executions/${encodeURIComponent(executionId)}/retry`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  cancelExecution: (executionId: string) =>
    request<{ execution: ExecutionRecord; message: string }>(
      `/executions/${encodeURIComponent(executionId)}/cancel`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  // ===== Schedules =====

  listSchedules: (agentId: string, limit = 50) =>
    request<{ agentId: string; schedules: ScheduleRecord[] }>(
      `/agents/${encodeURIComponent(agentId)}/schedules?limit=${limit}`
    ),

  getSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`
    ),

  createSchedule: (agentId: string, body: { intent: any; scheduleExpression: string; timezone?: string }) =>
    request<{ schedule: ScheduleRecord }>(`/agents/${encodeURIComponent(agentId)}/schedules`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateSchedule: (agentId: string, scheduleId: string, body: { scheduleExpression?: string }) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: 'PATCH', body: JSON.stringify(body) }
    ),

  deleteSchedule: (agentId: string, scheduleId: string) =>
    request<{ deleted: boolean }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}`,
      { method: 'DELETE' }
    ),

  pauseSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/pause`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  resumeSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/resume`,
      { method: 'POST', body: JSON.stringify({}) }
    ),

  disableSchedule: (agentId: string, scheduleId: string) =>
    request<{ schedule: ScheduleRecord }>(
      `/agents/${encodeURIComponent(agentId)}/schedules/${encodeURIComponent(scheduleId)}/disable`,
      { method: 'POST', body: JSON.stringify({}) }
    ),
};
