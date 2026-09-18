import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { test, expect, describe, vi, beforeEach } from 'vitest';

const { mockGetStoredToken, mockStoreAuth, mockClearAuth, mockApiHealth } = vi.hoisted(() => ({
  mockGetStoredToken: vi.fn(),
  mockStoreAuth: vi.fn(),
  mockClearAuth: vi.fn(),
  mockApiHealth: vi.fn(),
}));

vi.mock('../auth', () => ({
  getStoredToken: mockGetStoredToken,
  getStoredSubject: vi.fn().mockReturnValue('test-user'),
  storeAuth: mockStoreAuth,
  clearAuth: mockClearAuth,
}));

vi.mock('../api', () => ({
  api: {
    health: mockApiHealth,
  },
}));

import { AuthGate } from '../AuthGate';

function renderAuth() {
  return render(
    <AuthGate>
      <div data-testid="dashboard">Dashboard Content</div>
    </AuthGate>
  );
}

async function waitForLoginForm() {
  await waitFor(() => {
    expect(screen.getByText('Enter your access token to continue')).toBeInTheDocument();
  });
}

describe('AuthGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('shows login screen when no token stored', async () => {
    mockGetStoredToken.mockReturnValue(null);

    renderAuth();

    await waitForLoginForm();

    expect(screen.getByText('4evergent')).toBeInTheDocument();
  });

  test('shows verifying state when token exists but not yet validated', () => {
    mockGetStoredToken.mockReturnValue('some-token');
    mockApiHealth.mockReturnValue(new Promise(() => {})); // pending forever

    renderAuth();

    expect(screen.getByText('Verifying session...')).toBeInTheDocument();
  });

  test('shows dashboard when token is valid', async () => {
    mockGetStoredToken.mockReturnValue('valid-token');
    mockApiHealth.mockResolvedValue({ status: 'ok', signerAccountId: 'GTEST' });

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
  });

  test('shows login when stored token is invalid', async () => {
    mockGetStoredToken.mockReturnValue('invalid-token');
    mockApiHealth.mockRejectedValue(new Error('401 Unauthorized'));

    renderAuth();

    await waitForLoginForm();

    expect(mockClearAuth).toHaveBeenCalled();
  });

  test('login with empty token shows error', async () => {
    mockGetStoredToken.mockReturnValue(null);

    renderAuth();

    await waitForLoginForm();

    const submitButton = screen.getByText('Sign In');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText('Please enter a token')).toBeInTheDocument();
    });
  });

  test('successful login stores token and shows dashboard', async () => {
    mockGetStoredToken.mockReturnValue(null);
    mockApiHealth.mockResolvedValue({ status: 'ok', signerAccountId: 'GTEST' });

    renderAuth();

    await waitForLoginForm();

    const input = screen.getByLabelText('Access Token');
    fireEvent.change(input, { target: { value: 'my-token' } });

    const submitButton = screen.getByText('Sign In');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(mockStoreAuth).toHaveBeenCalledWith('my-token', 'pending');
    });

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });
  });

  test('failed login shows error message', async () => {
    mockGetStoredToken.mockReturnValue(null);
    mockApiHealth.mockRejectedValue(new Error('401 Unauthorized'));

    renderAuth();

    await waitForLoginForm();

    const input = screen.getByLabelText('Access Token');
    fireEvent.change(input, { target: { value: 'bad-token' } });

    const submitButton = screen.getByText('Sign In');
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(screen.getByText(/Invalid token or authentication failed/)).toBeInTheDocument();
    });

    expect(mockClearAuth).toHaveBeenCalled();
  });

  test('logout clears auth and shows login', async () => {
    mockGetStoredToken.mockReturnValue('valid-token');
    mockApiHealth.mockResolvedValue({ status: 'ok', signerAccountId: 'GTEST' });

    renderAuth();

    await waitFor(() => {
      expect(screen.getByTestId('dashboard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Sign Out'));

    await waitForLoginForm();

    expect(mockClearAuth).toHaveBeenCalled();
  });
});
