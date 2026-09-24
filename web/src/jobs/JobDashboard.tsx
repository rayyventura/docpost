import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import type { JobSummary, TaskDetail } from './types';

interface JobDashboardProps {
  jobId?: string;
  onBack: () => void;
}

export function JobDashboard({ jobId, onBack }: JobDashboardProps) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(jobId ?? null);
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);

  // Load job list
  useEffect(() => {
    if (!selectedJobId) {
      apiRequest<{ jobs: JobSummary[] }>('/jobs').then((data) => setJobs(data.jobs)).catch(console.error);
    }
  }, [selectedJobId]);

  // Load selected job details and tasks
  useEffect(() => {
    if (!selectedJobId) return;

    const loadJob = async () => {
      setLoading(true);
      try {
        const job = await apiRequest<JobSummary>(`/jobs/${selectedJobId}`);
        setSelectedJob(job);

        const filterParam = statusFilter ? `&status=${statusFilter}` : '';
        const taskData = await apiRequest<{ tasks: TaskDetail[]; total: number }>(
          `/jobs/${selectedJobId}/tasks?page=${taskPage}&limit=100${filterParam}`,
        );
        setTasks(taskData.tasks);
        setTaskTotal(taskData.total);
      } catch (err) {
        console.error(err);
      }
      setLoading(false);
    };

    loadJob();

    // Poll while job is in progress
    const interval = setInterval(loadJob, 3000);
    return () => clearInterval(interval);
  }, [selectedJobId, taskPage, statusFilter]);

  const handleSelectJob = useCallback((id: string) => {
    setSelectedJobId(id);
    setTaskPage(1);
    setStatusFilter('');
  }, []);

  if (!selectedJobId) {
    return (
      <div className="job-dashboard">
        <div className="dashboard-header">
          <h2>Distribution Jobs</h2>
          <button className="btn btn-primary" onClick={onBack}>
            New Distribution
          </button>
        </div>
        {jobs.length === 0 ? (
          <p className="empty-state">No jobs yet</p>
        ) : (
          <ul className="job-list">
            {jobs.map((j) => (
              <li key={j.jobId} className="job-item" onClick={() => handleSelectJob(j.jobId)}>
                <div className="job-item-header">
                  <span className={`status-badge status-${j.aggregateStatus}`}>
                    {j.aggregateStatus}
                  </span>
                  <span className="job-date">
                    {new Date(j.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="job-item-counts">
                  {j.taskCount} tasks — {j.counts.completed} done, {j.counts.failed} failed,{' '}
                  {j.counts.pending + j.counts.in_progress} remaining
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="job-dashboard">
      <div className="dashboard-header">
        <button className="btn" onClick={() => setSelectedJobId(null)}>
          &larr; All Jobs
        </button>
        <h2>Job Details</h2>
      </div>

      {selectedJob && (
        <div className="job-summary">
          <div className="summary-row">
            <span className={`status-badge status-${selectedJob.aggregateStatus}`}>
              {selectedJob.aggregateStatus}
            </span>
            <span>{selectedJob.taskCount} total tasks</span>
            <span>{new Date(selectedJob.createdAt).toLocaleString()}</span>
          </div>
          <div className="counts-bar">
            {selectedJob.counts.completed > 0 && (
              <div
                className="count-segment count-completed"
                style={{
                  width: `${(selectedJob.counts.completed / selectedJob.taskCount) * 100}%`,
                }}
              >
                {selectedJob.counts.completed}
              </div>
            )}
            {selectedJob.counts.in_progress > 0 && (
              <div
                className="count-segment count-in_progress"
                style={{
                  width: `${(selectedJob.counts.in_progress / selectedJob.taskCount) * 100}%`,
                }}
              >
                {selectedJob.counts.in_progress}
              </div>
            )}
            {selectedJob.counts.pending > 0 && (
              <div
                className="count-segment count-pending"
                style={{
                  width: `${(selectedJob.counts.pending / selectedJob.taskCount) * 100}%`,
                }}
              >
                {selectedJob.counts.pending}
              </div>
            )}
            {selectedJob.counts.failed > 0 && (
              <div
                className="count-segment count-failed"
                style={{
                  width: `${(selectedJob.counts.failed / selectedJob.taskCount) * 100}%`,
                }}
              >
                {selectedJob.counts.failed}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="task-filters">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setTaskPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {loading && tasks.length === 0 ? (
        <p className="loading">Loading...</p>
      ) : (
        <table className="task-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.taskId} className={`task-row task-${t.status}`}>
                <td>{t.fileName ?? t.fileId.slice(0, 8)}</td>
                <td>
                  <span className={`status-badge status-${t.status}`}>{t.status}</span>
                </td>
                <td>{t.attemptCount}</td>
                <td>
                  {t.failureReason && <span className="failure-reason">{t.failureReason}</span>}
                  {t.platformDocumentId && (
                    <span className="doc-id">Doc: {t.platformDocumentId.slice(0, 8)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {taskTotal > 100 && (
        <div className="pagination">
          <button
            className="btn btn-sm"
            disabled={taskPage <= 1}
            onClick={() => setTaskPage((p) => p - 1)}
          >
            Previous
          </button>
          <span>
            Page {taskPage} of {Math.ceil(taskTotal / 100)}
          </span>
          <button
            className="btn btn-sm"
            disabled={taskPage >= Math.ceil(taskTotal / 100)}
            onClick={() => setTaskPage((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
