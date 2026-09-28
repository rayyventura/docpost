import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Harness } from '../test/harness.js';
import { startHarness, uid } from '../test/harness.js';

describe.skipIf(!process.env.INTEGRATION)('platform browse routes (integration)', () => {
  let h: Harness;
  const member = uid();
  const outsider = uid();
  let teamId: string;
  let disabledTeamId: string;
  let otherTeamId: string;
  let binderId: string;
  let otherBinderId: string;
  let rootFolderId: string;
  let childFolderId: string;
  let grandchildFolderId: string;
  let rootDocId: string;
  let folderDocId: string;
  let childDocId: string;

  beforeAll(async () => {
    h = await startHarness();
    const f = h.fixtures;
    // Named so name order (disabled first) is the reverse of insertion order.
    teamId = await f.team({ name: `Zeta browse ${uid()}` });
    disabledTeamId = await f.team({ name: `Alpha browse ${uid()}`, docpostEnabled: false });
    otherTeamId = await f.team();
    await f.member(teamId, member);
    await f.member(disabledTeamId, member);
    await f.member(otherTeamId, outsider);

    binderId = await f.binder(teamId, 'Clinical');
    otherBinderId = await f.binder(otherTeamId, 'Other team binder');

    rootFolderId = await f.folder(binderId, null, 'Root folder');
    childFolderId = await f.folder(binderId, rootFolderId, 'Child folder');
    grandchildFolderId = await f.folder(binderId, childFolderId, 'Grandchild folder');

    rootDocId = await f.document({ binderId, name: 'root.pdf', sizeBytes: 5_000_000_000 });
    folderDocId = await f.document({ binderId, folderId: rootFolderId, name: 'in-root-folder.pdf' });
    childDocId = await f.document({ binderId, folderId: childFolderId, name: 'in-child.pdf' });
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('authentication', () => {
    it('rejects requests without a bearer token', async () => {
      const res = await h.request('/teams');
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('UNAUTHORIZED');
    });

    it('rejects tokens signed by a key outside the JWKS', async () => {
      const res = await h.request('/teams', { token: await h.foreignToken(member) });
      expect(res.status).toBe(401);
    });

    it('rejects service tokens on user routes', async () => {
      const res = await h.request('/teams', { token: await h.serviceToken('memberships:read') });
      expect(res.status).toBe(403);
    });

    it('serves /health without auth', async () => {
      const res = await h.request('/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  describe('GET /teams', () => {
    it('lists only teams the token subject belongs to, ordered by name', async () => {
      const res = await h.request('/teams', { token: await h.userToken(member) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string; name: string; region: string }>;
      expect(body.map((t) => t.id)).toEqual([disabledTeamId, teamId]);
      expect(body.map((t) => t.id)).not.toContain(otherTeamId);
      expect(Object.keys(body[0]).sort()).toEqual(['id', 'name', 'region']);
    });

    it('filters by docPostEnabled', async () => {
      const token = await h.userToken(member);
      const enabled = await (await h.request('/teams?docPostEnabled=true', { token })).json();
      expect(enabled.map((t: { id: string }) => t.id)).toEqual([teamId]);
      const disabled = await (await h.request('/teams?docPostEnabled=false', { token })).json();
      expect(disabled.map((t: { id: string }) => t.id)).toEqual([disabledTeamId]);
    });

    it('returns an empty list for a user with no memberships', async () => {
      const res = await h.request('/teams', { token: await h.userToken(uid()) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('returns an empty list (not a 500) for a token whose subject is not a uuid', async () => {
      const res = await h.request('/teams', { token: await h.userToken('not-a-uuid') });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });

  describe('GET /teams/:teamId/binders', () => {
    it('lists binders for a member', async () => {
      const res = await h.request(`/teams/${teamId}/binders`, { token: await h.userToken(member) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ id: binderId, name: 'Clinical' }]);
    });

    it('returns 403 for a non-member', async () => {
      const res = await h.request(`/teams/${teamId}/binders`, { token: await h.userToken(outsider) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    });

    it('returns 403 for a team that does not exist', async () => {
      const res = await h.request(`/teams/${uid()}/binders`, { token: await h.userToken(member) });
      expect(res.status).toBe(403);
    });

    it('returns the same 403 as an unknown team for a malformed team id', async () => {
      const res = await h.request('/teams/not-a-uuid/binders', { token: await h.userToken(member) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    });

    it('orders binders by name, then id', async () => {
      // The member's disabled team has no other binders; creating a team here would
      // race with the membership fan-out test in another file.
      const team = disabledTeamId;
      const charlie = await h.fixtures.binder(team, 'Charlie');
      const bravo1 = await h.fixtures.binder(team, 'Bravo');
      const alpha = await h.fixtures.binder(team, 'Alpha');
      const bravo2 = await h.fixtures.binder(team, 'Bravo');
      const [bravoLow, bravoHigh] = [bravo1, bravo2].sort();

      const res = await h.request(`/teams/${team}/binders`, { token: await h.userToken(member) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        { id: alpha, name: 'Alpha' },
        { id: bravoLow, name: 'Bravo' },
        { id: bravoHigh, name: 'Bravo' },
        { id: charlie, name: 'Charlie' },
      ]);
    });
  });

  describe('GET /binders/:binderId/contents', () => {
    it('returns exactly one level: root folders and root documents', async () => {
      const res = await h.request(`/binders/${binderId}/contents`, { token: await h.userToken(member) });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.folders).toEqual([{ id: rootFolderId, name: 'Root folder' }]);
      expect(body.documents).toHaveLength(1);
      expect(body.documents[0]).toMatchObject({
        id: rootDocId,
        name: 'root.pdf',
        // bigint sizes are serialised as strings so > 2^32 values survive JSON
        sizeBytes: '5000000000',
        contentType: 'application/pdf',
      });
      expect(new Date(body.documents[0].createdAt).toISOString()).toBe(body.documents[0].createdAt);
      const ids = [...body.folders, ...body.documents].map((x: { id: string }) => x.id);
      expect(ids).not.toContain(childFolderId);
      expect(ids).not.toContain(folderDocId);
    });

    it('returns 403 for a non-member', async () => {
      const res = await h.request(`/binders/${binderId}/contents`, { token: await h.userToken(outsider) });
      expect(res.status).toBe(403);
    });

    it('returns 403 (not 404) for a binder that does not exist, so existence is not leaked', async () => {
      const res = await h.request(`/binders/${uid()}/contents`, { token: await h.userToken(member) });
      expect(res.status).toBe(403);
    });

    it('does not let a member of one team read another team binder', async () => {
      const res = await h.request(`/binders/${otherBinderId}/contents`, { token: await h.userToken(member) });
      expect(res.status).toBe(403);
    });

    it('returns the same 403 as an unknown binder for a malformed binder id', async () => {
      const res = await h.request('/binders/not-a-uuid/contents', { token: await h.userToken(member) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    });

    it('returns 403 (not a 500) for a token whose subject is not a uuid', async () => {
      const res = await h.request(`/binders/${binderId}/contents`, { token: await h.userToken('not-a-uuid') });
      expect(res.status).toBe(403);
    });

    it('orders root folders and root documents by name, then id', async () => {
      const b = await h.fixtures.binder(teamId);
      const fCharlie = await h.fixtures.folder(b, null, 'Charlie');
      const fAlpha = await h.fixtures.folder(b, null, 'Alpha');
      const fBravo = await h.fixtures.folder(b, null, 'Bravo');
      const dC = await h.fixtures.document({ binderId: b, name: 'c.pdf' });
      const dB1 = await h.fixtures.document({ binderId: b, name: 'b.pdf' });
      const dA = await h.fixtures.document({ binderId: b, name: 'a.pdf' });
      const dB2 = await h.fixtures.document({ binderId: b, name: 'b.pdf' });

      const body = await (await h.request(`/binders/${b}/contents`, { token: await h.userToken(member) })).json();
      expect(body.folders.map((x: { id: string }) => x.id)).toEqual([fAlpha, fBravo, fCharlie]);
      expect(body.documents.map((x: { id: string }) => x.id)).toEqual([dA, ...[dB1, dB2].sort(), dC]);
    });
  });

  describe('GET /folders/:folderId/contents', () => {
    it('returns one level inside a folder', async () => {
      const token = await h.userToken(member);
      const root = await (await h.request(`/folders/${rootFolderId}/contents`, { token })).json();
      expect(root.folders).toEqual([{ id: childFolderId, name: 'Child folder' }]);
      expect(root.documents.map((d: { id: string }) => d.id)).toEqual([folderDocId]);

      const child = await (await h.request(`/folders/${childFolderId}/contents`, { token })).json();
      expect(child.folders).toEqual([{ id: grandchildFolderId, name: 'Grandchild folder' }]);
      expect(child.documents.map((d: { id: string }) => d.id)).toEqual([childDocId]);

      const leaf = await (await h.request(`/folders/${grandchildFolderId}/contents`, { token })).json();
      expect(leaf).toEqual({ folders: [], documents: [] });
    });

    it('returns 403 for a non-member', async () => {
      const res = await h.request(`/folders/${childFolderId}/contents`, { token: await h.userToken(outsider) });
      expect(res.status).toBe(403);
    });

    it('returns 403 for a folder that does not exist', async () => {
      const res = await h.request(`/folders/${uid()}/contents`, { token: await h.userToken(member) });
      expect(res.status).toBe(403);
    });

    it('returns the same 403 as an unknown folder for a malformed folder id', async () => {
      const res = await h.request('/folders/not-a-uuid/contents', { token: await h.userToken(member) });
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('FORBIDDEN');
    });

    it('orders child folders and documents by name, then id', async () => {
      // A separate binder keeps the shared fixture tree above unchanged.
      const b = await h.fixtures.binder(teamId);
      const parent = await h.fixtures.folder(b, null, 'Ordering parent');
      const fBravo = await h.fixtures.folder(b, parent, 'Bravo');
      const fAlpha1 = await h.fixtures.folder(b, parent, 'Alpha');
      const fAlpha2 = await h.fixtures.folder(b, parent, 'Alpha');
      const dZ = await h.fixtures.document({ binderId: b, folderId: parent, name: 'z.pdf' });
      const dM = await h.fixtures.document({ binderId: b, folderId: parent, name: 'm.pdf' });

      const body = await (await h.request(`/folders/${parent}/contents`, { token: await h.userToken(member) })).json();
      expect(body.folders.map((x: { id: string }) => x.id)).toEqual([...[fAlpha1, fAlpha2].sort(), fBravo]);
      expect(body.documents.map((x: { id: string }) => x.id)).toEqual([dM, dZ]);
    });
  });

  describe('listing size and pagination', () => {
    // The platform API has no server-side pagination (blueprint: "One level:
    // {folders, documents}"). A level is returned whole, and paging query params are
    // ignored; paging happens in the DocPost API / SPA.
    it('returns the whole level in one response and ignores page/limit params', async () => {
      const bigBinder = await h.fixtures.binder(teamId);
      const folderCount = 120;
      const docCount = 105;
      const pad = (i: number) => String(i).padStart(3, '0');
      // Inserted in reverse so the response order has to come from ORDER BY.
      for (let i = folderCount - 1; i >= 0; i--) {
        await h.fixtures.folder(bigBinder, null, `bulk-folder-${pad(i)}`);
      }
      for (let i = docCount - 1; i >= 0; i--) {
        await h.fixtures.document({ binderId: bigBinder, name: `bulk-${pad(i)}.pdf` });
      }

      const token = await h.userToken(member);
      const full = await (await h.request(`/binders/${bigBinder}/contents`, { token })).json();
      expect(full.folders).toHaveLength(folderCount);
      expect(full.documents).toHaveLength(docCount);
      expect(new Set(full.folders.map((f: { id: string }) => f.id)).size).toBe(folderCount);
      expect(full.folders.map((f: { name: string }) => f.name)).toEqual(
        Array.from({ length: folderCount }, (_, i) => `bulk-folder-${pad(i)}`),
      );
      expect(full.documents.map((d: { name: string }) => d.name)).toEqual(
        Array.from({ length: docCount }, (_, i) => `bulk-${pad(i)}.pdf`),
      );

      const paged = await (
        await h.request(`/binders/${bigBinder}/contents?page=2&limit=10&pageSize=10`, { token })
      ).json();
      expect(paged.folders).toHaveLength(folderCount);
      expect(paged.documents).toHaveLength(docCount);
      expect(paged).toEqual(full);
    });
  });
});
