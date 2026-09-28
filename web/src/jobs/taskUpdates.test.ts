import { describe, expect, it } from 'vitest';
import { applyJobCounts, applyTaskUpdate, countSegmentAction, firstTaskIdForStatus, mergeFetchedTasks } from './taskUpdates';
import type { TaskDetail } from './types';
import { formatFailureReason } from './failureMessages';

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

describe('failure reasons', () => {
  const platformReason =
    'Platform rejected the document (422 CHECKSUM_MISMATCH): Declared checksum does not match uploaded bytes';

  it('records the failure reason pushed with a live task_update', () => {
    const rows = [task({ taskId: 'real-1', status: 'in_progress', attemptCount: 1 })];
    const result = applyTaskUpdate(rows, { taskId: 'real-1', status: 'failed', failureReason: platformReason });
    expect(result.tasks[0]).toMatchObject({ status: 'failed', failureReason: platformReason });
  });

  it('keeps a live failure reason when a stale fetch still says in progress', () => {
    const live = [task({ taskId: 'real-1', status: 'failed', failureReason: platformReason })];
    const stale = [task({ taskId: 'real-1', status: 'in_progress', failureReason: null })];
    expect(mergeFetchedTasks(live, stale)[0]).toMatchObject({ status: 'failed', failureReason: platformReason });
  });

  it('takes the failure reason from GET /jobs/:id/tasks on first load', () => {
    const fetched = [task({ taskId: 'real-1', status: 'failed', failureReason: platformReason })];
    expect(mergeFetchedTasks([], fetched)[0].failureReason).toBe(platformReason);
    const seeded = [task({ taskId: 'pending-job-0' })];
    expect(mergeFetchedTasks(seeded, fetched)[0].failureReason).toBe(platformReason);
  });
});

describe('DELIVERY_REJECTED failure reasons', () => {
  const rejected = `DELIVERY_REJECTED ${JSON.stringify({
    fileName: 'note.pdf',
    status: '400',
    code: 'VALIDATION_ERROR',
    reason: 'folderId must be a UUID',
  })}`;
  const expected = 'The document platform rejected this file (400 VALIDATION_ERROR): folderId must be a UUID';

  it('renders a friendly message for a task from the initial GET /jobs/:id/tasks load', () => {
    const fetched = [task({ taskId: 'real-1', status: 'failed', attemptCount: 1, failureReason: rejected })];
    const [row] = mergeFetchedTasks([task({ taskId: 'pending-job-0' })], fetched);
    expect(row.failureReason).toBe(rejected);
    expect(formatFailureReason(row.failureReason!)).toBe(expected);
  });

  it('renders a friendly message for a live task_update push', () => {
    const rows = [task({ taskId: 'real-1', status: 'in_progress', attemptCount: 1 })];
    const { tasks: [row] } = applyTaskUpdate(rows, { taskId: 'real-1', status: 'failed', failureReason: rejected });
    expect(row.status).toBe('failed');
    expect(formatFailureReason(row.failureReason!)).toBe(expected);
  });

  it('renders a live push without a platform code', () => {
    const noCode = `DELIVERY_REJECTED ${JSON.stringify({ fileName: 'note.pdf', status: '415', reason: 'Unsupported Media Type' })}`;
    const { tasks: [row] } = applyTaskUpdate([task({ taskId: 'real-1', status: 'in_progress' })], {
      taskId: 'real-1',
      status: 'failed',
      failureReason: noCode,
    });
    expect(formatFailureReason(row.failureReason!)).toBe('The document platform rejected this file (415): Unsupported Media Type');
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

  it('keeps the send destination when the fetched row has none', () => {
    const seeded = [task({ taskId: 'pending-job-0', destination: 'Cardiology Trial / Patient Records / Intake Forms' })];
    const fetched = [
      task({
        taskId: 'real-1',
        status: 'completed',
        destination: null,
        teamName: null,
        binderName: null,
        folderPath: [],
      }),
    ];
    expect(mergeFetchedTasks(seeded, fetched)[0]).toMatchObject({
      taskId: 'real-1',
      status: 'completed',
      destination: 'Cardiology Trial / Patient Records / Intake Forms',
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

describe('countSegmentAction', () => {
  it('filters when the matching item is not on the first page', () => {
    expect(
      countSegmentAction({
        status: 'failed',
        count: 3,
        statusFilter: '',
        taskPage: 1,
        matchOnPage: false,
      }),
    ).toBe('filter');
  });

  it('filters when the user is already past page 1', () => {
    expect(
      countSegmentAction({
        status: 'failed',
        count: 3,
        statusFilter: 'failed',
        taskPage: 2,
        matchOnPage: true,
      }),
    ).toBe('filter');
  });

  it('reveals when the first matching item is already on page 1', () => {
    expect(
      countSegmentAction({
        status: 'failed',
        count: 3,
        statusFilter: '',
        taskPage: 1,
        matchOnPage: true,
      }),
    ).toBe('reveal');
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
