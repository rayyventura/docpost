import { inArray } from 'drizzle-orm';
import { FOLDER_DESTINATION_REQUIRED, ValidationError } from '@docpost/shared';
import { getDb } from '../db/index.js';
import { isUuid } from './ids.js';
import { binders, folders } from '../db/schema.js';

export async function assertFolderDestinations(
  items: Array<{ teamId: string; binderId: string; folderId?: string | null }>,
): Promise<void> {
  if (items.length === 0) {
    throw new ValidationError('Choose at least one destination');
  }

  for (const item of items) {
    if (!item.folderId) {
      throw new ValidationError(FOLDER_DESTINATION_REQUIRED);
    }
  }

  // Malformed ids are left out of the lookups, so they fail below exactly like unknown ids.
  const binderIds = [...new Set(items.map((item) => item.binderId))].filter(isUuid);
  const folderIds = [...new Set(items.map((item) => item.folderId))].filter(isUuid);
  const db = getDb();
  const [binderRows, folderRows] = await Promise.all([
    binderIds.length
      ? db.select({ id: binders.id, teamId: binders.teamId }).from(binders).where(inArray(binders.id, binderIds))
      : [],
    folderIds.length
      ? db
          .select({ id: folders.id, binderId: folders.binderId })
          .from(folders)
          .where(inArray(folders.id, folderIds))
      : [],
  ]);
  const binderById = new Map(binderRows.map((binder) => [binder.id, binder]));
  const folderById = new Map(folderRows.map((folder) => [folder.id, folder]));

  for (const item of items) {
    const binder = binderById.get(item.binderId);
    if (!binder || binder.teamId !== item.teamId) {
      throw new ValidationError('Binder does not belong to the specified team');
    }
    const folder = folderById.get(item.folderId as string);
    if (!folder || folder.binderId !== item.binderId) {
      throw new ValidationError('Choose a folder in the selected binder');
    }
  }
}
