import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { apiRequest, setToken, clearToken, setOnUnauthorized } from '../api/client';

interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
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

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
}

interface RegisterResponse {
  id: string;
  email: string;
  name: string;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const token = sessionStorage.getItem('accessToken');
    if (token) {
      const u = getUserFromToken(token);
      if (u) {
        setUser(u);
      } else {
        clearToken();
      }
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiRequest<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setToken(data.accessToken);
    const u = getUserFromToken(data.accessToken);
    if (!u) {
      throw new Error('Invalid token received');
    }
    setUser(u);
  }, []);

  const register = useCallback(async (email: string, password: string, name: string) => {
    await apiRequest<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    // Auto-login after registration
    await login(email, password);
  }, [login]);

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  useEffect(() => {
    setOnUnauthorized(logout);
    return () => setOnUnauthorized(() => {});
  }, [logout]);

  const value: AuthState = {
    user,
    isAuthenticated: user !== null,
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
