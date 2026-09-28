import type { APIGatewayProxyResult } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, render, type DbCall } from './test-utils/fake-db.js';

const mocks = vi.hoisted(() => {
  // session.ts reads these at import time.
  process.env.AUTH_JWKS_URL = 'http://auth.test/.well-known/jwks.json';
  process.env.AUTH_TOKEN_URL = 'http://auth.test/auth/token';
  process.env.PLATFORM_URL = 'http://platform.test';
  process.env.SERVICE_CLIENT_ID = 'ws-worker';
  process.env.SERVICE_CLIENT_SECRET = 'ws-secret';
  return {
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn((url: URL) => ({ jwksUrl: url.toString() })),
    db: undefined as unknown,
  };
});

vi.mock('jose', () => ({ jwtVerify: mocks.jwtVerify, createRemoteJWKSet: mocks.createRemoteJWKSet }));
vi.mock('./db.js', () => ({ getDb: async () => mocks.db }));

import { handler as wsHandler } from './handler.js';

const handler = (event: unknown) => wsHandler(event, {} as never, () => {}) as Promise<APIGatewayProxyResult>;

const OWNER = '11111111-1111-4111-8111-111111111111';
const VIEWER = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';

function serviceJwt(): string {
  const payload = { sub: 'ws-worker', token_use: 'service', exp: Math.floor(Date.now() / 1000) + 900 };
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}
const SERVICE_TOKEN = serviceJwt();

interface Scenario {
  connectionUserId?: string | null;
  jobOwner?: string | null;
}

function setupDb({ connectionUserId = VIEWER, jobOwner = OWNER }: Scenario = {}) {
  const fake = fakeDb((call: DbCall) => {
    if (call.op === 'select' && call.tableName === 'ws_connections') {
      return connectionUserId ? [{ userId: connectionUserId }] : [];
    }
    if (call.op === 'select' && call.tableName === 'jobs') return jobOwner ? [{ submittedByUserId: jobOwner }] : [];
    return [];
  });
  mocks.db = fake.db;
  return fake.calls;
}

let teams: Record<string, string[] | 'error'>;
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

function connectEvent(token?: string, connectionId = 'conn-1') {
  return {
    requestContext: { routeKey: '$connect', connectionId },
    queryStringParameters: token === undefined ? null : { token },
  };
}
function subscribeEvent(body: unknown, connectionId = 'conn-1') {
  return { requestContext: { routeKey: 'subscribe', connectionId }, body: JSON.stringify(body) };
}

