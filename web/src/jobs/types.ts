export interface Destination {
  teamId: string;
  teamName: string;
  binderId?: string;
  binderName?: string;
  folderId?: string;
  folderName?: string;
}

export interface SelectedFile {
  id: string; // client-side UUID before server assigns one
  file: File;
  sha256: string;
  status: 'hashing' | 'ready' | 'uploading' | 'uploaded' | 'error';
  progress: number; // 0-100
  error?: string;
  serverFileId?: string; // assigned after POST /jobs
  presignedUrl?: string;
}

export interface Mapping {
  fileId: string; // client-side UUID
  destinations: Destination[];
}

export interface JobSubmitResponse {
  jobId: string;
  taskCount: number;
  uploads: Array<{
    fileId: string;
    presignedUrl?: string;
    fields?: { key: string; contentType: string; checksumSha256: string };
    multipart?: boolean;
    partSize?: number;
    partCount?: number;
  }>;
}

export interface JobSummary {
  jobId: string;
  createdAt: string;
  taskCount: number;
  completedAt: string | null;
  submitterName: string;
  counts: {
    pending: number;
    in_progress: number;
    completed: number;
    failed: number;
  };
  aggregateStatus: string;
}

export interface TaskDetail {
  taskId: string;
  fileId: string;
  fileName: string | null;
  teamId: string;
  binderId: string;
  folderId: string | null;
  destination: string | null;
  status: string;
  attemptCount: number;
  failureReason: string | null;
  platformDocumentId: string | null;
}
