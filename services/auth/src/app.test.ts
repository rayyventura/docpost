import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { listen, getJson, postJson, type RunningServer } from './testing/http.js';
import { initKeys } from './crypto/keys.js';

vi.mock('./db/index.js', () => ({
  getDb: () => {
    throw new Error('unit tests must not reach the database');
  },
}));

const { createApp } = await import('./app.js');

let server: RunningServer;

beforeAll(async () => {
  await initKeys();
  server = await listen(createApp());
});

afterAll(async () => {
  await server.close();
});

describe('createApp', () => {
  it('serves /health', async () => {
    const res = await getJson(server.baseUrl, '/health');
    expect(res).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('answers CORS preflight OPTIONS with 204', async () => {
    const res = await fetch(`${server.baseUrl}/auth/login`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
  });

  it.each([
    ['/.well-known/jwks.json', 'GET'],
    ['/.well-known/openid-configuration', 'GET'],
  ])('mounts %s', async (path, method) => {
    const res = await fetch(`${server.baseUrl}${path}`, { method });
    expect(res.status).toBe(200);
  });

  it.each(['/auth/register', '/auth/login', '/auth/refresh', '/auth/logout', '/auth/token', '/auth/password/forgot', '/auth/password/reset'])(
    'mounts POST %s behind JSON validation',
    async (path) => {
      const res = await postJson<{ error: { code: string } }>(server.baseUrl, path, {});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    },
  );

  it('does not echo malformed JSON bodies back to the client', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": secret-value',
    });
    expect(await res.text()).not.toContain('secret-value');
    consoleError.mockRestore();
  });

  // BUG: express.json() raises a SyntaxError with status 400 for a malformed body, but the shared
  // errorHandler only maps AppError and 413, so a client error is reported as 500 INTERNAL_ERROR
  // (and logged as an unhandled server error). Fix belongs in packages/shared error-handler.
  it.fails('returns 400 (not 500) for a malformed JSON body', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": ',
    });
    consoleError.mockRestore();
    expect(res.status).toBe(400);
  });
});
