import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { postJson } from '../testing/http.js';
import {
  DEFAULT_DATABASE_URL,
  startIntegrationHarness,
  type IntegrationHarness,
} from '../testing/integration.js';

describe.skipIf(!process.env.INTEGRATION)('POST /auth/register (integration)', () => {
  let h: IntegrationHarness;

  // Tag this file's pool connections so the race test can tell its own lock waiters apart from
  // other test files (or other local users of the database).
  const appName = `docpost-auth-it-register-${process.pid}`;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
    url.searchParams.set('application_name', appName);
    process.env.DATABASE_URL = url.toString();
    h = await startIntegrationHarness();
  });

  afterAll(async () => {
    await h?.teardown();
  });

  beforeEach(() => {
    // Expected 500 paths log through the shared errorHandler; keep the output readable.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type ErrorBody = { error: { code: string; message: string } };

  it('creates the user row, hashes the password, and assigns teams on the platform', async () => {
    const email = h.uniqueEmail('register');
    const res = await postJson<{ id: string; email: string; name: string }>(h.baseUrl, '/auth/register', {
      email,
      password: 'password123',
      name: 'Reg User',
    });
    if (res.status === 201) h.trackUser(res.body.id);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), email, name: 'Reg User' });
    expect(h.platformCalls).toContain(res.body.id);

    const [row] = await getDb().select().from(users).where(eq(users.id, res.body.id));
    expect(row.email).toBe(email);
    expect(await bcrypt.compare('password123', row.passwordHash)).toBe(true);
  });

  it('rejects invalid input with 422 and writes nothing', async () => {
    const email = h.uniqueEmail('invalid');
    const res = await postJson<ErrorBody>(h.baseUrl, '/auth/register', { email, password: 'short', name: 'X' });
    expect(res.status).toBe(422);
    expect(await getDb().select().from(users).where(eq(users.email, email))).toHaveLength(0);
  });

  it('returns 409 for a duplicate email', async () => {
    const existing = await h.registerUser();
    const res = await postJson<ErrorBody>(h.baseUrl, '/auth/register', {
      email: existing.email,
      password: 'another-password',
      name: 'Dup',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('removes the user again when platform team assignment fails', async () => {
    const email = h.uniqueEmail('platform-fail');
    h.setPlatformStatus(503);
    try {
      const res = await postJson(h.baseUrl, '/auth/register', { email, password: 'password123', name: 'X' });
      expect(res.status).toBe(500);
    } finally {
      h.setPlatformStatus(204);
    }
    expect(await getDb().select().from(users).where(eq(users.email, email))).toHaveLength(0);
  });

  // Registration does check-then-insert. Two concurrent registrations for the same new email both
  // pass the SELECT and one INSERT wins; the loser's Postgres 23505 must map to the documented 409.
  // To make the interleaving deterministic, a separate connection holds a lock on `users` that lets
  // SELECTs through but blocks INSERTs until both requests are waiting on it.
  it('returns 409 (not 500) to the loser of a concurrent duplicate registration', async () => {
    const email = h.uniqueEmail('race');
    const locker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await locker.connect();
    let attempts: Array<{ status: number; body: { id?: string } }> = [];
    try {
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      const pending = Promise.all(
        [1, 2].map(() =>
          postJson<{ id?: string }>(h.baseUrl, '/auth/register', { email, password: 'password123', name: 'Race' }),
        ),
      );
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        // pg_stat_activity is snapshotted per transaction; clear it so each poll sees live sessions.
        await locker.query('SELECT pg_stat_clear_snapshot()');
        const { rows } = await locker.query<{ waiting: number }>(
          `SELECT count(*)::int AS waiting
             FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
            WHERE l.relation = 'users'::regclass AND NOT l.granted AND a.application_name = $1`,
          [appName],
        );
        if (rows[0].waiting >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await locker.query('COMMIT');
      attempts = await pending;
    } finally {
      await locker.end();
      for (const a of attempts) if (a.status === 201 && a.body.id) h.trackUser(a.body.id);
    }

    expect(attempts.map((a) => a.status).sort()).toEqual([201, 409]);
    const loser = attempts.find((a) => a.status === 409)!;
    expect(loser.body).toEqual({ error: { code: 'CONFLICT', message: 'Registration failed' } });
    expect(await getDb().select().from(users).where(eq(users.email, email))).toHaveLength(1);
  }, 30_000);
});
