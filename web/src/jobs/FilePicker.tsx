import { useCallback, useEffect, useRef, useState } from 'react';
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
const TYPE_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
const ALLOWED_EXTENSIONS = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg';
const MAX_SIZE = 1_073_741_824; // 1 GB

export function fileContentType(file: File): string {
  if (ALLOWED_TYPES.includes(file.type)) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXT[ext] ?? '';
}

function isFileDrag(event: { dataTransfer?: DataTransfer | null }): boolean {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  const types = transfer.types;
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    if (type === 'Files' || type === 'application/x-moz-file') return true;
  }
  if (transfer.items) {
    for (let i = 0; i < transfer.items.length; i++) {
      if (transfer.items[i].kind === 'file') return true;
    }
  }
  return types.length === 0;
}

interface FilePickerProps {
  files: SelectedFile[];
  onFilesAdded: (files: SelectedFile[]) => void;
  onFileRemoved: (id: string) => void;
  disabled?: boolean;
  pageDrop?: boolean;
}

export function FilePicker({ files, onFilesAdded, onFileRemoved, disabled, pageDrop }: FilePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    async (fileList: FileList) => {
      const remaining = MAX_FILES - files.length;
      const selected = Array.from(fileList).slice(0, remaining);

      const newFiles: SelectedFile[] = selected
        .filter((f) => {
          if (!fileContentType(f)) return false;
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
          sf.error = 'Failed to process file';
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
      e.stopPropagation();
      setDragOver(false);
      if (disabled) return;
      if (e.dataTransfer.files.length > 0) {
        void handleFiles(e.dataTransfer.files);
      }
    },
    [disabled, handleFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setDragOver(true);
  }, [disabled]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  }, []);

  useEffect(() => {
    if (!pageDrop || disabled) return;

    const onDragOver = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget) return;
      setDragOver(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      setDragOver(false);
      if (event.dataTransfer?.files.length) {
        void handleFiles(event.dataTransfer.files);
      }
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [pageDrop, disabled, handleFiles]);

  return (
    <div className={`file-picker${dragOver ? ' file-picker--receiving' : ''}`}>
      <div
        className={`drop-zone${dragOver ? ' drop-zone--active' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
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
        <p>{dragOver ? 'Drop to add' : 'Drop files here or click to browse'}</p>
        <p className="drop-zone-hint">
          PDF, DOCX, XLSX, PNG, JPG. Up to 1 GB each. {MAX_FILES - files.length} remaining
        </p>
      </div>

      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.id} className={`file-item file-${f.status}`}>
              <div className="file-item-main">
                <span className="file-name">{f.file.name}</span>
                {f.status === 'uploading' && (
                  <span className="file-upload-badge" aria-live="polite">
                    <span className="file-upload-dot" aria-hidden="true" />
                    Uploading {f.progress}%
                  </span>
                )}
                {f.status === 'uploaded' && (
                  <span className="file-upload-badge file-upload-badge--done">Uploaded</span>
                )}
              </div>
              <span className="file-size">{formatSize(f.file.size)}</span>
              {f.status === 'hashing' && <span className="file-status">Preparing...</span>}
              {f.status === 'ready' && <span className="file-status">Ready</span>}
              {f.status === 'error' && <span className="file-status">{f.error ?? 'Error'}</span>}
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
