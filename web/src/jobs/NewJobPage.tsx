import { useState, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { FilePicker } from './FilePicker';
import { DestinationTree } from './DestinationTree';
import { uploadFiles } from './uploadQueue';
import type { SelectedFile, Destination, JobSubmitResponse } from './types';

interface NewJobPageProps {
  onJobCreated: (jobId: string) => void;
}

export function NewJobPage({ onJobCreated }: NewJobPageProps) {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const handleFilesAdded = useCallback((newFiles: SelectedFile[]) => {
    if (newFiles.length > 0) {
      setFiles((prev) => [...prev, ...newFiles]);
    } else {
      setFiles((prev) => [...prev]);
    }
  }, []);

  const handleFileRemoved = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const readyFiles = files.filter((f) => f.status === 'ready');
  const missingFiles = readyFiles.length === 0;
  const missingDestinations = destinations.length === 0;
  const canSubmit = !missingFiles && !missingDestinations && !submitting;
  const disabledReason = submitting
    ? undefined
    : missingFiles && missingDestinations
      ? 'Add at least one file and choose at least one destination'
      : missingFiles
        ? 'Add at least one file'
        : missingDestinations
          ? 'Choose at least one destination'
          : undefined;

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);

    try {
      const filePayload = readyFiles.map((f) => ({
        name: f.file.name,
        sizeBytes: f.file.size,
        contentType: f.file.type,
        sha256: f.sha256,
      }));

      const mappingPayload = readyFiles.map((_, i) => ({
        fileIndex: i,
        destinations: destinations.map((d) => ({
          teamId: d.teamId,
          binderId: d.binderId ?? null,
          folderId: d.folderId ?? null,
        })),
      }));

      const response = await apiRequest<JobSubmitResponse>('/jobs', {
        method: 'POST',
        body: JSON.stringify({ files: filePayload, mappings: mappingPayload }),
      });

      const updatedFiles = [...files];
      readyFiles.forEach((sf, i) => {
        const idx = updatedFiles.findIndex((f) => f.id === sf.id);
        if (idx >= 0 && response.uploads[i]) {
          updatedFiles[idx] = {
            ...updatedFiles[idx],
            serverFileId: response.uploads[i].fileId,
            presignedUrl: response.uploads[i].presignedUrl,
          };
        }
      });
      const filesToUpload = updatedFiles.filter((f) => f.serverFileId);
      void uploadFiles(filesToUpload, response.uploads, () => {}, () => {});

      setFiles([]);
      setDestinations([]);
      setError(null);
      setSubmitting(false);
      setFormKey((key) => key + 1);
      onJobCreated(response.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
      setSubmitting(false);
    }
  }, [readyFiles, destinations, files, onJobCreated]);

  return (
    <div className="new-job-page">
      <div className="distribute-panels">
        <div className="panel-left">
          <DestinationTree key={formKey} selected={destinations} onChange={setDestinations} />
        </div>
        <div className="panel-right">
          <div className="panel-right-header">Files</div>
          <FilePicker
            files={files}
            onFilesAdded={handleFilesAdded}
            onFileRemoved={handleFileRemoved}
            disabled={submitting}
          />
        </div>
      </div>

      {destinations.length > 0 && (
        <div className="selection-summary">
          <div className="summary-destinations">
            {destinations.map((d, i) => (
              <span key={i} className="dest-chip">
                {d.binderName ? `${d.teamName} / ${d.binderName}` : d.teamName}
                {d.folderName && ` / ${d.folderName}`}
                <button
                  className="chip-remove"
                  onClick={() =>
                    setDestinations(destinations.filter((_, j) => j !== i))
                  }
                >
                  &times;
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="job-actions">
        <span className="send-button-wrap" title={disabledReason}>
          <button className="btn btn-primary btn-lg" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? 'Sending...' : 'Send'}
          </button>
          {disabledReason && <span className="send-tooltip" role="tooltip">{disabledReason}</span>}
        </span>
      </div>
    </div>
  );
}
