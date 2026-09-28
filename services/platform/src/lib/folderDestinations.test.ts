import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FOLDER_DESTINATION_REQUIRED, ValidationError } from '@docpost/shared';
import { binders, folders } from '../db/schema.js';

type Row = Record<string, string>;

const db = vi.hoisted(() => ({
  binderRows: [] as Array<Record<string, string>>,
  folderRows: [] as Array<Record<string, string>>,
  selects: 0,
}));

// Minimal drizzle stand-in: select(...).from(table).where(...) resolves to canned rows.
vi.mock('../db/index.js', () => ({
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => ({
        where: async () => {
          db.selects++;
          return table === binders ? db.binderRows : table === folders ? db.folderRows : [];
        },
      }),
    }),
  }),
}));

const { assertFolderDestinations } = await import('./folderDestinations.js');

const TEAM = 'team-1';
const BINDER = 'binder-1';
const FOLDER = 'folder-1';

function seed(binderRows: Row[], folderRows: Row[]) {
  db.binderRows = binderRows;
  db.folderRows = folderRows;
}

beforeEach(() => {
  db.selects = 0;
  seed([{ id: BINDER, teamId: TEAM }], [{ id: FOLDER, binderId: BINDER }]);
});

describe('assertFolderDestinations', () => {
  it('passes when every folder is in its binder and every binder in its team', async () => {
    await expect(
      assertFolderDestinations([{ teamId: TEAM, binderId: BINDER, folderId: FOLDER }]),
    ).resolves.toBeUndefined();
  });

  it('rejects an empty list without querying', async () => {
    await expect(assertFolderDestinations([])).rejects.toThrow('Choose at least one destination');
    expect(db.selects).toBe(0);
  });

  it.each([undefined, null, ''])('rejects a destination with folderId %j without querying', async (folderId) => {
    const err = await assertFolderDestinations([{ teamId: TEAM, binderId: BINDER, folderId }]).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe(FOLDER_DESTINATION_REQUIRED);
    expect(db.selects).toBe(0);
  });

  it('rejects when any one of several destinations lacks a folder', async () => {
    await expect(
      assertFolderDestinations([
        { teamId: TEAM, binderId: BINDER, folderId: FOLDER },
        { teamId: TEAM, binderId: BINDER },
      ]),
    ).rejects.toThrow(FOLDER_DESTINATION_REQUIRED);
  });

  it('rejects an unknown binder', async () => {
    seed([], [{ id: FOLDER, binderId: BINDER }]);
    await expect(
      assertFolderDestinations([{ teamId: TEAM, binderId: BINDER, folderId: FOLDER }]),
    ).rejects.toThrow('Binder does not belong to the specified team');
  });

  it('rejects a binder from another team', async () => {
    await expect(
      assertFolderDestinations([{ teamId: 'team-2', binderId: BINDER, folderId: FOLDER }]),
    ).rejects.toThrow('Binder does not belong to the specified team');
  });

  it('rejects an unknown folder', async () => {
    seed([{ id: BINDER, teamId: TEAM }], []);
    await expect(
      assertFolderDestinations([{ teamId: TEAM, binderId: BINDER, folderId: FOLDER }]),
    ).rejects.toThrow('Choose a folder in the selected binder');
  });

  it('rejects a folder from another binder', async () => {
    seed(
      [
        { id: BINDER, teamId: TEAM },
        { id: 'binder-2', teamId: TEAM },
      ],
      [{ id: FOLDER, binderId: 'binder-2' }],
    );
    await expect(
      assertFolderDestinations([{ teamId: TEAM, binderId: BINDER, folderId: FOLDER }]),
    ).rejects.toThrow('Choose a folder in the selected binder');
  });

  it('batches lookups into one binder query and one folder query regardless of item count', async () => {
    seed(
      [
        { id: BINDER, teamId: TEAM },
        { id: 'binder-2', teamId: TEAM },
      ],
      [
        { id: FOLDER, binderId: BINDER },
        { id: 'folder-2', binderId: 'binder-2' },
      ],
    );
    await assertFolderDestinations([
      { teamId: TEAM, binderId: BINDER, folderId: FOLDER },
      { teamId: TEAM, binderId: 'binder-2', folderId: 'folder-2' },
      { teamId: TEAM, binderId: BINDER, folderId: FOLDER },
    ]);
    expect(db.selects).toBe(2);
  });
});
