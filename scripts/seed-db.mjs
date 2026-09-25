// Loads the local databases for a fresh clone.
// Requires `npm install` and Postgres from `docker compose up -d`.
// New accounts are added to every seeded team.
// More granular permission access will be provided on demand in v2.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const services = [
  {
    name: 'auth',
    dir: 'services/auth',
    databaseUrl: 'postgresql://auth_service:auth_local@localhost:5432/docpost_auth',
    seed: true,
  },
  {
    name: 'platform',
    dir: 'services/platform',
    databaseUrl: 'postgresql://platform_service:platform_local@localhost:5432/docpost_platform',
    seed: true,
  },
  {
    name: 'docpost-api',
    dir: 'services/docpost-api',
    databaseUrl: 'postgresql://docpost_service:docpost_local@localhost:5432/docpost_api',
    seed: false,
  },
];

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const service of services) {
  const cwd = path.join(root, service.dir);
  const env = { DATABASE_URL: service.databaseUrl };

  console.log(`\nCreating ${service.name} tables...`);
  run('npx', ['drizzle-kit', 'push', '--force'], cwd, env);

  if (service.seed) {
    console.log(`\nSeeding ${service.name}...`);
    run('npx', ['tsx', 'src/db/seed.ts'], cwd, env);
  }
}

const authUrl = services.find((service) => service.name === 'auth').databaseUrl;
const platformUrl = services.find((service) => service.name === 'platform').databaseUrl;
const auth = new pg.Client({ connectionString: authUrl });
const platform = new pg.Client({ connectionString: platformUrl });

await auth.connect();
await platform.connect();

const users = await auth.query('SELECT id FROM users');
const teams = await platform.query('SELECT id FROM teams');

for (const user of users.rows) {
  await platform.query(
    `INSERT INTO team_members (team_id, user_id)
     SELECT id, $1 FROM teams
     ON CONFLICT DO NOTHING`,
    [user.id],
  );
}

await auth.end();
await platform.end();

console.log(
  `\nGranted ${users.rows.length} existing user${users.rows.length === 1 ? '' : 's'} access to ${teams.rows.length} teams.`,
);
console.log('\nLocal databases are ready.');
console.log('Sign in with alice@example.com, bob@example.com, carol@example.com, or rayyventura@gmail.com.');
console.log('Password: password123');
