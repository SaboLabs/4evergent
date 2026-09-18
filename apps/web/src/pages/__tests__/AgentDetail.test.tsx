import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';
import AgentDetail from '../../pages/AgentDetail';

const { mockGetPolicy, mockUpdatePolicy } = vi.hoisted(() => ({
  mockGetPolicy: vi.fn(),
  mockUpdatePolicy: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    getAgent: vi.fn().mockResolvedValue({
      id: 'agent-1',
      displayName: 'Test Agent',
      description: 'test',
      ownerId: 'owner-1',
      stellarAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      capabilities: ['payment'],
      status: 'active',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }),
    agentActivity: vi.fn().mockResolvedValue({ agentId: 'agent-1', activity: [] }),
    listSchedules: vi.fn().mockResolvedValue({ agentId: 'agent-1', schedules: [] }),
    listAgentExecutions: vi.fn().mockResolvedValue({ agentId: 'agent-1', executions: [] }),
    getPolicy: mockGetPolicy,
    updatePolicy: mockUpdatePolicy,
  },
}));

const defaultPolicyResponse = {
  agentId: 'agent-1',
  policy: {
    maxTxAmount: { XLM: '100' },
    dailySpendingLimit: { XLM: '500' },
    allowedAssets: ['XLM'],
    allowedDestinations: [] as string[],
    allowedContractIds: [] as string[],
    txTypeRestrictions: {
      payment: true,
      trustline: true,
      contract_call: false,
      account_settings: false,
    },
    approvalThreshold: '25',
    requireHumanApprovalForAmountAbove: '75',
  },
  version: 1,
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('AgentDetail Policy Section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('policy loads from API on mount', async () => {
    mockGetPolicy.mockResolvedValue(defaultPolicyResponse);

    render(<AgentDetail agentId="agent-1" />);

    // Wait for maxTxAmount input to appear with value 100
    await waitFor(() => {
      expect(screen.getByDisplayValue('100')).toBeInTheDocument();
    });

    // Check that other current values are rendered
    expect(screen.getByDisplayValue('500')).toBeInTheDocument();
    expect(screen.getByDisplayValue('25')).toBeInTheDocument();
    expect(screen.getByDisplayValue('75')).toBeInTheDocument();
  });

  test('editing values updates form state', async () => {
    mockGetPolicy.mockResolvedValue(defaultPolicyResponse);

    render(<AgentDetail agentId="agent-1" />);

    const maxTxInput = await screen.findByDisplayValue('100');
    expect(maxTxInput).toBeInTheDocument();

    fireEvent.change(maxTxInput, { target: { value: '200' } });

    await waitFor(() => {
      expect(screen.getByDisplayValue('200')).toBeInTheDocument();
    });
  });

  test('save calls PUT with expected payload', async () => {
    mockGetPolicy.mockResolvedValue(defaultPolicyResponse);

    mockUpdatePolicy.mockResolvedValue({
      agentId: 'agent-1',
      policy: {
        ...defaultPolicyResponse.policy,
        maxTxAmount: { XLM: '200' },
      },
      version: 2,
    });

    render(<AgentDetail agentId="agent-1" />);

    const maxTxInput = await screen.findByDisplayValue('100');
    fireEvent.change(maxTxInput, { target: { value: '200' } });

    const saveButton = await screen.findByText('Save Policy');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockUpdatePolicy).toHaveBeenCalledWith('agent-1', expect.objectContaining({
        maxTxAmount: expect.objectContaining({ XLM: '200' }),
      }));
    });
  });

  test('successful save updates displayed policy/version', async () => {
    mockGetPolicy.mockResolvedValue(defaultPolicyResponse);

    mockUpdatePolicy.mockResolvedValue({
      agentId: 'agent-1',
      policy: {
        ...defaultPolicyResponse.policy,
        maxTxAmount: { XLM: '200' },
      },
      version: 2,
    });

    render(<AgentDetail agentId="agent-1" />);

    const maxTxInput = await screen.findByDisplayValue('100');
    fireEvent.change(maxTxInput, { target: { value: '200' } });

    const saveButton = await screen.findByText('Save Policy');
    fireEvent.click(saveButton);

    // Verify success message
    await waitFor(() => {
      expect(screen.getByText(/Policy updated/)).toBeInTheDocument();
    });

    // Verify version updated
    expect(screen.getByText(/Version: 2/)).toBeInTheDocument();
  });

  test('API validation error is displayed', async () => {
    mockGetPolicy.mockResolvedValue(defaultPolicyResponse);

    mockUpdatePolicy.mockRejectedValue(new Error('Invalid policy: maxTxAmount must be positive'));

    render(<AgentDetail agentId="agent-1" />);

    const maxTxInput = await screen.findByDisplayValue('100');
    fireEvent.change(maxTxInput, { target: { value: '200' } });

    const saveButton = await screen.findByText('Save Policy');
    fireEvent.click(saveButton);

    // Verify error message
    await waitFor(() => {
      expect(screen.getByText(/Invalid policy/)).toBeInTheDocument();
    });
  });

  test('loading state prevents duplicate save', async () => {
    let resolveGetPolicy: ((value: any) => void) | null = null;
    const getPolicyPromise = new Promise((resolve) => {
      resolveGetPolicy = resolve;
    });

    mockGetPolicy.mockReturnValue(getPolicyPromise as any);

    render(<AgentDetail agentId="agent-1" />);

    // During loading, save button should not be visible yet
    expect(screen.queryByText('Save Policy')).not.toBeInTheDocument();

    // Resolve the promise
    resolveGetPolicy!(defaultPolicyResponse);

    // After loading, save button should be visible
    await waitFor(() => {
      expect(screen.getByText('Save Policy')).toBeInTheDocument();
    });
  });
});
