import { describe, expect, it } from 'vitest';
import { applyJobCounts, applyTaskUpdate, firstTaskIdForStatus, mergeFetchedTasks } from './taskUpdates';
import type { TaskDetail } from './types';

function task(overrides: Partial<TaskDetail>): TaskDetail {
  return {
    taskId: 'pending-job-0',
    fileId: 'file-1',
    fileName: 'note.pdf',
    teamId: 'team',
    binderId: 'binder',
    folderId: 'folder',
    destination: 'Team / Binder / Folder',
    status: 'pending',
    attemptCount: 0,
    failureReason: null,
    platformDocumentId: null,
    ...overrides,
  };
}

describe('applyTaskUpdate', () => {
  it('matches a seeded row by file id and adopts the real task id', () => {
    const seeded = [task({ taskId: 'pending-job-0' }), task({ taskId: 'pending-job-1', fileId: 'file-2', fileName: 'lab.pdf' })];

    const result = applyTaskUpdate(seeded, {
      taskId: 'real-1',
      fileId: 'file-1',
      status: 'in_progress',
      attemptCount: 1,
    });

    expect(result.matched).toBe(true);
    expect(result.previousStatus).toBe('pending');
    expect(result.tasks[0]).toMatchObject({
      taskId: 'real-1',
      fileId: 'file-1',
      status: 'in_progress',
      attemptCount: 1,
    });
    expect(result.tasks[1].taskId).toBe('pending-job-1');
  });

  it('binds the next placeholder when the same file is sent to two folders', () => {
    const seeded = [
      task({ taskId: 'pending-job-0', destination: 'A' }),
      task({ taskId: 'pending-job-1', destination: 'B' }),
    ];

    const first = applyTaskUpdate(seeded, { taskId: 'real-a', fileId: 'file-1', status: 'in_progress' });
    const second = applyTaskUpdate(first.tasks, { taskId: 'real-b', fileId: 'file-1', status: 'completed' });

    expect(second.tasks.map((row) => row.taskId)).toEqual(['real-a', 'real-b']);
    expect(second.tasks[1].status).toBe('completed');
  });

  it('falls back to file name when the server id is not on the row yet', () => {
    const seeded = [task({ fileId: '' })];
    const result = applyTaskUpdate(seeded, { taskId: 'real-1', fileName: 'note.pdf', status: 'completed' });
    expect(result.matched).toBe(true);
    expect(result.tasks[0].taskId).toBe('real-1');
  });
});

describe('mergeFetchedTasks', () => {
  it('does not roll a live in-progress row back to a stale pending fetch', () => {
    const live = [task({ taskId: 'real-1', status: 'in_progress', attemptCount: 1 })];
    const fetched = [task({ taskId: 'real-1', status: 'pending', attemptCount: 0 })];
    expect(mergeFetchedTasks(live, fetched)[0]).toMatchObject({
      status: 'in_progress',
      attemptCount: 1,
    });
  });
});

describe('firstTaskIdForStatus', () => {
  it('returns the first row with that status', () => {
    const rows = [
      task({ taskId: 'a', status: 'completed' }),
      task({ taskId: 'b', status: 'failed' }),
      task({ taskId: 'c', status: 'failed' }),
    ];
    expect(firstTaskIdForStatus(rows, 'failed')).toBe('b');
  });
});

describe('applyJobCounts', () => {
  it('moves one item from pending to in progress when the server omitted counts', () => {
    expect(
      applyJobCounts({ pending: 2, in_progress: 0, completed: 0, failed: 0 }, 'pending', 'in_progress'),
    ).toEqual({ pending: 1, in_progress: 1, completed: 0, failed: 0 });
  });

  it('prefers counts from the socket payload', () => {
    expect(
      applyJobCounts(
        { pending: 2, in_progress: 0, completed: 0, failed: 0 },
        'pending',
        'completed',
        { pending: 0, in_progress: 0, completed: 2, failed: 0 },
      ),
    ).toEqual({ pending: 0, in_progress: 0, completed: 2, failed: 0 });
  });
});
