import type { JobSummary } from './types';

/** Job-level status, derived from task counts exactly as the API derives it (blueprint). */
export type AggregateStatus = 'pending' | 'in_progress' | 'completed' | 'completed_with_errors';

export function aggregateStatus(counts: JobSummary['counts']): AggregateStatus {
  const total = counts.pending + counts.in_progress + counts.completed + counts.failed;
  if (total === 0 || counts.pending === total) return 'pending';
  if (counts.completed === total) return 'completed';
  if (counts.failed > 0 && counts.pending === 0 && counts.in_progress === 0) return 'completed_with_errors';
  return 'in_progress';
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  uploading: 'Uploading',
  in_progress: 'In progress',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  // Task-level status; jobs never report this.
  failed: 'Failed',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replaceAll('_', ' ');
}

export function statusClass(status: string): string {
  return `status-badge status-${status.replaceAll('_', '-')}`;
}
