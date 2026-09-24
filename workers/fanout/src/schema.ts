import { pgTable, text, timestamp, uuid, integer, bigint } from 'drizzle-orm/pg-core';

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  submittedByUserId: uuid('submitted_by_user_id').notNull(),
  taskCount: integer('task_count').notNull(),
  nextCheckAt: timestamp('next_check_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerUserId: uuid('owner_user_id').notNull(),
  jobId: uuid('job_id').notNull(),
  originalName: text('original_name').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
  contentType: text('content_type').notNull(),
  checksumSha256: text('checksum_sha256').notNull(),
  s3Key: text('s3_key').notNull(),
  status: text('status', { enum: ['pending', 'uploaded', 'expired'] }).notNull().default('pending'),
  verificationError: text('verification_error'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  stagingDeadlineAt: timestamp('staging_deadline_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull(),
  fileId: uuid('file_id').notNull(),
  teamId: uuid('team_id').notNull(),
  binderId: uuid('binder_id').notNull(),
  folderId: uuid('folder_id'),
  region: text('region').notNull(),
  status: text('status', { enum: ['pending', 'in_progress', 'completed', 'failed'] }).notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  failureReason: text('failure_reason'),
  platformDocumentId: uuid('platform_document_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
