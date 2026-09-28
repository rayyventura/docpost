/**
 * Shared setup for `*.integration.test.ts`: real local Postgres (docker compose), the real
 * Express app in-process on an ephemeral port, and an in-process stand-in for the platform
 * membership endpoint that registration calls. Only rows created through this harness are
 * deleted on teardown.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { inArray } from 'drizzle-orm';
import { createApp } from '../app.js';
import { initKeys } from '../crypto/keys.js';
import { closeDb, getDb } from '../db/index.js';
import { serviceClients, users } from '../db/schema.js';
import { listen, postJson, type RunningServer } from './http.js';

export const DEFAULT_DATABASE_URL = 'postgresql://auth_service:auth_local@localhost:5432/docpost_auth';

export interface IntegrationHarness {
  baseUrl: string;
  platformCalls: string[];
  /** Status the fake platform returns for membership assignment (default 204). */
  setPlatformStatus: (status: number) => void;
  uniqueEmail: (label?: string) => string;
  /** Record a user id so teardown deletes it (and its tokens, via ON DELETE CASCADE). */
  trackUser: (id: string) => void;
  registerUser: (overrides?: Partial<{ email: string; password: string; name: string }>) => Promise<{
    id: string;
    email: string;
    password: string;
    name: string;
  }>;
  createServiceClient: (scopes: string[]) => Promise<{ clientId: string; clientSecret: string }>;
  teardown: () => Promise<void>;
}

export async function startIntegrationHarness(): Promise<IntegrationHarness> {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  // Password-reset emails go to the dev console fallback, never to a real SMTP server.
  delete process.env.SMTP_HOST;
  process.env.APP_BASE_URL = 'http://spa.test';

  const platformCalls: string[] = [];
  let platformStatus = 204;
  const platform = express();
  platform.post('/internal/users/:id/memberships', (req, res) => {
    platformCalls.push(req.params.id);
    res.status(platformStatus).end();
  });
  const platformServer = await listen(platform);
  process.env.PLATFORM_URL = platformServer.baseUrl;

  await initKeys();
  const authServer: RunningServer = await listen(createApp());

  const userIds = new Set<string>();
  const clientIds = new Set<string>();
  const uniqueEmail = (label = 'user') => `it-auth-${label}-${randomUUID()}@example.test`;

  return {
    baseUrl: authServer.baseUrl,
    platformCalls,
    setPlatformStatus: (status) => {
      platformStatus = status;
    },
    uniqueEmail,
    trackUser: (id) => userIds.add(id),
    async registerUser(overrides = {}) {
      const input = {
        email: uniqueEmail(),
        password: `pw-${randomUUID()}`,
        name: 'Integration User',
        ...overrides,
      };
      const res = await postJson<{ id: string }>(authServer.baseUrl, '/auth/register', input);
      if (res.status !== 201) {
        throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
      }
      userIds.add(res.body.id);
      return { id: res.body.id, ...input };
    },
    async createServiceClient(scopes) {
      const clientId = `it-auth-client-${randomUUID()}`;
      const clientSecret = `secret-${randomUUID()}`;
      await getDb()
        .insert(serviceClients)
        .values({ clientId, clientSecretHash: await bcrypt.hash(clientSecret, 4), scopes });
      clientIds.add(clientId);
      return { clientId, clientSecret };
    },
    async teardown() {
      const db = getDb();
      if (userIds.size > 0) {
        await db.delete(users).where(inArray(users.id, [...userIds]));
      }
      if (clientIds.size > 0) {
        await db.delete(serviceClients).where(inArray(serviceClients.clientId, [...clientIds]));
      }
      await authServer.close();
      await platformServer.close();
      await closeDb();
    },
  };
}
