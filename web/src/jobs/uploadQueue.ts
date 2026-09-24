import type { SelectedFile, JobSubmitResponse } from './types';

const CONCURRENCY = 5;

type ProgressCallback = (fileId: string, progress: number) => void;
type StatusCallback = (fileId: string, status: SelectedFile['status'], error?: string) => void;

export async function uploadFiles(
  files: SelectedFile[],
  uploadPlans: JobSubmitResponse['uploads'],
  onProgress: ProgressCallback,
  onStatus: StatusCallback,
): Promise<void> {
  // Map client file IDs to server upload plans
  const planByServerId = new Map(uploadPlans.map((u) => [u.fileId, u]));

  // Build work queue
  const queue = files
    .filter((f) => f.serverFileId && !planByServerId.get(f.serverFileId)?.multipart)
    .map((f) => ({ file: f, plan: planByServerId.get(f.serverFileId!)! }));

  let index = 0;

  async function worker(): Promise<void> {
    while (index < queue.length) {
      const item = queue[index++];
      if (!item) break;

      const { file: sf, plan } = item;
      if (!plan.presignedUrl) continue;

      onStatus(sf.id, 'uploading');

      try {
        await uploadSingleFile(sf, plan.presignedUrl, (pct) => onProgress(sf.id, pct));
        onStatus(sf.id, 'uploaded');
      } catch (err) {
        onStatus(sf.id, 'error', err instanceof Error ? err.message : 'Upload failed');
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker());
  await Promise.all(workers);
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
