import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { apiRequest } from '../api/client';
import { ContentReveal } from '../ContentReveal';
import { PageLoading } from '../PageLoading';
import type { DeliveryLocationState, FilesLocationState, JobSummary, TaskDetail } from './types';
import { formatFailureReason } from './failureMessages';
import { formatDate } from '../formatDate';
import { uploadForTask, useJobUploads, type JobUploadFile } from './jobUploads';
import { applyJobCounts, applyTaskUpdate, firstTaskIdForStatus, mergeFetchedTasks } from './taskUpdates';
import { deliverySocketUrl } from './wsUrl';

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
      fileId: task.fileId ?? '',
      fileName: task.fileName,
      teamId: task.teamId,
      binderId: task.binderId,
      folderId: task.folderId,
      destination: task.destination,
      teamName: task.teamName ?? null,
      binderName: task.binderName ?? null,
      folderPath: task.folderPath ?? [],
      status: 'pending',
      attemptCount: 0,
      failureReason: null,
      platformDocumentId: null,
    })),
  };
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  uploading: 'Uploading',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status.replaceAll('_', ' ');
}

const MAX_ATTEMPTS = 3;

function exhaustedFailureReason(task: TaskDetail): string {
  return (
    task.failureReason ??
    `RETRIES_EXHAUSTED ${JSON.stringify({
      fileName: task.fileName ?? 'Document',
      attemptCount: String(task.attemptCount),
    })}`
  );
}

function applyUpload(task: TaskDetail, upload: JobUploadFile | undefined): TaskDetail {
  if (!upload) return task;
  if (upload.status === 'uploading') {
    return { ...task, status: 'uploading', failureReason: null };
  }
  if (upload.status === 'error') {
    return {
      ...task,
      status: 'failed',
      failureReason: upload.error
        ? `Document could not be uploaded. ${upload.error}`
        : 'Document could not be uploaded',
    };
  }
  return task;
}

function displayTask(task: TaskDetail): TaskDetail {
  if (task.status === 'uploading') return task;
  if (
    (task.status === 'pending' || task.status === 'in_progress') &&
    task.attemptCount >= MAX_ATTEMPTS
  ) {
    return {
      ...task,
      status: 'failed',
      failureReason: exhaustedFailureReason(task),
    };
  }
  return task;
}

function statusClass(status: string): string {
  return `status-badge status-${status.replaceAll('_', '-')}`;
}

