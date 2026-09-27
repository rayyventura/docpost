import { apiRequest } from '../api/client';
import type { SelectedFile, JobSubmitResponse } from './types';

const CONCURRENCY = 5;

type ProgressCallback = (fileId: string, progress: number) => void;
type StatusCallback = (fileId: string, status: SelectedFile['status'], error?: string) => void;

export async function uploadFiles(
  files: SelectedFile[],
  uploadPlans: JobSubmitResponse['uploads'],
  onProgress: ProgressCallback,
  onStatus: StatusCallback,
): Promise<{ failed: number }> {
  const planByServerId = new Map(uploadPlans.map((u) => [u.fileId, u]));
  const queue = files.filter((f) => f.serverFileId && planByServerId.has(f.serverFileId));

  for (const sf of queue) {
    onStatus(sf.id, 'uploading');
    onProgress(sf.id, 0);
  }

  let index = 0;
  let failed = 0;

  async function worker(): Promise<void> {
    while (index < queue.length) {
      const sf = queue[index++];
      if (!sf?.serverFileId) continue;
      const plan = planByServerId.get(sf.serverFileId);
      if (!plan) continue;

      try {
        if (plan.multipart) {
          await uploadMultipartFile(sf, sf.serverFileId, plan.partSize ?? 16 * 1024 * 1024, (pct) =>
            onProgress(sf.id, pct),
          );
        } else if (plan.presignedUrl) {
          await uploadSingleFile(sf, plan.presignedUrl, (pct) => onProgress(sf.id, pct));
        } else {
          throw new Error('Missing upload plan');
        }
        onStatus(sf.id, 'uploaded');
      } catch (err) {
        failed += 1;
        onStatus(sf.id, 'error', err instanceof Error ? err.message : 'Upload failed');
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(queue.length, 1)) }, () => worker());
  await Promise.all(workers);
  return { failed };
}

async function uploadSingleFile(
  sf: SelectedFile,
  presignedUrl: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });

    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    xhr.open('PUT', presignedUrl);
    xhr.setRequestHeader('Content-Type', sf.file.type);
    xhr.send(sf.file);
  });
}

async function uploadMultipartFile(
  sf: SelectedFile,
  serverFileId: string,
  partSize: number,
  onProgress: (pct: number) => void,
): Promise<void> {
  const initiated = await apiRequest<{
    uploadId: string;
    parts: { partNumber: number; url: string }[];
    completeUrl: string;
  }>(`/files/${serverFileId}/multipart`, { method: 'POST' });

  const completed: { partNumber: number; etag: string }[] = [];
  const total = sf.file.size;

  for (const part of initiated.parts) {
    const start = (part.partNumber - 1) * partSize;
    const end = Math.min(start + partSize, total);
    const etag = await putBlob(part.url, sf.file.slice(start, end), (loaded) => {
      onProgress(Math.round(((start + loaded) / total) * 100));
    });
    completed.push({ partNumber: part.partNumber, etag });
    onProgress(Math.round((end / total) * 100));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${completed
    .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`)
    .join('')}</CompleteMultipartUpload>`;

  const response = await fetch(initiated.completeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: xml,
  });
  if (!response.ok) {
    throw new Error(`Failed to finish upload: ${response.status}`);
  }
}

function putBlob(url: string, body: Blob, onProgress: (loaded: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) {
          reject(new Error('Upload did not return an ETag'));
          return;
        }
        resolve(etag);
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('Network error')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));
    xhr.open('PUT', url);
    xhr.send(body);
  });
}
