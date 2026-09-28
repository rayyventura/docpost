import { describe, expect, it } from 'vitest';
import { aggregateStatus, statusClass, statusLabel } from './jobStatus';

const counts = (c: Partial<Record<'pending' | 'in_progress' | 'completed' | 'failed', number>>) => ({
  pending: 0,
  in_progress: 0,
  completed: 0,
  failed: 0,
  ...c,
});

describe('aggregateStatus', () => {
  it('is pending with no tasks or nothing started', () => {
    expect(aggregateStatus(counts({}))).toBe('pending');
    expect(aggregateStatus(counts({ pending: 3 }))).toBe('pending');
  });

  it('is in_progress while work remains, even with failures', () => {
    expect(aggregateStatus(counts({ pending: 1, completed: 1 }))).toBe('in_progress');
    expect(aggregateStatus(counts({ in_progress: 1, failed: 1 }))).toBe('in_progress');
  });

  it('is completed when every task completed', () => {
    expect(aggregateStatus(counts({ completed: 4 }))).toBe('completed');
  });

  it('is completed_with_errors (not failed) when some failed and nothing is outstanding', () => {
    expect(aggregateStatus(counts({ completed: 2, failed: 1 }))).toBe('completed_with_errors');
    expect(aggregateStatus(counts({ failed: 3 }))).toBe('completed_with_errors');
  });
});

describe('statusLabel / statusClass', () => {
  it('labels completed_with_errors for people', () => {
    expect(statusLabel('completed_with_errors')).toBe('Completed with errors');
    expect(statusClass('completed_with_errors')).toBe('status-badge status-completed-with-errors');
  });

  it('keeps task-level labels', () => {
    expect(statusLabel('failed')).toBe('Failed');
    expect(statusLabel('in_progress')).toBe('In progress');
    expect(statusLabel('something_new')).toBe('something new');
  });
});
