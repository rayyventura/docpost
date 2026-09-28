import { FOLDER_DESTINATION_REQUIRED, ValidationError } from '@docpost/shared';

const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:3002';
const AUTH_TOKEN_URL = process.env.AUTH_TOKEN_URL ?? 'http://localhost:3001/auth/token';
const SERVICE_CLIENT_ID = process.env.SERVICE_CLIENT_ID ?? 'delivery-worker';
const SERVICE_CLIENT_SECRET = process.env.SERVICE_CLIENT_SECRET ?? 'delivery-worker-local-secret';
const CACHE_MS = 60_000;

let cachedServiceToken: string | null = null;
let cachedServiceTokenExp = 0;

const submitterCache = new Map<string, { userIds: Set<string>; expiresAt: number }>();

async function getServiceToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedServiceToken && cachedServiceTokenExp > now + 30) {
    return cachedServiceToken;
  }

  const res = await fetch(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: SERVICE_CLIENT_ID,
      clientSecret: SERVICE_CLIENT_SECRET,
      scope: 'memberships:read',
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to get service token: ${res.status}`);
  }

  const { accessToken } = (await res.json()) as { accessToken: string };
  const parts = accessToken.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { exp?: number };
  cachedServiceToken = accessToken;
  cachedServiceTokenExp = payload.exp ?? 0;
  return accessToken;
}

export async function teamBinderIds(teamId: string, userToken: string): Promise<string[]> {
  const res = await fetch(`${PLATFORM_URL}/teams/${teamId}/binders`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as { id: string }[];
  return rows.map((row) => row.id);
}

export async function visibleTeams(userToken: string): Promise<Map<string, string>> {
  const teamsRes = await fetch(`${PLATFORM_URL}/teams?docPostEnabled=true`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!teamsRes.ok) {
    throw new Error(`Failed to load teams: ${teamsRes.status}`);
  }

  const teams = (await teamsRes.json()) as { id: string; name: string }[];
  return new Map(teams.map((team) => [team.id, team.name]));
}

export interface DestinationPathDetail {
  path: string;
  teamName: string;
  binderName: string;
  folderPath: Array<{ id: string; name: string }>;
}

export async function destinationPaths(
  items: Array<{ teamId: string; binderId: string; folderId: string | null }>,
): Promise<Map<string, DestinationPathDetail>> {
  const paths = new Map<string, DestinationPathDetail>();
  if (items.length === 0) return paths;

  const keyFor = (item: { teamId: string; binderId: string; folderId: string | null }) =>
    `${item.teamId}:${item.binderId}:${item.folderId ?? ''}`;

  try {
    const serviceToken = await getServiceToken();
    const res = await fetch(`${PLATFORM_URL}/internal/destination-paths`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ destinations: items }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`destination-paths failed: ${res.status} ${body}`);
      return paths;
    }

    const body = (await res.json()) as {
      destinations: Array<{
        teamId: string;
        binderId: string;
        folderId: string | null;
        path: string;
        teamName?: string;
        binderName?: string;
        folderPath?: Array<{ id: string; name: string }>;
      }>;
    };
    for (const destination of body.destinations ?? []) {
      paths.set(keyFor(destination), {
        path: destination.path,
        teamName: destination.teamName ?? '',
        binderName: destination.binderName ?? '',
        folderPath: destination.folderPath ?? [],
      });
    }
  } catch (err) {
    console.error('destination-paths failed', err);
    return paths;
  }

  return paths;
}

export async function assertFolderDestinations(
  items: Array<{ teamId: string; binderId: string; folderId: string }>,
): Promise<void> {
  const unique: Array<{ teamId: string; binderId: string; folderId: string }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = `${item.teamId}:${item.binderId}:${item.folderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  if (unique.length === 0) {
    throw new ValidationError('Choose at least one destination');
  }

  const serviceToken = await getServiceToken();
  const res = await fetch(`${PLATFORM_URL}/internal/assert-folder-destinations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ destinations: unique }),
  });

  if (res.status === 422) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ValidationError(body?.error?.message ?? FOLDER_DESTINATION_REQUIRED);
  }
  if (!res.ok) {
    throw new Error(`Failed to validate destinations: ${res.status}`);
  }
}

export async function teamName(teamId: string): Promise<string> {
  const serviceToken = await getServiceToken();
  const res = await fetch(`${PLATFORM_URL}/internal/teams/${teamId}`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  if (!res.ok) {
    return teamId;
  }
  const body = (await res.json()) as { name?: string };
  return body.name || teamId;
}

export async function visibleSubmitterIds(userId: string, userToken: string): Promise<Set<string>> {
  const cached = submitterCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.userIds;
  }

  const teamsRes = await fetch(`${PLATFORM_URL}/teams`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  if (!teamsRes.ok) {
    throw new Error(`Failed to load teams: ${teamsRes.status}`);
  }

  const teams = (await teamsRes.json()) as { id: string }[];
  const serviceToken = await getServiceToken();
  const userIds = new Set<string>([userId]);

  await Promise.all(
    teams.map(async (team) => {
      const res = await fetch(`${PLATFORM_URL}/teams/${team.id}/members`, {
        headers: { Authorization: `Bearer ${serviceToken}` },
      });
      if (!res.ok) {
        return;
      }
      const body = (await res.json()) as { userIds: string[] };
      for (const id of body.userIds) {
        userIds.add(id);
      }
    }),
  );

  submitterCache.set(userId, { userIds, expiresAt: Date.now() + CACHE_MS });
  return userIds;
}
