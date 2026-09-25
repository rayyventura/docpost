import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
import type { JobSummary, TaskDetail } from './types';
import { formatFailureReason } from './failureMessages';
import { formatDate } from '../formatDate';

interface JobDashboardProps {
  jobId?: string;
}

function uploadedByLine(name: string, createdAt: string): string {
  const when = formatDate(createdAt, true).replace(', ', ' ');
  return `Uploaded by ${name.toUpperCase()}, ${when}`;
}

function aggregateStatus(counts: JobSummary['counts']): string {
  const total = counts.pending + counts.in_progress + counts.completed + counts.failed;
  if (total === 0 || counts.pending === total) return 'pending';
  if (counts.completed === total) return 'completed';
  if (counts.failed > 0 && counts.pending === 0 && counts.in_progress === 0) return 'failed';
  return 'in_progress';
}

export function JobDashboard({ jobId }: JobDashboardProps) {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(jobId ?? null);
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [tasks, setTasks] = useState<TaskDetail[]>([]);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!jobId) return;
    setSelectedJobId(jobId);
    setTaskPage(1);
    setStatusFilter('');
  }, [jobId]);

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

    void loadJob();

    const interval = setInterval(() => void loadJob(), 15000);
    return () => clearInterval(interval);
  }, [selectedJobId, taskPage, statusFilter]);

  useEffect(() => {
    if (!selectedJobId) return;

    const token = sessionStorage.getItem('accessToken');
    if (!token) return;

    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer = 0;

    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);

      socket.onopen = () => {
        attempt = 0;
        socket?.send(JSON.stringify({ action: 'subscribe', jobId: selectedJobId }));
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as {
          type?: string;
          jobId?: string;
          taskId?: string;
          status?: string;
          failureReason?: string;
          counts?: JobSummary['counts'];
        };
        if (message.type === 'subscribed') {
          void apiRequest<JobSummary>(`/jobs/${selectedJobId}`).then(setSelectedJob).catch(console.error);
          return;
        }
        if (message.type !== 'task_update' || message.jobId !== selectedJobId) return;

        if (message.taskId && message.status) {
          setTasks((current) => current.map((task) => (
            task.taskId === message.taskId
              ? { ...task, status: message.status ?? task.status, failureReason: message.failureReason ?? task.failureReason }
              : task
          )));
        }
        if (message.counts) {
          setSelectedJob((current) => current ? {
            ...current,
            counts: message.counts ?? current.counts,
            aggregateStatus: aggregateStatus(message.counts ?? current.counts),
          } : current);
        }
      };

      socket.onclose = () => {
        if (closed) return;
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [selectedJobId]);

  const handleSelectJob = useCallback((id: string) => {
    setSelectedJobId(id);
    setTaskPage(1);
    setStatusFilter('');
  }, []);

  const downloadFile = useCallback(async (fileId: string) => {
    const data = await apiRequest<{ url: string }>(`/files/${fileId}/download-url`, { method: 'POST' });
    window.open(data.url, '_blank', 'noopener');
  }, []);

  if (!selectedJobId) {
    return (
      <div className="job-dashboard">
        {jobs.length === 0 ? (
          <p className="empty-state">No deliveries yet</p>
        ) : (
          <ul className="job-list">
            {jobs.map((j) => (
              <li key={j.jobId} className="job-item" onClick={() => handleSelectJob(j.jobId)}>
                <div className="job-item-header">
                  <span className={`status-badge status-${j.aggregateStatus}`}>
                    {j.aggregateStatus}
                  </span>
                  <span className="job-item-meta">
                    {uploadedByLine(j.submitterName, j.createdAt)}
                  </span>
                </div>
                <div className="job-item-counts">
                  {j.taskCount} items. {j.counts.completed} done, {j.counts.failed} failed,{' '}
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
          &larr; All Deliveries
        </button>
        <h2>Delivery Details</h2>
      </div>

      {selectedJob && (
        <div className="job-summary">
          <div className="summary-row">
            <span className={`status-badge status-${selectedJob.aggregateStatus}`}>
              {selectedJob.aggregateStatus}
            </span>
            <span>{selectedJob.taskCount} total items</span>
            <span className="job-item-meta">
              {uploadedByLine(selectedJob.submitterName, selectedJob.createdAt)}
            </span>
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
              <th>Destination</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.taskId} className={`task-row task-${t.status}`}>
                <td>{t.fileName ?? t.fileId.slice(0, 8)}</td>
                <td className="task-destination">{t.destination ?? '—'}</td>
                <td>
                  <span className={`status-badge status-${t.status}`}>{t.status}</span>
                </td>
                <td>{t.attemptCount}</td>
                <td>
                  {t.failureReason && <span className="failure-reason">{formatFailureReason(t.failureReason)}</span>}
                  {t.status === 'completed' && (
                    <button type="button" className="btn btn-sm" onClick={() => void downloadFile(t.fileId)}>
                      Download
                    </button>
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
