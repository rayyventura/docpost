import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_DESTINATION_REQUIRED } from '@docpost/shared';

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:3002';
const AUTH_TOKEN_URL = process.env.AUTH_TOKEN_URL ?? 'http://localhost:3001/auth/token';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeJwt(exp: number): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ sub: 'delivery-worker', exp })}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let routes: Record<string, Handler>;
let access: typeof import('./access.js');

function authHeader(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.Authorization;
}

beforeEach(async () => {
  const serviceToken = fakeJwt(Math.floor(Date.now() / 1000) + 900);
  routes = {
    [`POST ${AUTH_TOKEN_URL}`]: () => json({ accessToken: serviceToken }),
  };
  fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  // Fresh module per test so the service-token and submitter caches start empty.
  vi.resetModules();
  access = await import('./access.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const dest = (folderId: string) => ({
  teamId: '11111111-1111-4111-8111-111111111111',
  binderId: '22222222-2222-4222-8222-222222222222',
  folderId,
});

describe('assertFolderDestinations', () => {
  it('sends de-duplicated destinations with a service token', async () => {
    let sent: unknown;
    let auth: string | undefined;
    routes[`POST ${PLATFORM_URL}/internal/assert-folder-destinations`] = (_url, init) => {
      sent = JSON.parse(String(init?.body));
      auth = authHeader(init);
      return json({ ok: true });
    };

    await access.assertFolderDestinations([dest('a'), dest('a'), dest('b')]);

    expect(sent).toEqual({ destinations: [dest('a'), dest('b')] });
    expect(auth).toMatch(/^Bearer .+\..+\..+$/);
  });

  it('rejects an empty destination list without calling the platform', async () => {
    await expect(access.assertFolderDestinations([])).rejects.toThrow('Choose at least one destination');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a platform 422 to a ValidationError with the platform message', async () => {
    routes[`POST ${PLATFORM_URL}/internal/assert-folder-destinations`] = () =>
      json({ error: { message: 'Folder not in binder' } }, 422);

    const err = await access.assertFolderDestinations([dest('a')]).catch((e: unknown) => e);
    // resetModules reloads @docpost/shared too, so match on the error shape, not the class.
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422, message: 'Folder not in binder' });
  });

  it('falls back to the folder-required message when the 422 has no body', async () => {
    routes[`POST ${PLATFORM_URL}/internal/assert-folder-destinations`] = () =>
      new Response('nope', { status: 422 });

    await expect(access.assertFolderDestinations([dest('a')])).rejects.toThrow(FOLDER_DESTINATION_REQUIRED);
  });

  it('surfaces other platform failures as plain errors (500 at the edge)', async () => {
    routes[`POST ${PLATFORM_URL}/internal/assert-folder-destinations`] = () => json({}, 503);

    const err = await access.assertFolderDestinations([dest('a')]).catch((e: unknown) => e);
    expect(err).not.toHaveProperty('statusCode');
    expect((err as Error).message).toContain('503');
  });

  it('reuses the cached service token across calls', async () => {
    routes[`POST ${PLATFORM_URL}/internal/assert-folder-destinations`] = () => json({});
    await access.assertFolderDestinations([dest('a')]);
    await access.assertFolderDestinations([dest('b')]);

    const tokenCalls = fetchMock.mock.calls.filter(([url]) => String(url) === AUTH_TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });
});

describe('visibleTeams', () => {
  it('asks the platform for DocPost-enabled teams with the user token', async () => {
    let auth: string | undefined;
    routes[`GET ${PLATFORM_URL}/teams?docPostEnabled=true`] = (_url, init) => {
      auth = authHeader(init);
      return json([{ id: 't1', name: 'Team One' }]);
    };

    const teams = await access.visibleTeams('user-jwt');

    expect(auth).toBe('Bearer user-jwt');
    expect([...teams.entries()]).toEqual([['t1', 'Team One']]);
  });

  it('throws when the platform fails', async () => {
    routes[`GET ${PLATFORM_URL}/teams?docPostEnabled=true`] = () => json({}, 500);
    await expect(access.visibleTeams('user-jwt')).rejects.toThrow('Failed to load teams: 500');
  });
});

describe('visibleSubmitterIds', () => {
  it('includes the user and every member of every team they belong to', async () => {
    routes[`GET ${PLATFORM_URL}/teams`] = () => json([{ id: 't1' }, { id: 't2' }]);
    routes[`GET ${PLATFORM_URL}/teams/t1/members`] = () => json({ userIds: ['u2', 'u3'] });
    routes[`GET ${PLATFORM_URL}/teams/t2/members`] = () => json({}, 403);

    const ids = await access.visibleSubmitterIds('u1', 'user-jwt');

    expect([...ids].sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('caches the result per user', async () => {
    routes[`GET ${PLATFORM_URL}/teams`] = () => json([]);

    await access.visibleSubmitterIds('u1', 'user-jwt');
    await access.visibleSubmitterIds('u1', 'user-jwt');

    const teamCalls = fetchMock.mock.calls.filter(([url]) => String(url) === `${PLATFORM_URL}/teams`);
    expect(teamCalls).toHaveLength(1);
  });
});

describe('destinationPaths', () => {
  const item = { teamId: 't', binderId: 'b', folderId: 'f' };

  it('returns an empty map (and makes no call) for no items', async () => {
    expect((await access.destinationPaths([])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keys platform results by team:binder:folder and defaults missing labels', async () => {
    routes[`POST ${PLATFORM_URL}/internal/destination-paths`] = () =>
      json({ destinations: [{ ...item, path: 'T / B / F' }] });

    const paths = await access.destinationPaths([item]);

    expect(paths.get('t:b:f')).toEqual({ path: 'T / B / F', teamName: '', binderName: '', folderPath: [] });
  });

  it('swallows platform failures and returns an empty map', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    routes[`POST ${PLATFORM_URL}/internal/destination-paths`] = () => json({}, 500);

    expect((await access.destinationPaths([item])).size).toBe(0);
  });
});

describe('teamName', () => {
  it('returns the platform name, or the id when the lookup fails', async () => {
    routes[`GET ${PLATFORM_URL}/internal/teams/t1`] = () => json({ name: 'Cardiology' });
    routes[`GET ${PLATFORM_URL}/internal/teams/t2`] = () => json({}, 404);

    expect(await access.teamName('t1')).toBe('Cardiology');
    expect(await access.teamName('t2')).toBe('t2');
  });
});
