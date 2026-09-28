import { useState, useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiRequest } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { FilePicker, fileContentType } from './FilePicker';
import { DestinationTree } from './DestinationTree';
import { startJobUploads } from './jobUploads';
import type { SelectedFile, Destination, JobSubmitResponse, SendLocationState } from './types';

function destKey(d: { teamId: string; binderId?: string | null; folderId?: string | null }): string {
  return `${d.teamId}:${d.binderId ?? ''}:${d.folderId ?? ''}`;
}

function destinationLabel(destination: Destination): string {
  return [destination.teamName, destination.binderName, destination.folderName]
    .filter(Boolean)
    .join(' / ');
}

export function NewJobPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [revealFolderPath, setRevealFolderPath] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    const seed = location.state as SendLocationState | null;
    if (!seed?.destination?.binderId || !seed.destination.folderId) return;

    setDestinations((current) => {
      if (current.some((destination) => destKey(destination) === destKey(seed.destination))) {
        return current;
      }
      return [...current, seed.destination];
    });
    setRevealFolderPath(seed.folderPath ?? []);
  }, [location.key, location.state]);

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
  const preparingFiles = files.some((f) => f.status === 'hashing');
  const missingFiles = readyFiles.length === 0;
  const missingDestinations = destinations.length === 0;
  const canSubmit = !missingFiles && !missingDestinations && !submitting && !fileError && !error && !preparingFiles;
  const disabledReason = submitting
    ? undefined
    : fileError || error
      ? 'Dismiss the error or add a file that can be sent'
      : preparingFiles
        ? 'Files are being prepared, please wait'
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
        contentType: fileContentType(f.file),
        sha256: f.sha256,
      }));

      const mappingPayload = readyFiles.map((_, i) => ({
        fileIndex: i,
        destinations: destinations
          .filter((d) => d.binderId && d.folderId)
          .map((d) => ({
            teamId: d.teamId,
            binderId: d.binderId,
            folderId: d.folderId,
          })),
      }));

      const response = await apiRequest<JobSubmitResponse>('/jobs', {
        method: 'POST',
        body: JSON.stringify({ files: filePayload, mappings: mappingPayload }),
      });

      const updatedFiles = files.map((file) => {
        const uploadIndex = readyFiles.findIndex((ready) => ready.id === file.id);
        if (uploadIndex < 0 || !response.uploads[uploadIndex]) return file;
        return {
          ...file,
          serverFileId: response.uploads[uploadIndex].fileId,
          presignedUrl: response.uploads[uploadIndex].presignedUrl,
          status: 'uploading' as const,
          progress: 0,
        };
      });
      const filesToUpload = updatedFiles.filter((file) => file.serverFileId);
      startJobUploads(response.jobId, filesToUpload, response.uploads);

      setFiles([]);
      setDestinations([]);
      setError(null);
      setFileError(null);
      setSubmitting(false);
      setFormKey((key) => key + 1);
      void navigate(`/deliveries/${response.jobId}`, {
        state: {
          jobId: response.jobId,
          taskCount: response.taskCount,
          createdAt: new Date().toISOString(),
          submitterName: user?.name ?? '',
          tasks: readyFiles.flatMap((file, fileIndex) =>
            destinations
              .filter((destination) => destination.binderId && destination.folderId)
              .map((destination) => ({
                fileId: response.uploads[fileIndex]?.fileId ?? '',
                fileName: file.file.name,
                teamId: destination.teamId,
                binderId: destination.binderId,
                folderId: destination.folderId ?? null,
                destination: destinationLabel(destination),
                teamName: destination.teamName,
                binderName: destination.binderName,
                folderPath:
                  destination.folderId && destination.folderName
                    ? [{ id: destination.folderId, name: destination.folderName }]
                    : [],
              })),
          ),
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
      setSubmitting(false);
    }
  }, [readyFiles, destinations, files, navigate, user?.name]);

  return (
    <div className="new-job-page">
      <p className="page-lead">
        Choose where each document should be placed in the destination hierarchy.
        <br />
        Authorized users will be able to download it from Documents.
      </p>
      <div className="distribute-panels">
        <div className={`panel-left ${submitting ? 'panel-left--locked' : ''}`}>
          <DestinationTree
            key={formKey}
            selected={destinations}
            onChange={setDestinations}
            revealFolderPath={revealFolderPath}
          />
        </div>
        <div className="panel-right">
          <div className="panel-right-header">To send</div>
          <FilePicker
            files={files}
            onFilesAdded={handleFilesAdded}
            onFileRemoved={handleFileRemoved}
            onErrorChange={setFileError}
            disabled={submitting}
            pageDrop={location.pathname === '/send'}
          />
        </div>
      </div>

      {destinations.length > 0 && (
        <div className="selection-summary">
          <div className="summary-destinations">
            {destinations.map((d, i) => (
              <span key={i} className="dest-chip">
                {`${d.teamName} / ${d.binderName}`}
                {d.folderName && ` / ${d.folderName}`}
                {!submitting && (
                  <button
                    className="chip-remove"
                    onClick={() =>
                      setDestinations(destinations.filter((_, j) => j !== i))
                    }
                  >
                    &times;
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="error-banner error-banner--dismissible" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="error-banner-dismiss"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

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
