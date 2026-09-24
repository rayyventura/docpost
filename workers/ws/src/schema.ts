import { pgTable, text, timestamp, uuid, index } from 'drizzle-orm/pg-core';

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey(),
  submittedByUserId: uuid('submitted_by_user_id').notNull(),
});

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
