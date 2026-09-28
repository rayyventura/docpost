import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiRequest session refresh', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: memoryStorage(),
    });
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: memoryStorage(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes once on 401, rotates tokens in sessionStorage, and retries the request', async () => {
    sessionStorage.setItem('accessToken', 'expired-access');
    sessionStorage.setItem('refreshToken', 'refresh-1');

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/jobs') && init?.headers && (init.headers as Record<string, string>).Authorization === 'Bearer expired-access') {
        return jsonResponse({ error: { message: 'Unauthorized' } }, 401);
      }
      if (url.endsWith('/auth/refresh')) {
        expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh-1' });
        expect((init?.headers as Record<string, string>)['Authorization']).toBeUndefined();
        return jsonResponse({
          accessToken: 'new-access',
          refreshToken: 'refresh-2',
          expiresIn: 900,
          refreshExpiresIn: 604800,
        });
      }
      if (url.endsWith('/jobs')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer new-access');
        return jsonResponse({ jobs: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { apiRequest } = await import('./client');
    await expect(apiRequest('/jobs')).resolves.toEqual({ jobs: [] });

    expect(sessionStorage.getItem('accessToken')).toBe('new-access');
    expect(sessionStorage.getItem('refreshToken')).toBe('refresh-2');
    expect(localStorage.length).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('clears the session and reports unauthorized when refresh fails', async () => {
    sessionStorage.setItem('accessToken', 'expired-access');
    sessionStorage.setItem('refreshToken', 'refresh-1');

    const onUnauthorized = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/jobs')) {
          return jsonResponse({ error: { message: 'Unauthorized' } }, 401);
        }
        if (url.endsWith('/auth/refresh')) {
          return jsonResponse({ error: { message: 'Invalid refresh token' } }, 401);
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const { apiRequest, setOnUnauthorized } = await import('./client');
    setOnUnauthorized(onUnauthorized);

    await expect(apiRequest('/jobs')).rejects.toThrow('Unauthorized');
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem('accessToken')).toBeNull();
    expect(sessionStorage.getItem('refreshToken')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('single-flights concurrent 401s through one refresh', async () => {
    sessionStorage.setItem('accessToken', 'expired-access');
    sessionStorage.setItem('refreshToken', 'refresh-1');

    let refreshCalls = 0;
    let releaseRefresh: (value: Response) => void = () => {};
    const refreshGate = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/jobs') && (init?.headers as Record<string, string>).Authorization === 'Bearer expired-access') {
          return jsonResponse({ error: { message: 'Unauthorized' } }, 401);
        }
        if (url.endsWith('/auth/refresh')) {
          refreshCalls += 1;
          return refreshGate;
        }
        if (url.endsWith('/jobs')) {
          return jsonResponse({ ok: true });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const { apiRequest } = await import('./client');
    const pending = Promise.all([apiRequest('/jobs'), apiRequest('/jobs')]);
    await Promise.resolve();
    expect(refreshCalls).toBe(1);
    releaseRefresh(
      jsonResponse({
        accessToken: 'new-access',
        refreshToken: 'refresh-2',
        expiresIn: 900,
        refreshExpiresIn: 604800,
      }),
    );
    await expect(pending).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCalls).toBe(1);
  });
});
