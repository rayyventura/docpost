import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { getDb, closeDb } from './index.js';
import { users, serviceClients } from './schema.js';

dotenv.config();

async function seed() {
  const db = getDb();

  console.log('Seeding database...');

  // Create delivery-worker service client
  const deliveryWorkerSecret = 'delivery-worker-local-secret';
  const deliveryWorkerHash = await bcrypt.hash(deliveryWorkerSecret, 12);

  await db
    .insert(serviceClients)
    .values({
      clientId: 'delivery-worker',
      clientSecretHash: deliveryWorkerHash,
      scopes: ['documents:ingest', 'memberships:read'],
    })
    .onConflictDoNothing({ target: serviceClients.clientId });

  console.log('Created service client: delivery-worker');
  console.log(`  Secret (local dev only): ${deliveryWorkerSecret}`);
  console.log('  Scopes: documents:ingest, memberships:read');

  // Create test users with deterministic IDs matching the platform seed
  const testUsers = [
    { id: '00000000-0000-0000-0000-000000000001', email: 'alice@example.com', password: 'password123', name: 'Alice Johnson' },
    { id: '00000000-0000-0000-0000-000000000002', email: 'bob@example.com', password: 'password123', name: 'Bob Smith' },
    { id: '00000000-0000-0000-0000-000000000003', email: 'carol@example.com', password: 'password123', name: 'Carol Williams' },
    { id: '00000000-0000-0000-0000-000000000004', email: 'rayyventura@gmail.com', password: 'password123', name: 'Rayane Ventura' },
  ];

  for (const testUser of testUsers) {
    const passwordHash = await bcrypt.hash(testUser.password, 12);
    await db
      .insert(users)
      .values({
        id: testUser.id,
        email: testUser.email,
        passwordHash,
        name: testUser.name,
      })
      .onConflictDoNothing({ target: users.email });

    console.log(`Created test user: ${testUser.email} (id: ${testUser.id})`);
  }

  console.log('\nSeed complete.');
  await closeDb();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
