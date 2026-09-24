import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ----- jobs (defined first so files and tasks can reference it) -----

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    submittedByUserId: uuid('submitted_by_user_id').notNull(),
    taskCount: integer('task_count').notNull(),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('jobs_submitted_by_user_id_created_at_idx').on(
      table.submittedByUserId,
      table.createdAt,
    ),
  ],
);

// ----- files (references jobs) -----

export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id').notNull(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    originalName: text('original_name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    contentType: text('content_type').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    s3Key: text('s3_key').notNull(),
    status: text('status', { enum: ['pending', 'uploaded', 'expired'] })
      .notNull()
      .default('pending'),
    verificationError: text('verification_error'),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    stagingDeadlineAt: timestamp('staging_deadline_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('files_staging_deadline_pending_idx')
      .on(table.stagingDeadlineAt)
      .where(sql`status = 'pending'`),
  ],
);

// ----- tasks (references jobs and files) -----

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    teamId: uuid('team_id').notNull(),
    binderId: uuid('binder_id').notNull(),
    folderId: uuid('folder_id'),
    region: text('region').notNull(),
    status: text('status', { enum: ['pending', 'in_progress', 'completed', 'failed'] })
      .notNull()
      .default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    failureReason: text('failure_reason'),
    platformDocumentId: uuid('platform_document_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tasks_file_team_binder_folder_idx')
      .on(table.fileId, table.teamId, table.binderId, table.folderId)
      .where(sql`folder_id IS NOT NULL`),
    uniqueIndex('tasks_file_team_binder_idx')
      .on(table.fileId, table.teamId, table.binderId)
      .where(sql`folder_id IS NULL`),
    index('tasks_job_id_status_idx').on(table.jobId, table.status),
  ],
);

// ----- ws_connections -----

export const wsConnections = pgTable(
  'ws_connections',
  {
    connectionId: text('connection_id').primaryKey(),
    userId: uuid('user_id').notNull(),
    jobId: uuid('job_id'),
    connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ws_connections_job_id_idx').on(table.jobId)],
);

// ----- Type exports -----

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type WsConnection = typeof wsConnections.$inferSelect;
export type NewWsConnection = typeof wsConnections.$inferInsert;
