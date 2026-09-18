import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';
import { ScheduleManagement } from '../../pages/ScheduleManagement';

const { mockListSchedules, mockCreateSchedule, mockPauseSchedule, mockDisableSchedule, mockDeleteSchedule } = vi.hoisted(() => ({
  mockListSchedules: vi.fn(),
  mockCreateSchedule: vi.fn(),
  mockPauseSchedule: vi.fn(),
  mockDisableSchedule: vi.fn(),
  mockDeleteSchedule: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    listSchedules: mockListSchedules,
    createSchedule: mockCreateSchedule,
    pauseSchedule: mockPauseSchedule,
    resumeSchedule: vi.fn().mockResolvedValue({}),
    disableSchedule: mockDisableSchedule,
    deleteSchedule: mockDeleteSchedule,
  },
}));

const defaultSchedule = {
  id: 'sched-1',
  agentId: 'agent-1',
  ownerId: 'owner-1',
  status: 'active',
  intent: {
    type: 'payment',
    asset: 'XLM',
    amount: '10',
    destination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    reason: 'Test schedule',
  },
  scheduleExpression: '0 0 * * *',
  timezone: 'UTC',
  nextRunAt: '2026-01-02T00:00:00Z',
  lastRunAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('ScheduleManagement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('schedule list loads from API', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [defaultSchedule] });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('0 0 * * *')).toBeInTheDocument();
    });

    expect(screen.getByText('active')).toBeInTheDocument();
  });

  test('empty schedule state', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [] });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText(/No schedules for this agent/)).toBeInTheDocument();
    });
  });

  test('schedule loading state', () => {
    mockListSchedules.mockReturnValue(new Promise(() => {}));

    render(<ScheduleManagement agentId="agent-1" />);

    expect(screen.getByText('Loading schedules...')).toBeInTheDocument();
  });

  test('create form renders', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [] });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    expect(screen.getByText('New Recurring Schedule')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('10')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('G...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Recurring payment')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0 0 * * * (minute hour day-of-month month day-of-week)')).toBeInTheDocument();
  });

  test('validation blocks invalid submission', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [] });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    // Try to submit empty form
    const submitButton = await screen.findByText('Create Schedule');
    fireEvent.click(submitButton);

    // Form should still be visible (not submitted)
    expect(screen.getByText('New Recurring Schedule')).toBeInTheDocument();
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  test('create sends expected payload', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [] });
    mockCreateSchedule.mockResolvedValue({ schedule: defaultSchedule });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    // Fill form using placeholder selectors
    const amountInput = await screen.findByPlaceholderText('10');
    fireEvent.change(amountInput, { target: { value: '25' } });

    const destInput = screen.getByPlaceholderText('G...');
    fireEvent.change(destInput, { target: { value: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' } });

    const reasonInput = screen.getByPlaceholderText('Recurring payment');
    fireEvent.change(reasonInput, { target: { value: 'Monthly payment' } });

    const exprInput = screen.getByPlaceholderText('0 0 * * * (minute hour day-of-month month day-of-week)');
    fireEvent.change(exprInput, { target: { value: '0 0 1 * *' } });

    // Submit
    const submitButton = screen.getByText('Create Schedule');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockCreateSchedule).toHaveBeenCalledWith('agent-1', expect.objectContaining({
        intent: expect.objectContaining({
          type: 'payment',
          amount: '25',
          destination: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
          reason: 'Monthly payment',
        }),
        scheduleExpression: '0 0 1 * *',
        timezone: 'UTC',
      }));
    });
  });

  test('successful create refreshes schedule list', async () => {
    mockListSchedules.mockResolvedValueOnce({ schedules: [] });
    mockCreateSchedule.mockResolvedValue({ schedule: defaultSchedule });
    mockListSchedules.mockResolvedValueOnce({ schedules: [defaultSchedule] });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    // Fill and submit
    const amountInput = await screen.findByPlaceholderText('10');
    fireEvent.change(amountInput, { target: { value: '10' } });

    const destInput = screen.getByPlaceholderText('G...');
    fireEvent.change(destInput, { target: { value: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' } });

    const reasonInput = screen.getByPlaceholderText('Recurring payment');
    fireEvent.change(reasonInput, { target: { value: 'Test' } });

    const exprInput = screen.getByPlaceholderText('0 0 * * * (minute hour day-of-month month day-of-week)');
    fireEvent.change(exprInput, { target: { value: '0 0 * * *' } });

    const submitButton = screen.getByText('Create Schedule');
    fireEvent.click(submitButton);

    // After successful create, form should close and list should refresh
    await waitFor(() => {
      expect(screen.queryByText('New Recurring Schedule')).not.toBeInTheDocument();
    });
  });

  test('API error displayed', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [] });
    mockCreateSchedule.mockRejectedValue(new Error('Invalid schedule expression'));

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    // Fill form
    const amountInput = await screen.findByPlaceholderText('10');
    fireEvent.change(amountInput, { target: { value: '10' } });

    const destInput = screen.getByPlaceholderText('G...');
    fireEvent.change(destInput, { target: { value: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' } });

    const reasonInput = screen.getByPlaceholderText('Recurring payment');
    fireEvent.change(reasonInput, { target: { value: 'Test' } });

    const exprInput = screen.getByPlaceholderText('0 0 * * * (minute hour day-of-month month day-of-week)');
    fireEvent.change(exprInput, { target: { value: 'invalid' } });

    const submitButton = screen.getByText('Create Schedule');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/Invalid schedule expression/)).toBeInTheDocument();
    });
  });

  test('duplicate create prevented while saving', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [] });

    let resolveCreate: ((value: any) => void) | null = null;
    const createPromise = new Promise((resolve) => {
      resolveCreate = resolve;
    });
    mockCreateSchedule.mockReturnValue(createPromise as any);

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    // Fill form
    const amountInput = await screen.findByPlaceholderText('10');
    fireEvent.change(amountInput, { target: { value: '10' } });

    const destInput = screen.getByPlaceholderText('G...');
    fireEvent.change(destInput, { target: { value: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' } });

    const reasonInput = screen.getByPlaceholderText('Recurring payment');
    fireEvent.change(reasonInput, { target: { value: 'Test' } });

    const exprInput = screen.getByPlaceholderText('0 0 * * * (minute hour day-of-month month day-of-week)');
    fireEvent.change(exprInput, { target: { value: '0 0 * * *' } });

    const submitButton = screen.getByText('Create Schedule');
    fireEvent.click(submitButton);

    // Button should show "Creating..." and be disabled
    await waitFor(() => {
      expect(screen.getByText('Creating...')).toBeInTheDocument();
    });

    // Resolve the promise
    resolveCreate!({ schedule: defaultSchedule });
  });

  test('pause action calls API', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [defaultSchedule] });
    mockPauseSchedule.mockResolvedValue({ schedule: { ...defaultSchedule, status: 'paused' } });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Pause')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Pause'));

    await waitFor(() => {
      expect(mockPauseSchedule).toHaveBeenCalledWith('agent-1', 'sched-1');
    });
  });

  test('disable action calls API', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [defaultSchedule] });
    mockDisableSchedule.mockResolvedValue({ schedule: { ...defaultSchedule, status: 'disabled' } });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Disable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Disable'));

    await waitFor(() => {
      expect(mockDisableSchedule).toHaveBeenCalledWith('agent-1', 'sched-1');
    });
  });

  test('delete confirmation + delete request', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [defaultSchedule] });
    mockDeleteSchedule.mockResolvedValue({ deleted: true });
    window.confirm = vi.fn(() => true);

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Delete'));

    expect(window.confirm).toHaveBeenCalledWith('Delete this schedule? This cannot be undone.');

    await waitFor(() => {
      expect(mockDeleteSchedule).toHaveBeenCalledWith('agent-1', 'sched-1');
    });
  });

  test('cron preset buttons work', async () => {
    mockListSchedules.mockResolvedValue({ schedules: [] });

    render(<ScheduleManagement agentId="agent-1" />);

    await waitFor(() => {
      expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    // Click a preset
    const dailyPreset = await screen.findByText('Daily (midnight)');
    fireEvent.click(dailyPreset);

    // Check that the expression input was updated
    const exprInput = screen.getByPlaceholderText('0 0 * * * (minute hour day-of-month month day-of-week)') as HTMLInputElement;
    expect(exprInput.value).toBe('0 0 * * *');
  });
});