function documentsLocation(task: TaskDetail): FilesLocationState | null {
  if (!task.teamId || !task.binderId || !task.teamName || !task.binderName) {
    return null;
  }

  return {
    teamId: task.teamId,
    teamName: task.teamName,
    binderId: task.binderId,
    binderName: task.binderName,
    folderPath: task.folderPath ?? [],
  };
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

const ACTIVE_POLL_MS = 750;
const IDLE_POLL_MS = 15000;

const COUNT_SEGMENTS = [
  { key: 'completed', status: 'completed', countKey: 'completed', label: 'completed' },
  { key: 'in-progress', status: 'in_progress', countKey: 'in_progress', label: 'in progress' },
  { key: 'pending', status: 'pending', countKey: 'pending', label: 'pending' },
  { key: 'failed', status: 'failed', countKey: 'failed', label: 'failed' },
] as const;

function jobHasOpenWork(job: JobSummary | null | undefined): boolean {
  if (!job) return true;
  return job.counts.pending + job.counts.in_progress > 0;
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
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const uploads = useJobUploads(selectedJobId);
  const pendingScrollStatus = useRef<string | null>(null);
  const focusTimer = useRef(0);

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

  const liveRef = useRef(false);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

  const loadDetails = useCallback(async (showLoading: boolean): Promise<JobSummary | null> => {
    if (!selectedJobId) return null;
    if (showLoading) setLoading(true);
    try {
      const filterParam = statusFilter ? `&status=${statusFilter}` : '';
      const [job, taskData] = await Promise.all([
        apiRequest<JobSummary>(`/jobs/${selectedJobId}`),
        apiRequest<{ tasks: TaskDetail[]; total: number }>(
          `/jobs/${selectedJobId}/tasks?page=${taskPage}&limit=100${filterParam}`,
        ),
      ]);
      if (job.jobId !== selectedJobId) return null;
      setSelectedJob(job);
      const nextTasks = mergeFetchedTasks(tasksRef.current, taskData.tasks);
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      setTaskTotal(taskData.total);
      return job;
    } catch (err) {
      console.error(err);
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [selectedJobId, taskPage, statusFilter]);

  const loadDetailsRef = useRef(loadDetails);
  loadDetailsRef.current = loadDetails;

  useEffect(() => {
    if (!selectedJobId) return;

    let cancelled = false;
    let timer = 0;

    const tick = async (showLoading: boolean) => {
      const job = await loadDetails(showLoading);
      if (cancelled) return;
      const wait = liveRef.current
        ? IDLE_POLL_MS
        : jobHasOpenWork(job)
          ? ACTIVE_POLL_MS
          : IDLE_POLL_MS;
      timer = window.setTimeout(() => void tick(false), wait);
    };

    void tick(!seed.job);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedJobId, loadDetails]);

  useEffect(() => {
    if (!selectedJobId) return;

    const token = sessionStorage.getItem('accessToken');
    if (!token) return;

    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer = 0;

    const connect = () => {
      socket = new WebSocket(deliverySocketUrl(token));

      socket.onopen = () => {
        attempt = 0;
        liveRef.current = true;
        socket?.send(JSON.stringify({ action: 'subscribe', jobId: selectedJobId }));
        void loadDetailsRef.current(false);
      };

      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as {
          type?: string;
          jobId?: string;
          taskId?: string;
          fileId?: string;
          fileName?: string;
          status?: string;
          failureReason?: string;
          attemptCount?: number;
          counts?: JobSummary['counts'];
        };
        if (message.type === 'subscribed') {
          void loadDetailsRef.current(false);
          return;
        }
        if (message.type !== 'task_update' || message.jobId !== selectedJobId) return;

        const result = applyTaskUpdate(tasksRef.current, message);
        const nextStatus = message.status;
        if (result.matched && nextStatus) {
          tasksRef.current = result.tasks;
          setTasks(result.tasks);
          setSelectedJob((current) => {
            if (!current) return current;
            const counts = applyJobCounts(
              current.counts,
              result.previousStatus,
              nextStatus,
              message.counts,
            );
            return { ...current, counts, aggregateStatus: aggregateStatus(counts) };
          });
          return;
        }
        if (message.counts) {
          setSelectedJob((current) => current ? {
            ...current,
            counts: message.counts ?? current.counts,
            aggregateStatus: aggregateStatus(message.counts ?? current.counts),
          } : current);
        }
        if (!result.matched) {
          void loadDetailsRef.current(false);
        }
      };

      socket.onclose = () => {
        liveRef.current = false;
        if (closed) return;
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt += 1;
        timer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      liveRef.current = false;
      window.clearTimeout(timer);
      socket?.close();
    };
  }, [selectedJobId]);

  const handleSelectJob = useCallback((id: string) => {
    void navigate(`/deliveries/${id}`);
  }, [navigate]);

  const visibleJob = selectedJob?.jobId === selectedJobId ? selectedJob : null;
  const uploading = Object.values(uploads).some((upload) => upload.status === 'uploading');
  const visibleTasks = visibleJob
    ? tasks.map((task) => displayTask(applyUpload(task, uploadForTask(task, uploads))))
    : [];
  const visibleStatus = uploading ? 'uploading' : visibleJob?.aggregateStatus;

  const revealStatus = useCallback((status: string, rows: TaskDetail[]) => {
    const taskId = firstTaskIdForStatus(rows, status);
    if (!taskId) return;
    window.clearTimeout(focusTimer.current);
    setFocusTaskId(taskId);
    window.requestAnimationFrame(() => {
      document.getElementById(`task-${taskId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    focusTimer.current = window.setTimeout(() => setFocusTaskId(null), 1600);
  }, []);

  useEffect(() => () => window.clearTimeout(focusTimer.current), []);

  useEffect(() => {
    const status = pendingScrollStatus.current;
    if (!status || loading) return;
    pendingScrollStatus.current = null;
    revealStatus(status, visibleTasks);
  }, [loading, statusFilter, tasks, visibleTasks, revealStatus]);

  const handleCountSegment = (status: string, count: number) => {
    if (count <= 0) return;
    if (statusFilter && statusFilter !== status) {
      pendingScrollStatus.current = status;
      setStatusFilter('');
      setTaskPage(1);
      return;
    }
    revealStatus(status, visibleTasks);
  };

  if (!selectedJobId) {
    return (
      <div className="job-dashboard">
        <p className="page-lead">
          An audit of each send: who filed what, where it was placed, and whether it completed.
          <br />
          The documents themselves are in Documents.
        </p>
        {listLoading ? (
          <PageLoading label="Loading deliveries" />
        ) : jobs.length === 0 ? (
          <ContentReveal>
            <p className="empty-state">Nothing has been sent yet. Use Send documents to place them in a destination.</p>
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
    <div className="job-dashboard job-dashboard--details">
      <div className="dashboard-header">
        <button className="btn" onClick={() => void navigate('/deliveries')}>
          &larr; Delivery audit
        </button>
        <h2>Delivery Details</h2>
        <button
          type="button"
          className="btn"
          onClick={() => void navigate('/')}
        >
          View in Documents
        </button>
      </div>
      <p className="page-lead">
        Audit record for this send.
        <br />
        Authorized users can download the document from Documents.
      </p>

      {visibleJob && (
        <div className="job-summary">
          <div className="summary-row">
            <span className={statusClass(visibleStatus ?? visibleJob.aggregateStatus)}>
              {statusLabel(visibleStatus ?? visibleJob.aggregateStatus)}
            </span>
            <span>{visibleJob.taskCount} total items</span>
            <span className="job-item-meta">
              {uploadedByLine(visibleJob.submitterName, visibleJob.createdAt)}
            </span>
          </div>
          <div className="counts-bar" role="group" aria-label="Jump to a delivery status">
            {COUNT_SEGMENTS.map((segment) => {
              const count = visibleJob.counts[segment.countKey];
              return (
                <button
                  key={segment.key}
                  type="button"
                  className={`count-segment count-${segment.key}${count === 0 ? ' count-segment--empty' : ''}`}
                  style={{ width: `${(count / visibleJob.taskCount) * 100}%` }}
                  disabled={count === 0}
                  aria-label={`Jump to the first ${segment.label} item`}
                  onClick={() => handleCountSegment(segment.status, count)}
                >
                  {count > 0 ? count : null}
                </button>
              );
            })}
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
          <colgroup>
            <col className="task-col-file" />
            <col className="task-col-destination" />
            <col className="task-col-status" />
            <col className="task-col-attempts" />
            <col className="task-col-details" />
          </colgroup>
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
            {visibleTasks.map((t) => {
              const upload = uploadForTask(t, uploads);
              return (
              <tr
                key={t.taskId}
                id={`task-${t.taskId}`}
                data-task-status={t.status}
                className={`task-row task-${t.status}${focusTaskId === t.taskId ? ' task-row--focus' : ''}`}
              >
                <td className="task-file">{t.fileName ?? t.fileId.slice(0, 8)}</td>
                <td className="task-destination">
                  {t.destination ? (
                    <Link
                      to="/"
                      state={documentsLocation(t)}
                      className="task-destination-link"
                    >
                      {t.destination}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="task-status">
                  <span className={statusClass(t.status)}>{statusLabel(t.status)}</span>
                </td>
                <td className="task-attempts">{t.attemptCount}</td>
                <td className="task-details">
                  {t.status === 'uploading' && upload ? (
                    <div className="task-upload-progress">
                      <div className="progress-bar task-progress-bar">
                        <div className="progress-fill" style={{ width: `${upload.progress}%` }} />
                      </div>
                      <span className="task-upload-progress-label">{upload.progress}%</span>
                    </div>
                  ) : t.failureReason ? (
                    <span className="failure-reason">{formatFailureReason(t.failureReason)}</span>
                  ) : null}
                </td>
              </tr>
              );
            })}
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
