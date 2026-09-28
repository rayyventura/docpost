import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from '../test-utils/integration.js';

describe.skipIf(!process.env.INTEGRATION)('destinations proxy (integration)', () => {
  let h: Harness;
  let userId: string;
  let token: string;
  let enabledTeam: string;

  beforeAll(async () => {
    h = await startHarness();
    userId = crypto.randomUUID();
    token = await h.signUserToken(userId);
    enabledTeam = h.addTeam([userId], { name: 'Enabled' }).id;
    h.addTeam([userId], { name: 'Disabled', docPostEnabled: false });
  });

  afterEach(() => {
    h.setOverride(undefined);
  });

  afterAll(async () => {
    await h?.close();
  });

  const lastPlatformRequest = (pathPrefix: string) =>
    [...h.requests].reverse().find((r) => r.path.startsWith(pathPrefix));

  it('requires authentication and never calls the platform without it', async () => {
    const before = h.requests.length;
    const res = await h.api('GET', '/destinations/teams');
    expect(res.status).toBe(401);
    expect(h.requests.slice(before).some((r) => r.path.startsWith('/teams'))).toBe(false);
  });

  it('lists only DocPost-enabled teams, forwarding the user JWT unchanged', async () => {
    const res = await h.api('GET', '/destinations/teams', { token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: enabledTeam, name: 'Enabled', region: 'us-east-1' }]);
    const forwarded = lastPlatformRequest('/teams?docPostEnabled=true');
    expect(forwarded?.authorization).toBe(`Bearer ${token}`);
  });

  it.each([
    ['/destinations/teams/t-1/binders', '/teams/t-1/binders'],
    ['/destinations/binders/b-1/contents', '/binders/b-1/contents'],
    ['/destinations/folders/f-1/contents', '/folders/f-1/contents'],
    ['/destinations/documents/d-1/download', '/documents/d-1/download'],
  ])('%s proxies to %s with the user JWT', async (path, platformPath) => {
    const res = await h.api('GET', path, { token });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ proxied: platformPath, sub: userId });
    expect(lastPlatformRequest(platformPath)?.authorization).toBe(`Bearer ${token}`);
  });

  it('passes a platform 403 through', async () => {
    h.setOverride((req, res) => {
      if (!req.url?.startsWith('/teams/')) return false;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Not a member' } }));
      return true;
    });
    const res = await h.api('GET', '/destinations/teams/t-2/binders', { token });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each([500, 503])('maps a platform %i to 502', async (status) => {
    h.setOverride((req, res) => {
      if (!req.url?.startsWith('/binders/')) return false;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }));
      return true;
    });
    const res = await h.api('GET', '/destinations/binders/b-1/contents', { token });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { code: 'UPSTREAM_ERROR', message: 'Platform service unavailable' } });
  });

  it('maps a dropped platform connection to 502', async () => {
    h.setOverride((req) => {
      if (!req.url?.startsWith('/folders/')) return false;
      req.socket.destroy();
      return true;
    });
    const res = await h.api('GET', '/destinations/folders/f-1/contents', { token });
    expect(res.status).toBe(502);
  });

  it('gives up on a hung platform after 5 seconds with 502', { timeout: 15_000 }, async () => {
    h.setOverride((req) => req.url?.startsWith('/teams?') ?? false); // never respond
    const started = Date.now();
    const res = await h.api('GET', '/destinations/teams', { token });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    expect(elapsed).toBeGreaterThanOrEqual(4_900);
    expect(elapsed).toBeLessThan(8_000);
  });
});
