import { useCallback, useEffect, useState } from 'react';
import type { SelectedFile } from './types';
import { computeSha256 } from './useFileHash';
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILES,
  createFileId,
  fileContentType,
  planFileSelection,
} from './fileSelection';

function captureFile(file: File): File {
  const type = fileContentType(file) || file.type;
  return new File([file], file.name, { type, lastModified: file.lastModified });
}

function filesFromTransfer(transfer: DataTransfer): File[] {
  const captured = new Map<string, File>();
  const add = (file: File | null) => {
    if (!file) return;
    const kept = captureFile(file);
    captured.set(`${kept.name}:${kept.size}:${kept.lastModified}`, kept);
  };

  for (const file of Array.from(transfer.files)) {
    add(file);
  }
  for (let i = 0; i < transfer.items.length; i++) {
    const item = transfer.items[i];
    if (item.kind === 'file') add(item.getAsFile());
  }
  return [...captured.values()];
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
  onFileUpdated: (id: string, patch: Partial<Omit<SelectedFile, 'id' | 'file'>>) => void;
  onFileRemoved: (id: string) => void;
  onErrorChange?: (error: string | null) => void;
  disabled?: boolean;
  pageDrop?: boolean;
}

export function FilePicker({
  files,
  onFilesAdded,
  onFileUpdated,
  onFileRemoved,
  onErrorChange,
  disabled,
  pageDrop,
}: FilePickerProps) {
  const [dragOver, setDragOver] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  const showError = useCallback((message: string | null) => {
    setPickError(message);
    onErrorChange?.(message);
  }, [onErrorChange]);

  const handleFiles = useCallback(
    async (incoming: File[]) => {
      const { accepted, error } = planFileSelection(incoming, files.length);
      showError(error);
      if (accepted.length === 0) return;

      const newFiles: SelectedFile[] = accepted.map((f) => ({
        id: createFileId(),
        file: f,
        sha256: '',
        status: 'hashing' as const,
        progress: 0,
      }));
      onFilesAdded(newFiles);

      // Hash one file at a time, updating each as soon as it is done.
      for (const sf of newFiles) {
        try {
          const sha256 = await computeSha256(sf.file);
          onFileUpdated(sf.id, { sha256, status: 'ready' });
        } catch {
          onFileUpdated(sf.id, {
            status: 'error',
            error: 'This file could not be read. Try choosing it again.',
          });
        }
      }
    },
    [files.length, onFilesAdded, onFileUpdated, showError],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const picked = e.target.files ? Array.from(e.target.files).map(captureFile) : [];
      // Reset so picking the same file again still fires a change event.
      e.target.value = '';
      if (picked.length > 0) {
        void handleFiles(picked);
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
      const dropped = filesFromTransfer(e.dataTransfer);
      if (dropped.length > 0) {
        void handleFiles(dropped);
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
      const dropped = event.dataTransfer ? filesFromTransfer(event.dataTransfer) : [];
      if (dropped.length > 0) {
        void handleFiles(dropped);
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
      {/*
        A <label> wrapping a visually hidden (not display:none) input opens the
        native picker on tap without any scripted .click(), which iOS Safari
        and Android Chrome both honour; it is also keyboard focusable.
      */}
      <label
        className={`drop-zone${dragOver ? ' drop-zone--active' : ''}${disabled ? ' drop-zone--disabled' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          className="drop-zone-input"
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          onChange={handleChange}
          disabled={disabled}
        />
        <span className="drop-zone-title">
          {dragOver ? (
            'Drop to add'
          ) : (
            <>
              <span className="drop-zone-copy--pointer">Drop files here or click to browse</span>
              <span className="drop-zone-copy--touch">Tap to choose files</span>
            </>
          )}
        </span>
        <span className="drop-zone-hint">
          PDF, DOCX, XLSX, PNG, JPG. Up to 1 GB each. {MAX_FILES - files.length} remaining
        </span>
      </label>
      {pickError && (
        <div className="error-banner error-banner--dismissible" role="alert">
          <span>{pickError}</span>
          <button
            type="button"
            className="error-banner-dismiss"
            onClick={() => showError(null)}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

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
