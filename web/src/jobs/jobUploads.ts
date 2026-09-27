import { useSyncExternalStore } from 'react';
import { uploadFiles } from './uploadQueue';
import type { JobSubmitResponse, SelectedFile } from './types';

export type JobUploadFile = {
  serverFileId: string;
  fileName: string;
  status: 'uploading' | 'uploaded' | 'error';
  progress: number;
  error?: string;
};

const EMPTY: Record<string, JobUploadFile> = {};
const sessions = new Map<string, Record<string, JobUploadFile>>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

export function getJobUploads(jobId: string | null | undefined): Record<string, JobUploadFile> {
  if (!jobId) return EMPTY;
  return sessions.get(jobId) ?? EMPTY;
}

export function startJobUploads(
  jobId: string,
  files: SelectedFile[],
  plans: JobSubmitResponse['uploads'],
): void {
  const next: Record<string, JobUploadFile> = {};
  for (const file of files) {
    if (!file.serverFileId) continue;
    next[file.serverFileId] = {
      serverFileId: file.serverFileId,
      fileName: file.file.name,
      status: 'uploading',
      progress: 0,
    };
  }
  sessions.set(jobId, next);
  emit();

  void uploadFiles(
    files,
    plans,
    (clientId, progress) => {
      const file = files.find((item) => item.id === clientId);
      if (!file?.serverFileId) return;
      const current = sessions.get(jobId);
      const existing = current?.[file.serverFileId];
      if (!existing) return;
      sessions.set(jobId, {
        ...current,
        [file.serverFileId]: { ...existing, progress },
      });
      emit();
    },
    (clientId, status, error) => {
      const file = files.find((item) => item.id === clientId);
      if (!file?.serverFileId) return;
      const current = sessions.get(jobId);
      const existing = current?.[file.serverFileId];
      if (!existing) return;
      sessions.set(jobId, {
        ...current,
        [file.serverFileId]: {
          ...existing,
          status: status === 'error' ? 'error' : status === 'uploaded' ? 'uploaded' : 'uploading',
          progress: status === 'uploaded' ? 100 : existing.progress,
          error,
        },
      });
      emit();
    },
  );
}

export function useJobUploads(jobId: string | null | undefined): Record<string, JobUploadFile> {
  return useSyncExternalStore(
    subscribe,
    () => getJobUploads(jobId),
    () => EMPTY,
  );
}

export function uploadForTask(
  task: { fileId: string; fileName: string | null },
  uploads: Record<string, JobUploadFile>,
): JobUploadFile | undefined {
  if (task.fileId && uploads[task.fileId]) return uploads[task.fileId];
  if (!task.fileName) return undefined;
  return Object.values(uploads).find((upload) => upload.fileName === task.fileName);
}
