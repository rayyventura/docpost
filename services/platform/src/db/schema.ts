import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  bigint,
  primaryKey,
  index,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  region: text('region').notNull(),
  docpostEnabled: boolean('docpost_enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id),
    userId: uuid('user_id').notNull(),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index('team_members_user_id_idx').on(table.userId),
  ],
);

export const binders = pgTable(
  'binders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('binders_team_id_idx').on(table.teamId)],
);

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    binderId: uuid('binder_id')
      .notNull()
      .references(() => binders.id),
    parentFolderId: uuid('parent_folder_id'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('folders_binder_parent_idx').on(table.binderId, table.parentFolderId),
    foreignKey({
      columns: [table.parentFolderId],
      foreignColumns: [table.id],
      name: 'folders_parent_folder_id_fk',
    }),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    binderId: uuid('binder_id')
      .notNull()
      .references(() => binders.id),
    folderId: uuid('folder_id').references(() => folders.id),
    name: text('name').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }).notNull(),
    contentType: text('content_type').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    sourceTaskId: uuid('source_task_id'),
    uploadedByUserId: uuid('uploaded_by_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('documents_source_task_id_unique').on(table.sourceTaskId)],
);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type Binder = typeof binders.$inferSelect;
export type NewBinder = typeof binders.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
