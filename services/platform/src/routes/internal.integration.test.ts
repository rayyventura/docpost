import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { teamMembers } from '../db/schema.js';
import type { Harness } from '../test/harness.js';
import { startHarness, uid } from '../test/harness.js';

describe.skipIf(!process.env.INTEGRATION)('platform service-token routes (integration)', () => {
  let h: Harness;
  let readToken: string;
  const member = uid();
  let teamId: string;
  let binderId: string;
  let rootFolderId: string;
  let childFolderId: string;

  beforeAll(async () => {
    h = await startHarness();
    readToken = await h.serviceToken('memberships:read');
    teamId = await h.fixtures.team({ name: 'Oncology', region: 'eu-west-1' });
    await h.fixtures.member(teamId, member);
    binderId = await h.fixtures.binder(teamId, 'Trials');
    rootFolderId = await h.fixtures.folder(binderId, null, 'Site A');
    childFolderId = await h.fixtures.folder(binderId, rootFolderId, 'Consent');
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('GET /teams/:teamId/members/:userId', () => {
    it('returns 200 {addedAt, region} for a member', async () => {
      const res = await h.request(`/teams/${teamId}/members/${member}`, { token: readToken });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.region).toBe('eu-west-1');
      expect(Number.isNaN(Date.parse(json.addedAt))).toBe(false);
    });

    it('returns 404 for a non-member', async () => {
      const res = await h.request(`/teams/${teamId}/members/${uid()}`, { token: readToken });
      expect(res.status).toBe(404);
    });

    it('requires memberships:read on a service token', async () => {
      const wrongScope = await h.request(`/teams/${teamId}/members/${member}`, {
        token: await h.serviceToken('documents:ingest'),
      });
      expect(wrongScope.status).toBe(403);
      const user = await h.request(`/teams/${teamId}/members/${member}`, { token: await h.userToken(member) });
      expect(user.status).toBe(403);
    });
  });

  describe('team lookups', () => {
    it('GET /teams/:teamId/members lists user ids', async () => {
      const res = await h.request(`/teams/${teamId}/members`, { token: readToken });
      expect(await res.json()).toEqual({ userIds: [member] });
    });

    it('GET /internal/teams/:teamId returns the team or 404', async () => {
      const found = await h.request(`/internal/teams/${teamId}`, { token: readToken });
      expect(await found.json()).toEqual({ id: teamId, name: 'Oncology' });
      const missing = await h.request(`/internal/teams/${uid()}`, { token: readToken });
      expect(missing.status).toBe(404);
      const invalid = await h.request('/internal/teams/nope', { token: readToken });
      expect(invalid.status).toBe(422);
    });

    it('GET /internal/users/:userId/teams lists team ids', async () => {
      const res = await h.request(`/internal/users/${member}/teams`, { token: readToken });
      expect(await res.json()).toEqual({ teamIds: [teamId] });
    });
  });

  describe('POST /internal/users/:userId/memberships', () => {
    it('adds the user to every team, idempotently, and requires memberships:write', async () => {
      const newUser = uid();
      h.fixtures.trackMemberUser(newUser);

      const denied = await h.request(`/internal/users/${newUser}/memberships`, { method: 'POST', token: readToken });
      expect(denied.status).toBe(403);

      const writeToken = await h.serviceToken('memberships:write');
      const first = await h.request(`/internal/users/${newUser}/memberships`, { method: 'POST', token: writeToken });
      expect(first.status).toBe(200);
      const { assigned } = await first.json();
      expect(assigned).toBeGreaterThanOrEqual(1);

      const rows = await getDb().select().from(teamMembers).where(eq(teamMembers.userId, newUser));
      expect(rows.map((r) => r.teamId)).toContain(teamId);

      const again = await h.request(`/internal/users/${newUser}/memberships`, { method: 'POST', token: writeToken });
      expect(again.status).toBe(200);
      const rowsAgain = await getDb().select().from(teamMembers).where(eq(teamMembers.userId, newUser));
      expect(rowsAgain).toHaveLength(rows.length);
    });
  });

  describe('POST /internal/destination-paths', () => {
    it('resolves team / binder / folder path labels', async () => {
      const res = await h.request('/internal/destination-paths', {
        method: 'POST',
        token: readToken,
        json: { destinations: [{ teamId, binderId, folderId: childFolderId }] },
      });
      expect(res.status).toBe(200);
      const { destinations } = await res.json();
      expect(destinations[0]).toMatchObject({
        path: 'Oncology / Trials / Site A / Consent',
        teamName: 'Oncology',
        binderName: 'Trials',
        folderPath: [
          { id: rootFolderId, name: 'Site A' },
          { id: childFolderId, name: 'Consent' },
        ],
      });
    });
  });

  describe('POST /internal/assert-folder-destinations', () => {
    it('returns 204 for valid destinations and 422 otherwise', async () => {
      const ok = await h.request('/internal/assert-folder-destinations', {
        method: 'POST',
        token: readToken,
        json: { destinations: [{ teamId, binderId, folderId: childFolderId }] },
      });
      expect(ok.status).toBe(204);

      const noFolder = await h.request('/internal/assert-folder-destinations', {
        method: 'POST',
        token: readToken,
        json: { destinations: [{ teamId, binderId }] },
      });
      expect(noFolder.status).toBe(422);

      const wrongTeam = await h.request('/internal/assert-folder-destinations', {
        method: 'POST',
        token: readToken,
        json: { destinations: [{ teamId: uid(), binderId, folderId: childFolderId }] },
      });
      expect(wrongTeam.status).toBe(422);
    });
  });
});
