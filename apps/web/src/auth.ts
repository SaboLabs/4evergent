// Authentication context for 4evergent dashboard.
//
// Backend authentication is authoritative.
// Frontend only stores a Bearer token for session continuity.
// Token is stored in sessionStorage (cleared on tab close).

const TOKEN_KEY = '4evergent.auth.token';
const SUBJECT_KEY = '4evergent.auth.subject';

export interface AuthState {
  token: string | null;
  isAuthenticated: boolean;
}

export function getStoredToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredSubject(): string | null {
  try {
    return sessionStorage.getItem(SUBJECT_KEY);
  } catch {
    return null;
  }
}

export function storeAuth(token: string, subject: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(SUBJECT_KEY, subject);
  } catch {
    // Storage unavailable — auth will be session-only in memory
  }
}

export function clearAuth(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(SUBJECT_KEY);
  } catch {
    // Ignore
  }
}
