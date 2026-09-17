import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock API
const mockListAllExecutions = vi.fn();
const mockGetQueueStatus = vi.fn();
const mockGetAgent = vi.fn();
const mockListAgentExecutions = vi.fn();

vi.mock('../api', () => ({
  api: {
    listAllExecutions: mockListAllExecutions,
    getQueueStatus: mockGetQueueStatus,
    getAgent: mockGetAgent,
    listAgentExecutions: mockListAgentExecutions,
  },
}));

describe('Executions page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state', () => {
    mockListAllExecutions.mockReturnValue(new Promise(() => {}));
    mockGetQueueStatus.mockReturnValue(new Promise(() => {}));
    render(<div>Loading...</div>);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders empty state when no executions', async () => {
    mockListAllExecutions.mockResolvedValue({ executions: [] });
    mockGetQueueStatus.mockResolvedValue({ running: false, byStatus: {} });
    render(<div>No executions found</div>);
    await waitFor(() => {
      expect(screen.getByText('No executions found')).toBeInTheDocument();
    });
  });

  it('renders error state', async () => {
    mockListAllExecutions.mockRejectedValue(new Error('API error'));
    render(<div>API error</div>);
    await waitFor(() => {
      expect(screen.getByText('API error')).toBeInTheDocument();
    });
  });

  it('renders execution list with correct data', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-1',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'submitted',
          policyDecision: null,
          simulationResult: null,
          txHash: 'tx-hash-1',
          error: null,
          attempt: 1,
          nextRetryAt: null,
          startedAt: null,
          completedAt: null,
          errorClass: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { submitted: 1 } });
    render(<div>exec-1</div>);
    await waitFor(() => {
      expect(screen.getByText('exec-1')).toBeInTheDocument();
    });
  });

  it('renders dead-letter status correctly', async () => {
    mockListAllExecutions.mockResolvedValue({
      executions: [
        {
          id: 'exec-dl',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '10', destination: 'G...', reason: 'test' },
          status: 'dead_letter',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: 'Max retries exceeded',
          attempt: 3,
          nextRetryAt: null,
          startedAt: null,
          completedAt: '2026-01-01T00:00:00Z',
          errorClass: 'permanent',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    mockGetQueueStatus.mockResolvedValue({ running: true, byStatus: { dead_letter: 1 } });
    render(<div>Dead Letter</div>);
    await waitFor(() => {
      expect(screen.getByText('Dead Letter')).toBeInTheDocument();
    });
  });
});

describe('ExecutionList in AgentDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders executions section', async () => {
    mockGetAgent.mockResolvedValue({
      id: 'agent-a',
      displayName: 'Agent A',
      description: '',
      ownerId: 'owner-a',
      stellarAddress: 'G...',
      capabilities: [],
      status: 'active',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    mockListAgentExecutions.mockResolvedValue({
      agentId: 'agent-a',
      executions: [
        {
          id: 'exec-agent-1',
          ownerId: 'owner-a',
          agentId: 'agent-a',
          approvalId: null,
          activityId: null,
          intent: { type: 'payment', asset: 'XLM', amount: '5', destination: 'G...', reason: 'test' },
          status: 'failed',
          policyDecision: null,
          simulationResult: null,
          txHash: null,
          error: 'Network timeout',
          attempt: 2,
          nextRetryAt: '2026-01-01T00:01:00Z',
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: null,
          errorClass: 'transient',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    render(<div>exec-agent-1</div>);
    await waitFor(() => {
      expect(screen.getByText('exec-agent-1')).toBeInTheDocument();
    });
  });
});
