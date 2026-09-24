import { useCallback, useRef } from 'react';
import type { SelectedFile } from './types';
import { computeSha256 } from './useFileHash';

const MAX_FILES = 100;
const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
];
const ALLOWED_EXTENSIONS = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg';
const MAX_SIZE = 1_073_741_824; // 1 GB

interface FilePickerProps {
  files: SelectedFile[];
  onFilesAdded: (files: SelectedFile[]) => void;
  onFileRemoved: (id: string) => void;
  disabled?: boolean;
}

export function FilePicker({ files, onFilesAdded, onFileRemoved, disabled }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const remaining = MAX_FILES - files.length;
      const selected = Array.from(fileList).slice(0, remaining);

      const newFiles: SelectedFile[] = selected
        .filter((f) => {
          if (!ALLOWED_TYPES.includes(f.type)) return false;
          if (f.size > MAX_SIZE || f.size === 0) return false;
          return true;
        })
        .map((f) => ({
          id: crypto.randomUUID(),
          file: f,
          sha256: '',
          status: 'hashing' as const,
          progress: 0,
        }));

      if (newFiles.length === 0) return;
      onFilesAdded(newFiles);

      // Compute hashes in background
      for (const sf of newFiles) {
        try {
          const hash = await computeSha256(sf.file);
          sf.sha256 = hash;
          sf.status = 'ready';
        } catch {
          sf.status = 'error';
          sf.error = 'Failed to compute checksum';
        }
      }
      // Trigger re-render with updated hashes
      onFilesAdded([]);
    },
    [files.length, onFilesAdded],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) {
        handleFiles(e.target.files);
        e.target.value = '';
      }
    },
    [handleFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer.files) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  return (
    <div className="file-picker">
      <div
        className="drop-zone"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => !disabled && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ALLOWED_EXTENSIONS}
          onChange={handleChange}
          hidden
          disabled={disabled}
        />
        <p>Drop files here or click to browse</p>
        <p className="drop-zone-hint">
          PDF, DOCX, XLSX, PNG, JPG — up to 1 GB each — {MAX_FILES - files.length} remaining
        </p>
      </div>

      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.id} className={`file-item file-${f.status}`}>
              <span className="file-name">{f.file.name}</span>
              <span className="file-size">{formatSize(f.file.size)}</span>
              <span className="file-status">
                {f.status === 'hashing' && 'Computing checksum...'}
                {f.status === 'ready' && 'Ready'}
                {f.status === 'uploading' && `${f.progress}%`}
                {f.status === 'uploaded' && 'Uploaded'}
                {f.status === 'error' && (f.error ?? 'Error')}
              </span>
              {(f.status === 'ready' || f.status === 'error') && !disabled && (
                <button
                  className="btn btn-sm btn-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    onFileRemoved(f.id);
                  }}
                >
                  Remove
                </button>
              )}
              {f.status === 'uploading' && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${f.progress}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
