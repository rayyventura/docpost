import { useState, useEffect, useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { apiRequest } from '../api/client';
import { ContentReveal } from '../ContentReveal';
import { PageLoading } from '../PageLoading';
import type { DeliveryLocationState, JobSummary, TaskDetail } from './types';
import { formatFailureReason } from './failureMessages';
import { formatDate } from '../formatDate';

function deliverySeed(state: unknown, jobId: string | undefined): {
  job: JobSummary | null;
  tasks: TaskDetail[];
} {
  if (!jobId || !state || typeof state !== 'object') {
    return { job: null, tasks: [] };
  }

  const seed = state as Partial<DeliveryLocationState>;
  if (seed.jobId !== jobId) {
    return { job: null, tasks: [] };
  }

  const taskCount = seed.taskCount ?? seed.tasks?.length ?? 0;
  return {
    job: {
      jobId: seed.jobId,
      createdAt: seed.createdAt ?? new Date().toISOString(),
      taskCount,
      completedAt: null,
      submitterName: seed.submitterName ?? '',
      counts: {
        pending: taskCount,
        in_progress: 0,
        completed: 0,
        failed: 0,
      },
      aggregateStatus: 'pending',
    },
    tasks: (seed.tasks ?? []).map((task, index) => ({
      taskId: `pending-${jobId}-${index}`,
      fileId: '',
      fileName: task.fileName,
      teamId: task.teamId,
      binderId: task.binderId,
      folderId: task.folderId,
      destination: task.destination,
      status: 'pending',
      attemptCount: 0,
      failureReason: null,
      platformDocumentId: null,
    })),
  };
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replaceAll('_', ' ');
}

function statusClass(status: string): string {
  return `status-badge status-${status.replaceAll('_', '-')}`;
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

export function JobDashboard() {
  const { id } = useParams<{ id: string }>();
  return <JobDashboardView key={id ?? 'list'} jobId={id} />;
}

function JobDashboardView({ jobId }: { jobId: string | undefined }) {
  const navigate = useNavigate();
  const location = useLocation();
  const selectedJobId = jobId ?? null;
  const seed = deliverySeed(location.state, selectedJobId ?? undefined);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(seed.job);
  const [tasks, setTasks] = useState<TaskDetail[]>(seed.tasks);
  const [taskTotal, setTaskTotal] = useState(seed.tasks.length);
  const [taskPage, setTaskPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [loading, setLoading] = useState(!seed.job && !!selectedJobId);
  const [listLoading, setListLoading] = useState(!selectedJobId);

  // Load job list
  useEffect(() => {
    if (selectedJobId) return;

    let cancelled = false;
    setListLoading(true);
    apiRequest<{ jobs: JobSummary[] }>('/jobs')
      .then((data) => {
        if (!cancelled) setJobs(data.jobs);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedJobId]);

  // Load selected job details and tasks
  useEffect(() => {
    if (!selectedJobId) return;

    const loadJob = async () => {
      setLoading(true);
      try {
        const job = await apiRequest<JobSummary>(`/jobs/${selectedJobId}`);
        if (job.jobId !== selectedJobId) return;
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
    void navigate(`/deliveries/${id}`);
  }, [navigate]);

  const visibleJob = selectedJob?.jobId === selectedJobId ? selectedJob : null;
  const visibleTasks = visibleJob ? tasks : [];

  if (!selectedJobId) {
    return (
      <div className="job-dashboard">
        <p className="page-lead">An audit of each send: who filed what, where it was placed, and whether it completed. The documents themselves are in Files.</p>
        {listLoading ? (
          <PageLoading label="Loading deliveries" />
        ) : jobs.length === 0 ? (
          <ContentReveal>
            <p className="empty-state">Nothing has been sent yet. Use Send to place documents in a destination.</p>
          </ContentReveal>
        ) : (
          <ContentReveal>
          <ul className="job-list">
            {jobs.map((j) => (
              <li key={j.jobId} className="job-item" onClick={() => handleSelectJob(j.jobId)}>
                <div className="job-item-header">
                  <span className={statusClass(j.aggregateStatus)}>
                    {statusLabel(j.aggregateStatus)}
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
          </ContentReveal>
        )}
      </div>
    );
  }

  return (
    <div className="job-dashboard">
      <div className="dashboard-header">
        <button className="btn" onClick={() => void navigate('/deliveries')}>
          &larr; All Deliveries
        </button>
        <h2>Delivery Details</h2>
        <button type="button" className="btn" onClick={() => void navigate('/')}>
          View in Files
        </button>
      </div>
      <p className="page-lead">Audit record for this send. The file itself is stored in the destination listed below.</p>

      {visibleJob && (
        <div className="job-summary">
          <div className="summary-row">
            <span className={statusClass(visibleJob.aggregateStatus)}>
              {statusLabel(visibleJob.aggregateStatus)}
            </span>
            <span>{visibleJob.taskCount} total items</span>
            <span className="job-item-meta">
              {uploadedByLine(visibleJob.submitterName, visibleJob.createdAt)}
            </span>
          </div>
          <div className="counts-bar">
            {visibleJob.counts.completed > 0 && (
              <div
                className="count-segment count-completed"
                style={{
                  width: `${(visibleJob.counts.completed / visibleJob.taskCount) * 100}%`,
                }}
              >
                {visibleJob.counts.completed}
              </div>
            )}
            {visibleJob.counts.in_progress > 0 && (
              <div
                className="count-segment count-in-progress"
                style={{
                  width: `${(visibleJob.counts.in_progress / visibleJob.taskCount) * 100}%`,
                }}
              >
                {visibleJob.counts.in_progress}
              </div>
            )}
            {visibleJob.counts.pending > 0 && (
              <div
                className="count-segment count-pending"
                style={{
                  width: `${(visibleJob.counts.pending / visibleJob.taskCount) * 100}%`,
                }}
              >
                {visibleJob.counts.pending}
              </div>
            )}
            {visibleJob.counts.failed > 0 && (
              <div
                className="count-segment count-failed"
                style={{
                  width: `${(visibleJob.counts.failed / visibleJob.taskCount) * 100}%`,
                }}
              >
                {visibleJob.counts.failed}
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
          <option value="in_progress">In progress</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {loading && visibleTasks.length === 0 ? (
        <PageLoading label="Loading delivery details" />
      ) : (
        <ContentReveal>
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
            {visibleTasks.map((t) => (
              <tr key={t.taskId} className={`task-row task-${t.status}`}>
                <td>{t.fileName ?? t.fileId.slice(0, 8)}</td>
                <td className="task-destination">{t.destination ?? '—'}</td>
                <td>
                  <span className={statusClass(t.status)}>{statusLabel(t.status)}</span>
                </td>
                <td>{t.attemptCount}</td>
                <td>
                  {t.failureReason && <span className="failure-reason">{formatFailureReason(t.failureReason)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </ContentReveal>
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
