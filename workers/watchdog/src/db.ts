import { drizzle } from 'drizzle-orm/node-postgres';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

let pool: pg.Pool | undefined;
let ready: Promise<void> | undefined;

function connectionStringFromSecret(raw: string): string {
  if (raw.startsWith('postgres')) return raw;
  const parsed = JSON.parse(raw) as {
    username?: string;
    password?: string;
    host?: string;
    port?: string | number;
    dbname?: string;
    url?: string;
    DATABASE_URL?: string;
  };
  if (parsed.url || parsed.DATABASE_URL) return parsed.url ?? parsed.DATABASE_URL!;
  return `postgresql://${encodeURIComponent(parsed.username ?? '')}:${encodeURIComponent(parsed.password ?? '')}@${parsed.host}:${parsed.port}/${parsed.dbname}`;
}

async function resolveDatabaseUrl(): Promise<string> {
  const secretId = process.env.DATABASE_SECRET_ARN;
  if (secretId) {
    const client = new SecretsManagerClient({});
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    return connectionStringFromSecret(result.SecretString ?? '');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or DATABASE_SECRET_ARN is required');
  return connectionStringFromSecret(databaseUrl);
}

export async function getDb() {
  if (!ready) {
    ready = resolveDatabaseUrl().then((url) => {
      pool = new Pool({ connectionString: url });
    });
  }
  await ready;
  return drizzle(pool!, { schema });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    ready = undefined;
  }
}
