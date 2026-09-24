import dotenv from 'dotenv';
dotenv.config();

import { getDb, closeDb, schema } from './index.js';

const USER_1_ID = '00000000-0000-0000-0000-000000000001';
const USER_2_ID = '00000000-0000-0000-0000-000000000002';

async function seed() {
  const db = getDb();

  console.log('Seeding platform database...');

  // Clean existing data (in dependency order)
  await db.delete(schema.documents);
  await db.delete(schema.folders);
  await db.delete(schema.binders);
  await db.delete(schema.teamMembers);
  await db.delete(schema.teams);

  // Create teams
  const [cardiology, oncology, neurology, internalAdmin, archiveTeam] = await db
    .insert(schema.teams)
    .values([
      { name: 'Cardiology Trial', region: 'us-east-1', docpostEnabled: true },
      { name: 'Oncology Study', region: 'eu-west-1', docpostEnabled: true },
      { name: 'Neurology Research', region: 'ap-southeast-1', docpostEnabled: true },
      { name: 'Internal Admin', region: 'us-east-1', docpostEnabled: false },
      { name: 'Archive Team', region: 'eu-west-1', docpostEnabled: false },
    ])
    .returning();

  console.log('Created 5 teams');

  // Create team memberships
  // User 1: member of Cardiology, Oncology, Neurology
  // User 2: member of Cardiology, Oncology only
  await db.insert(schema.teamMembers).values([
    { teamId: cardiology.id, userId: USER_1_ID },
    { teamId: oncology.id, userId: USER_1_ID },
    { teamId: neurology.id, userId: USER_1_ID },
    { teamId: cardiology.id, userId: USER_2_ID },
    { teamId: oncology.id, userId: USER_2_ID },
  ]);

  console.log('Created team memberships');

  // Create binders for enabled teams
  const [
    cardBinder1,
    cardBinder2,
    oncBinder1,
    oncBinder2,
    oncBinder3,
    neuroBinder1,
    neuroBinder2,
  ] = await db
    .insert(schema.binders)
    .values([
      { teamId: cardiology.id, name: 'Patient Records' },
      { teamId: cardiology.id, name: 'Trial Protocols' },
      { teamId: oncology.id, name: 'Clinical Data' },
      { teamId: oncology.id, name: 'Lab Reports' },
      { teamId: oncology.id, name: 'Treatment Plans' },
      { teamId: neurology.id, name: 'Imaging Studies' },
      { teamId: neurology.id, name: 'Research Notes' },
    ])
    .returning();

  console.log('Created 7 binders');

  // Create root folders for binders
  const rootFolders = await db
    .insert(schema.folders)
    .values([
      // Cardiology - Patient Records
      { binderId: cardBinder1.id, name: 'Intake Forms' },
      { binderId: cardBinder1.id, name: 'Progress Notes' },
      { binderId: cardBinder1.id, name: 'Discharge Summaries' },
      // Cardiology - Trial Protocols
      { binderId: cardBinder2.id, name: 'Phase I' },
      { binderId: cardBinder2.id, name: 'Phase II' },
      // Oncology - Clinical Data
      { binderId: oncBinder1.id, name: 'Baseline Assessments' },
      { binderId: oncBinder1.id, name: 'Follow-up Data' },
      // Oncology - Lab Reports
      { binderId: oncBinder2.id, name: 'Blood Work' },
      { binderId: oncBinder2.id, name: 'Biopsies' },
      { binderId: oncBinder2.id, name: 'Genomic Analysis' },
      // Oncology - Treatment Plans
      { binderId: oncBinder3.id, name: 'Chemotherapy' },
      { binderId: oncBinder3.id, name: 'Radiation' },
      // Neurology - Imaging Studies
      { binderId: neuroBinder1.id, name: 'MRI Scans' },
      { binderId: neuroBinder1.id, name: 'CT Scans' },
      // Neurology - Research Notes
      { binderId: neuroBinder2.id, name: 'Literature Reviews' },
      { binderId: neuroBinder2.id, name: 'Experiment Logs' },
    ])
    .returning();

  console.log('Created 16 root folders');

  // Create nested sub-folders (1 level deep)
  const intakeFormsFolder = rootFolders.find((f) => f.name === 'Intake Forms')!;
  const phaseIFolder = rootFolders.find((f) => f.name === 'Phase I')!;
  const bloodWorkFolder = rootFolders.find((f) => f.name === 'Blood Work')!;
  const mriScansFolder = rootFolders.find((f) => f.name === 'MRI Scans')!;

  const subFolders = await db
    .insert(schema.folders)
    .values([
      { binderId: cardBinder1.id, parentFolderId: intakeFormsFolder.id, name: '2024 Cohort' },
      { binderId: cardBinder1.id, parentFolderId: intakeFormsFolder.id, name: '2025 Cohort' },
      { binderId: cardBinder2.id, parentFolderId: phaseIFolder.id, name: 'Dose Escalation' },
      { binderId: oncBinder2.id, parentFolderId: bloodWorkFolder.id, name: 'CBC Results' },
      { binderId: neuroBinder1.id, parentFolderId: mriScansFolder.id, name: 'Pre-treatment' },
      { binderId: neuroBinder1.id, parentFolderId: mriScansFolder.id, name: 'Post-treatment' },
    ])
    .returning();

  console.log('Created 6 sub-folders');

  // Create some existing documents
  const progressNotesFolder = rootFolders.find((f) => f.name === 'Progress Notes')!;
  const baselineFolder = rootFolders.find((f) => f.name === 'Baseline Assessments')!;

  await db.insert(schema.documents).values([
    {
      binderId: cardBinder1.id,
      folderId: progressNotesFolder.id,
      name: 'Patient-001-Visit-3.pdf',
      sizeBytes: BigInt(245760),
      contentType: 'application/pdf',
      checksumSha256: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      uploadedByUserId: USER_1_ID,
    },
    {
      binderId: cardBinder1.id,
      folderId: null,
      name: 'Study-Overview.docx',
      sizeBytes: BigInt(102400),
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      checksumSha256: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
      uploadedByUserId: USER_1_ID,
    },
    {
      binderId: oncBinder1.id,
      folderId: baselineFolder.id,
      name: 'Cohort-A-Baseline.xlsx',
      sizeBytes: BigInt(512000),
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      checksumSha256: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
      uploadedByUserId: USER_2_ID,
    },
    {
      binderId: neuroBinder1.id,
      folderId: subFolders.find((f) => f.name === 'Pre-treatment')!.id,
      name: 'Patient-042-MRI.png',
      sizeBytes: BigInt(2097152),
      contentType: 'image/png',
      checksumSha256: 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
      uploadedByUserId: USER_1_ID,
    },
  ]);

  console.log('Created 4 seed documents');
  console.log('Seed complete!');

  await closeDb();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
