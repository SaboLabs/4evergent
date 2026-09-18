import { useState, useEffect, useCallback } from 'react';
import { getStoredToken, storeAuth, clearAuth, getStoredSubject } from './auth';
import { api } from './api';

interface AuthProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthProps) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = getStoredToken();
    if (token) {
      // Verify token is still valid by hitting health endpoint
      api.health()
        .then(() => setAuthenticated(true))
        .catch(() => {
          clearAuth();
          setAuthenticated(false);
        });
    } else {
      setAuthenticated(false);
    }
  }, []);

  const handleLogin = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setLoginError(null);

    const formData = new FormData(e.currentTarget);
    const token = formData.get('token') as string;

    if (!token || token.trim().length === 0) {
      setLoginError('Please enter a token');
      setLoading(false);
      return;
    }

    // Store token temporarily and test it
    storeAuth(token.trim(), 'pending');

    try {
      const health = await api.health();
      // If we get here, token is valid
      const subject = getStoredSubject() ?? 'authenticated-user';
      storeAuth(token.trim(), subject);
      setAuthenticated(true);
    } catch (err) {
      clearAuth();
      setLoginError('Invalid token or authentication failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleLogout = useCallback(() => {
    clearAuth();
    setAuthenticated(false);
  }, []);

  if (authenticated === null) {
    return (
      <div className="auth-screen">
        <div className="auth-box">
          <div className="auth-logo">▲</div>
          <h1>4evergent</h1>
          <p className="muted">Verifying session...</p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="auth-screen">
        <form className="auth-box" onSubmit={handleLogin}>
          <div className="auth-logo">▲</div>
          <h1>4evergent</h1>
          <p className="muted">Enter your access token to continue</p>

          <div className="auth-field">
            <label htmlFor="token">Access Token</label>
            <input
              id="token"
              name="token"
              type="password"
              placeholder="Enter your Bearer token"
              autoComplete="off"
              autoFocus
            />
          </div>

          {loginError && <div className="error">{loginError}</div>}

          <button type="submit" disabled={loading} className="auth-submit">
            {loading ? 'Authenticating...' : 'Sign In'}
          </button>

          <div className="auth-help">
            <p className="muted">Development: Any non-empty token works with DevAuthProvider.</p>
            <p className="muted">Production: Use a valid API key or JWT.</p>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="app-with-logout">
      <LogoutButton onLogout={handleLogout} />
      {children}
    </div>
  );
}

function LogoutButton({ onLogout }: { onLogout: () => void }) {
  return (
    <button className="logout-btn" onClick={onLogout} title="Sign out">
      Sign Out
    </button>
  );
}