beforeEach(() => {
  mocks.jwtVerify.mockReset();
  teams = { [OWNER]: ['team-a', 'team-b'], [VIEWER]: ['team-b'] };
  fetchMock.mockReset().mockImplementation(async (url) => {
    if (url === 'http://auth.test/auth/token') return Response.json({ accessToken: SERVICE_TOKEN, expiresIn: 900 });
    const match = /^http:\/\/platform\.test\/internal\/users\/([^/]+)\/teams$/.exec(url);
    if (match) {
      const list = teams[match[1]];
      if (list === 'error') return new Response('', { status: 500 });
      return Response.json({ teamIds: list ?? [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ws $connect', () => {
  it('rejects a connection without a token (401) and stores nothing', async () => {
    const calls = setupDb();
    await expect(handler(connectEvent())).resolves.toEqual({ statusCode: 401, body: 'unauthorized' });
    expect(mocks.jwtVerify).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('rejects an invalid or expired token', async () => {
    const calls = setupDb();
    mocks.jwtVerify.mockRejectedValue(Object.assign(new Error('"exp" claim timestamp check failed'), { code: 'ERR_JWT_EXPIRED' }));
    await expect(handler(connectEvent('bad.token.here'))).resolves.toMatchObject({ statusCode: 401 });
    expect(calls).toHaveLength(0);
  });

  it('rejects service tokens (token_use=service)', async () => {
    const calls = setupDb();
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: 'delivery-worker', token_use: 'service' } });
    await expect(handler(connectEvent('svc'))).resolves.toMatchObject({ statusCode: 401 });
    expect(calls).toHaveLength(0);
  });

  it('rejects tokens without a subject', async () => {
    setupDb();
    mocks.jwtVerify.mockResolvedValue({ payload: { email: 'x@example.com' } });
    await expect(handler(connectEvent('nosub'))).resolves.toMatchObject({ statusCode: 401 });
  });

  it('accepts a valid user JWT (verified against JWKS) and registers the connection', async () => {
    const calls = setupDb();
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: VIEWER, email: 'v@example.com' } });

    await expect(handler(connectEvent('good-token', 'conn-9'))).resolves.toEqual({ statusCode: 200, body: 'connected' });

    const [token, keySet, options] = mocks.jwtVerify.mock.calls[0];
    expect(token).toBe('good-token');
    expect(keySet).toEqual({ jwksUrl: 'http://auth.test/.well-known/jwks.json' });
    expect(options).toEqual({ issuer: 'docpost-auth', algorithms: ['RS256'] });

    const insert = calls.find((c) => c.op === 'insert')!;
    expect(insert.tableName).toBe('ws_connections');
    expect(insert.values).toEqual({ connectionId: 'conn-9', userId: VIEWER });
    // Re-used connection ids are reset rather than failing on the primary key.
    expect(insert.conflict).toMatchObject({ set: { userId: VIEWER, jobId: null, connectedAt: expect.any(Date) } });
  });
});

describe('ws $disconnect', () => {
  it('deletes the connection row', async () => {
    const calls = setupDb();
    await expect(
      handler({ requestContext: { routeKey: '$disconnect', connectionId: 'conn-1' } }),
    ).resolves.toEqual({ statusCode: 200, body: 'disconnected' });
    const del = calls.find((c) => c.op === 'delete')!;
    expect(del.tableName).toBe('ws_connections');
    expect(render(del.where).params).toEqual(['conn-1']);
  });
});

describe('ws subscribe', () => {
  it('requires a jobId', async () => {
    const calls = setupDb();
    await expect(handler(subscribeEvent({ action: 'subscribe' }))).resolves.toEqual({
      statusCode: 400,
      body: 'jobId is required',
    });
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown connections with 401', async () => {
    const calls = setupDb({ connectionUserId: null });
    await expect(handler(subscribeEvent({ action: 'subscribe', jobId: JOB }))).resolves.toMatchObject({ statusCode: 401 });
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('returns 404 for a job that does not exist', async () => {
    const calls = setupDb({ jobOwner: null });
    await expect(handler(subscribeEvent({ action: 'subscribe', jobId: JOB }))).resolves.toEqual({
      statusCode: 404,
      body: 'Job not found',
    });
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('registers the connection for the job when the caller submitted it', async () => {
    const calls = setupDb({ connectionUserId: OWNER });

    const res = await handler(subscribeEvent({ action: 'subscribe', jobId: JOB }, 'conn-7'));

    expect(res).toEqual({ statusCode: 200, body: JSON.stringify({ type: 'subscribed', jobId: JOB }) });
    const connLookup = calls.find((c) => c.op === 'select' && c.tableName === 'ws_connections')!;
    expect(render(connLookup.where).params).toEqual(['conn-7']);
    const update = calls.find((c) => c.op === 'update')!;
    expect(update.tableName).toBe('ws_connections');
    expect(update.values).toEqual({ jobId: JOB });
    expect(render(update.where).params).toEqual(['conn-7']);
    expect(fetchMock).not.toHaveBeenCalled(); // owners need no membership lookup
  });

  it('lets a teammate who shares a team with the submitter subscribe', async () => {
    const calls = setupDb({ connectionUserId: VIEWER });

    await expect(handler(subscribeEvent({ action: 'subscribe', jobId: JOB }))).resolves.toMatchObject({ statusCode: 200 });

    expect(calls.find((c) => c.op === 'update')?.values).toEqual({ jobId: JOB });
    const tokenCall = fetchMock.mock.calls.find(([url]) => url === 'http://auth.test/auth/token')!;
    expect(JSON.parse(String(tokenCall[1]?.body))).toEqual({
      clientId: 'ws-worker',
      clientSecret: 'ws-secret',
      scope: 'memberships:read',
    });
    const teamCalls = fetchMock.mock.calls.filter(([url]) => url.startsWith('http://platform.test/'));
    expect(teamCalls.map(([url]) => url).sort()).toEqual(
      [`http://platform.test/internal/users/${OWNER}/teams`, `http://platform.test/internal/users/${VIEWER}/teams`].sort(),
    );
    for (const [, init] of teamCalls) {
      expect(init?.headers).toEqual({ Authorization: `Bearer ${SERVICE_TOKEN}` });
    }
  });

  it('returns 404 (not 403) to users who share no team with the submitter', async () => {
    teams[VIEWER] = ['team-z'];
    const calls = setupDb({ connectionUserId: VIEWER });
    await expect(handler(subscribeEvent({ action: 'subscribe', jobId: JOB }))).resolves.toEqual({
      statusCode: 404,
      body: 'Job not found',
    });
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0);
  });

  it('treats a failed membership lookup as no access', async () => {
    teams[VIEWER] = 'error';
    setupDb({ connectionUserId: VIEWER });
    await expect(handler(subscribeEvent({ action: 'subscribe', jobId: JOB }))).resolves.toMatchObject({ statusCode: 404 });
  });

  it('caches the service token across subscriptions', async () => {
    setupDb({ connectionUserId: VIEWER });
    await handler(subscribeEvent({ action: 'subscribe', jobId: JOB }));
    await handler(subscribeEvent({ action: 'subscribe', jobId: JOB }));
    const tokenCalls = fetchMock.mock.calls.filter(([url]) => url === 'http://auth.test/auth/token');
    expect(tokenCalls.length).toBeLessThanOrEqual(1);
  });
});

describe('ws routing', () => {
  it('rejects unknown routes', async () => {
    await expect(handler({ requestContext: { routeKey: '$default', connectionId: 'c' } })).resolves.toEqual({
      statusCode: 400,
      body: 'unknown route',
    });
  });
});
