import {
  clearSessionTokens,
  getAccessToken,
  getRefreshToken,
  setSessionTokens,
} from './session';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

let onUnauthorized: (() => void) | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setOnUnauthorized(callback: () => void): void {
  onUnauthorized = callback;
}

interface RefreshResponse {
  accessToken?: string;
  refreshToken?: string;
}

async function refreshSessionOnce(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      clearSessionTokens();
      return false;
    }

    const data = (await response.json()) as RefreshResponse;
    if (!data.accessToken || !data.refreshToken) {
      clearSessionTokens();
      return false;
    }

    setSessionTokens(data.accessToken, data.refreshToken);
    return true;
  } catch {
    return false;
  }
}

export function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = refreshSessionOnce().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  return apiRequestInner(path, options, false);
}

async function apiRequestInner<T>(path: string, options: RequestInit, retried: boolean): Promise<T> {
  const token = getAccessToken();
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
    if (!retried) {
      const refreshed = await refreshSession();
      if (refreshed) {
        return apiRequestInner(path, options, true);
      }
    }
    clearSessionTokens();
    onUnauthorized?.();
    throw new Error('Unauthorized');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: 'Request failed' } }));
    throw new Error(error.error?.message || 'Request failed');
  }

  return response.json() as Promise<T>;
}

export async function apiDownload(path: string, filename: string): Promise<void> {
  const { url } = await apiRequest<{ url: string }>(path);
  if (!url) {
    throw new Error('Download failed');
  }

  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export { getAccessToken, getRefreshToken, setSessionTokens, clearSessionTokens };
