const API_BASE = import.meta.env.VITE_API_BASE ?? '';

let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(callback: () => void): void {
  onUnauthorized = callback;
}

function getToken(): string | null {
  return sessionStorage.getItem('accessToken');
}

export function setToken(token: string): void {
  sessionStorage.setItem('accessToken', token);
}

export function clearToken(): void {
  sessionStorage.removeItem('accessToken');
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 401 && !path.startsWith('/auth/')) {
    clearToken();
    onUnauthorized?.();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new Error(error.error?.message || 'Request failed');
  }

  return response.json() as Promise<T>;
}
