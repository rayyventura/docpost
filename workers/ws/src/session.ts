import { createRemoteJWKSet, jwtVerify } from 'jose';
import { eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { jobs, wsConnections } from './schema.js';

const AUTH_JWKS_URL = process.env.AUTH_JWKS_URL ?? 'http://localhost:3001/.well-known/jwks.json';
const AUTH_TOKEN_URL = process.env.AUTH_TOKEN_URL ?? 'http://localhost:3001/auth/token';
const PLATFORM_URL = process.env.PLATFORM_URL ?? 'http://localhost:3002';
const SERVICE_CLIENT_ID = process.env.SERVICE_CLIENT_ID ?? 'delivery-worker';
const SERVICE_CLIENT_SECRET = process.env.SERVICE_CLIENT_SECRET ?? 'delivery-worker-local-secret';

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let cachedServiceToken: string | null = null;
let cachedServiceTokenExp = 0;

function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(AUTH_JWKS_URL));
  return jwks;
}

async function userIdFromToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: 'docpost-auth',
      algorithms: ['RS256'],
    });
    if (!payload.sub || payload.token_use === 'service') return null;
    return payload.sub;
  } catch {
    return null;
  }
}

async function serviceToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedServiceToken && cachedServiceTokenExp > now + 30) return cachedServiceToken;

  const res = await fetch(AUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: SERVICE_CLIENT_ID,
      clientSecret: SERVICE_CLIENT_SECRET,
      scope: 'memberships:read',
    }),
  });
  if (!res.ok) throw new Error(`Failed to get service token: ${res.status}`);
  const { accessToken } = (await res.json()) as { accessToken: string };
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as { exp?: number };
  cachedServiceToken = accessToken;
  cachedServiceTokenExp = payload.exp ?? 0;
  return accessToken;
}

async function teamIds(userId: string): Promise<Set<string>> {
  const token = await serviceToken();
  const res = await fetch(`${PLATFORM_URL}/internal/users/${userId}/teams`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return new Set();
  const body = (await res.json()) as { teamIds: string[] };
  return new Set(body.teamIds);
}

async function canViewJob(userId: string, jobId: string): Promise<boolean> {
  const db = getDb();
  const [job] = await db
    .select({ submittedByUserId: jobs.submittedByUserId })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  if (!job) return false;
  if (job.submittedByUserId === userId) return true;

  const [viewerTeams, ownerTeams] = await Promise.all([
    teamIds(userId),
    teamIds(job.submittedByUserId),
  ]);
  for (const teamId of viewerTeams) {
    if (ownerTeams.has(teamId)) return true;
  }
  return false;
}

export async function connect(connectionId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const userId = await userIdFromToken(token);
  if (!userId) return false;

  const db = getDb();
  await db.insert(wsConnections).values({ connectionId, userId }).onConflictDoUpdate({
    target: wsConnections.connectionId,
    set: { userId, jobId: null, connectedAt: new Date() },
  });
  return true;
}

export async function subscribe(connectionId: string, jobId: string): Promise<'ok' | 'missing' | 'forbidden'> {
  const db = getDb();
  const [connection] = await db
    .select({ userId: wsConnections.userId })
    .from(wsConnections)
    .where(eq(wsConnections.connectionId, connectionId))
    .limit(1);
  if (!connection) return 'missing';
  if (!(await canViewJob(connection.userId, jobId))) return 'forbidden';

  await db.update(wsConnections).set({ jobId }).where(eq(wsConnections.connectionId, connectionId));
  return 'ok';
}

export async function disconnect(connectionId: string): Promise<void> {
  const db = getDb();
  await db.delete(wsConnections).where(eq(wsConnections.connectionId, connectionId));
}
