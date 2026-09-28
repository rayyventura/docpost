import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { errorHandler } from '@docpost/shared';
import { httpRequest, listen, type TestServer } from '../test-utils/http.js';
import { userToken } from '../test-utils/fakeAuth.js';

const auth = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../middleware/auth.js', async () => {
  const { fakeRequireUserAuth } = await import('../test-utils/fakeAuth.js');
  return {
    requireUserAuth: (...args: Parameters<typeof fakeRequireUserAuth>) => {
      auth.calls += 1;
      fakeRequireUserAuth(...args);
    },
  };
});

const { default: destinationsRouter } = await import('./destinations.js');

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:3002';
const token = userToken(crypto.randomUUID());

let server: TestServer;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const app = express();
  app.use(destinationsRouter);
  // Stands in for the routers mounted after this one in app.ts (jobs, files).
  app.get('/jobs', (_req, res) => {
    res.json({ reached: true });
  });
  app.use(errorHandler);
  server = await listen(app);
});

afterAll(async () => {
  await server?.close();
});

beforeEach(() => {
  auth.calls = 0;
  fetchMock = vi.fn(async () => Response.json([{ id: 't1', name: 'Team One' }]));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const routes: Array<[string, string]> = [
  ['/destinations/teams', '/teams?docPostEnabled=true'],
  ['/destinations/teams/t-1/binders', '/teams/t-1/binders'],
  ['/destinations/binders/b-1/contents', '/binders/b-1/contents'],
  ['/destinations/folders/f-1/contents', '/folders/f-1/contents'],
  ['/destinations/documents/d-1/download', '/documents/d-1/download'],
];

describe('destinations proxy', () => {
  it.each(routes)('%s requires authentication', async (path) => {
    const res = await httpRequest(server.baseUrl, 'GET', path);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(routes)('%s verifies the JWT exactly once per request', async (path) => {
    await httpRequest(server.baseUrl, 'GET', path, { token });
    expect(auth.calls).toBe(1);
  });

  it('does not authenticate routes outside /destinations (mounted at root)', async () => {
    const res = await httpRequest(server.baseUrl, 'GET', '/jobs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reached: true });
    expect(auth.calls).toBe(0);
  });

  it('lets unknown routes fall through to 404 instead of 401', async () => {
    const res = await httpRequest(server.baseUrl, 'GET', '/no-such-route');
    expect(res.status).toBe(404);
    expect(auth.calls).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(routes)('%s forwards to platform %s with the caller JWT', async (path, platformPath) => {
    const res = await httpRequest(server.baseUrl, 'GET', path, { token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 't1', name: 'Team One' }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PLATFORM_URL}${platformPath}`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('passes platform 4xx responses through unchanged', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: { code: 'FORBIDDEN', message: 'Not a member' } }, { status: 403 }),
    );
    const res = await httpRequest(server.baseUrl, 'GET', '/destinations/teams/t-1/binders', { token });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'FORBIDDEN', message: 'Not a member' } });
  });

  it.each([500, 502, 503])('maps a platform %i to 502 UPSTREAM_ERROR', async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'boom' }, { status }));
    const res = await httpRequest(server.baseUrl, 'GET', '/destinations/teams', { token });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { code: 'UPSTREAM_ERROR', message: 'Platform service unavailable' } });
  });

  it('maps a non-JSON platform error page to 502', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>Bad Gateway</html>', { status: 504 }));
    const res = await httpRequest(server.baseUrl, 'GET', '/destinations/teams', { token });
    expect(res.status).toBe(502);
  });

  it('maps a network failure to 502', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const res = await httpRequest(server.baseUrl, 'GET', '/destinations/teams', { token });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
  });

  it('aborts the platform call after 5 seconds and returns 502', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let aborted = false;
      fetchMock.mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              aborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      );

      const pending = httpRequest(server.baseUrl, 'GET', '/destinations/teams', { token });
      // Poll on setImmediate (not faked) so fake time does not move while we wait.
      while (fetchMock.mock.calls.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      await vi.advanceTimersByTimeAsync(4_999);
      expect(aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(aborted).toBe(true);

      const res = await pending;
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    } finally {
      vi.useRealTimers();
    }
  });
});
