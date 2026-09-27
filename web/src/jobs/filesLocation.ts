import type { FilesLocationState, FolderPathSegment, TaskDetail } from './types';

function pathParts(destination: string | null | undefined): string[] {
  return (destination ?? '')
    .split(' / ')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function filesStateFromTask(
  task: Pick<TaskDetail, 'teamId' | 'binderId' | 'folderId' | 'destination' | 'teamName' | 'binderName' | 'folderPath'>,
): FilesLocationState | null {
  if (!task.teamId || !task.binderId) return null;

  const parts = pathParts(task.destination);
  const folderPath: FolderPathSegment[] = task.folderPath?.length
    ? task.folderPath
    : task.folderId
      ? [{ id: task.folderId, name: parts.slice(2).join(' / ') || 'Folder' }]
      : [];

  return {
    teamId: task.teamId,
    teamName: task.teamName || parts[0] || 'Team',
    binderId: task.binderId,
    binderName: task.binderName || parts[1] || 'Binder',
    folderPath,
  };
}

export function filesStateFromTasks(tasks: TaskDetail[]): FilesLocationState | null {
  if (tasks.length === 0) return null;

  const unique = new Map<string, TaskDetail>();
  for (const task of tasks) {
    unique.set(`${task.teamId}:${task.binderId}:${task.folderId ?? ''}`, task);
  }

  const chosen =
    unique.size === 1
      ? [...unique.values()][0]
      : tasks.find((task) => task.status === 'completed') ?? tasks[0];

  return filesStateFromTask(chosen);
}
