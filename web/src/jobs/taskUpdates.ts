import type { JobSummary, TaskDetail } from './types';

export type TaskUpdateMessage = {
  taskId?: string;
  fileId?: string;
  fileName?: string;
  status?: string;
  failureReason?: string;
  attemptCount?: number;
  counts?: JobSummary['counts'];
};

export type ApplyTaskUpdateResult = {
  tasks: TaskDetail[];
  matched: boolean;
  previousStatus?: string;
};

function isPlaceholderId(taskId: string): boolean {
  return taskId.startsWith('pending-');
}

function sameFile(
  task: TaskDetail,
  message: { fileId?: string | null; fileName?: string | null },
): boolean {
  if (message.fileId && task.fileId && task.fileId === message.fileId) return true;
  if (message.fileName && task.fileName && task.fileName === message.fileName) return true;
  return false;
}

function findTaskIndex(tasks: TaskDetail[], message: TaskUpdateMessage): number {
  if (message.taskId) {
    const byId = tasks.findIndex((task) => task.taskId === message.taskId);
    if (byId >= 0) return byId;
  }

  if (message.fileId || message.fileName) {
    const placeholder = tasks.findIndex(
      (task) => isPlaceholderId(task.taskId) && sameFile(task, message),
    );
    if (placeholder >= 0) return placeholder;
  }

  return -1;
}

export function applyTaskUpdate(
  tasks: TaskDetail[],
  message: TaskUpdateMessage,
): ApplyTaskUpdateResult {
  if (!message.status) return { tasks, matched: false };

  const index = findTaskIndex(tasks, message);
  if (index < 0) return { tasks, matched: false };

  const current = tasks[index];
  const nextTask: TaskDetail = {
    ...current,
    taskId: message.taskId ?? current.taskId,
    fileId: message.fileId || current.fileId,
    fileName: message.fileName ?? current.fileName,
    status: message.status,
    failureReason: message.failureReason ?? current.failureReason,
    attemptCount: message.attemptCount ?? current.attemptCount,
  };

  const next = tasks.slice();
  next[index] = nextTask;
  return { tasks: next, matched: true, previousStatus: current.status };
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  uploading: 0,
  in_progress: 1,
  completed: 2,
  failed: 2,
};

export function mergeFetchedTasks(current: TaskDetail[], fetched: TaskDetail[]): TaskDetail[] {
  if (current.length === 0) return fetched;

  return fetched.map((task) => {
    const local =
      current.find((row) => row.taskId === task.taskId) ??
      current.find((row) => isPlaceholderId(row.taskId) && sameFile(row, task));
    if (!local) return task;
    if ((STATUS_RANK[local.status] ?? 0) <= (STATUS_RANK[task.status] ?? 0)) return task;
    return {
      ...task,
      status: local.status,
      attemptCount: Math.max(local.attemptCount, task.attemptCount),
      failureReason: local.failureReason ?? task.failureReason,
    };
  });
}

export function applyJobCounts(
  current: JobSummary['counts'],
  previousStatus: string | undefined,
  nextStatus: string,
  serverCounts?: JobSummary['counts'],
): JobSummary['counts'] {
  if (serverCounts) return serverCounts;
  if (!previousStatus || previousStatus === nextStatus) return current;
  if (!(previousStatus in current) || !(nextStatus in current)) return current;

  return {
    ...current,
    [previousStatus]: Math.max(0, current[previousStatus as keyof JobSummary['counts']] - 1),
    [nextStatus]: current[nextStatus as keyof JobSummary['counts']] + 1,
  };
}
