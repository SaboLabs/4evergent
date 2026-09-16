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
};
