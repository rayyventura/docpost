import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import {
  apiRequest,
  clearSessionTokens,
  getAccessToken,
  getRefreshToken,
  refreshSession,
  setOnUnauthorized,
  setSessionTokens,
} from '../api/client';

interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = parts[1];
  const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decoded) as Record<string, unknown>;
}

function getUserFromToken(token: string): User | null {
  try {
    const payload = decodeJwtPayload(token);
    const exp = payload.exp as number | undefined;
    if (exp && exp * 1000 < Date.now()) {
      return null;
    }
    return {
      id: payload.sub as string,
      email: payload.email as string,
      name: payload.name as string,
    };
  } catch {
    return null;
  }
}

interface SessionResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
}

interface RegisterResponse {
  id: string;
  email: string;
  name: string;
}

function applySession(data: SessionResponse): User {
  setSessionTokens(data.accessToken, data.refreshToken);
  const user = getUserFromToken(data.accessToken);
  if (!user) {
    clearSessionTokens();
    throw new Error('Invalid token received');
  }
  return user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const accessToken = getAccessToken();
        const fromAccess = accessToken ? getUserFromToken(accessToken) : null;
        if (fromAccess) {
          if (!cancelled) {
            setUser(fromAccess);
          }
          return;
        }

        if (!getRefreshToken()) {
          clearSessionTokens();
          return;
        }

        const refreshed = await refreshSession();
        if (!refreshed) {
          return;
        }

        const nextAccess = getAccessToken();
        const nextUser = nextAccess ? getUserFromToken(nextAccess) : null;
        if (nextUser && !cancelled) {
          setUser(nextUser);
        }
      } finally {
        if (!cancelled) {
          setReady(true);
        }
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiRequest<SessionResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setUser(applySession(data));
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    await apiRequest<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    await login(email, password);
  }, [login]);

  const logout = useCallback(() => {
    const refreshToken = getRefreshToken();
    clearSessionTokens();
    setUser(null);
    if (!refreshToken) {
      return;
    }
    void apiRequest('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }).catch(() => {
      // Local session is already cleared.
    });
  }, []);

  useEffect(() => {
    setOnUnauthorized(logout);
    return () => setOnUnauthorized(() => {});
  }, [logout]);

  useEffect(() => {
    if (!user) {
      return;
    }

    const token = getAccessToken();
    if (!token) {
      return;
    }

    try {
      const payload = decodeJwtPayload(token);
      const exp = payload.exp as number | undefined;
      if (!exp) {
        return;
      }

      const msUntilExpiry = exp * 1000 - Date.now();
      const wait = Math.max(msUntilExpiry - 5_000, 0);

      const timer = window.setTimeout(() => {
        void (async () => {
          const ok = await refreshSession();
          if (!ok) {
            logout();
            return;
          }
          const nextAccess = getAccessToken();
          const nextUser = nextAccess ? getUserFromToken(nextAccess) : null;
          if (nextUser) {
            setUser(nextUser);
          } else {
            logout();
          }
        })();
      }, wait);

      return () => window.clearTimeout(timer);
    } catch {
      // Invalid token. Let the next API call handle it.
    }
  }, [user, logout]);

  const value: AuthState = {
    user,
    isAuthenticated: user !== null,
    ready,
    login,
    register,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
