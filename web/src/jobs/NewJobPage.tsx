import { useState, useCallback } from 'react';
import { apiRequest } from '../api/client';
import { FilePicker } from './FilePicker';
import { DestinationPicker } from './DestinationPicker';
import { MappingMatrix } from './MappingMatrix';
import { uploadFiles } from './uploadQueue';
import type { SelectedFile, Destination, Mapping, JobSubmitResponse } from './types';

interface NewJobPageProps {
  onJobCreated: (jobId: string) => void;
}

export function NewJobPage({ onJobCreated }: NewJobPageProps) {
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFilesAdded = useCallback((newFiles: SelectedFile[]) => {
    if (newFiles.length > 0) {
      setFiles((prev) => [...prev, ...newFiles]);
    } else {
      // Trigger re-render for hash completion
      setFiles((prev) => [...prev]);
    }
  }, []);

  const handleFileRemoved = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setMappings((prev) => prev.filter((m) => m.fileId !== id));
  }, []);

  const handleAddDestination = useCallback((dest: Destination) => {
    setDestinations((prev) => [...prev, dest]);
  }, []);

  const handleRemoveDestination = useCallback(
    (index: number) => {
      const removed = destinations[index];
      setDestinations((prev) => prev.filter((_, i) => i !== index));
      // Remove from mappings
      setMappings((prev) =>
        prev
          .map((m) => ({
            ...m,
            destinations: m.destinations.filter(
              (d) =>
                !(
                  d.teamId === removed.teamId &&
                  d.binderId === removed.binderId &&
                  (d.folderId ?? null) === (removed.folderId ?? null)
                ),
            ),
          }))
          .filter((m) => m.destinations.length > 0),
      );
    },
    [destinations],
  );

  const readyFiles = files.filter((f) => f.status === 'ready');
  const taskCount = mappings.reduce((sum, m) => sum + m.destinations.length, 0);
  const canSubmit = readyFiles.length > 0 && taskCount > 0 && !submitting;

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    setError(null);

    try {
      // Build request body using fileIndex (not fileId)
      const filePayload = readyFiles.map((f) => ({
        name: f.file.name,
        sizeBytes: f.file.size,
        contentType: f.file.type,
        sha256: f.sha256,
      }));

      const mappingPayload = mappings
        .filter((m) => readyFiles.some((f) => f.id === m.fileId))
        .map((m) => ({
          fileIndex: readyFiles.findIndex((f) => f.id === m.fileId),
          destinations: m.destinations.map((d) => ({
            teamId: d.teamId,
            binderId: d.binderId,
            folderId: d.folderId ?? null,
          })),
        }))
        .filter((m) => m.fileIndex >= 0);

      const response = await apiRequest<JobSubmitResponse>('/jobs', {
        method: 'POST',
        body: JSON.stringify({ files: filePayload, mappings: mappingPayload }),
      });

      // Map server file IDs back to client files (uploads array is same order as files)
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
      setFiles(updatedFiles);

      // Start uploads in background, then navigate to dashboard
      onJobCreated(response.jobId);

      // Upload files using presigned URLs
      uploadFiles(
        updatedFiles.filter((f) => f.serverFileId),
        response.uploads,
        (fileId, progress) => {
          setFiles((prev) =>
            prev.map((f) => (f.id === fileId ? { ...f, progress } : f)),
          );
        },
        (fileId, status, uploadError) => {
          setFiles((prev) =>
            prev.map((f) => (f.id === fileId ? { ...f, status, error: uploadError } : f)),
          );
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
      setSubmitting(false);
    }
  }, [readyFiles, mappings, files, onJobCreated]);

  return (
    <div className="new-job-page">
      <h2>New Distribution</h2>

      <section className="job-section">
        <h3>1. Select Files</h3>
        <FilePicker
          files={files}
          onFilesAdded={handleFilesAdded}
          onFileRemoved={handleFileRemoved}
          disabled={submitting}
        />
      </section>

      <section className="job-section">
        <h3>2. Choose Destinations</h3>
        <DestinationPicker
          selected={destinations}
          onAdd={handleAddDestination}
          onRemove={handleRemoveDestination}
        />
      </section>

      <section className="job-section">
        <h3>3. Map Files to Destinations</h3>
        <MappingMatrix
          files={files}
          destinations={destinations}
          mappings={mappings}
          onMappingsChange={setMappings}
        />
      </section>

      {error && <div className="error-banner">{error}</div>}

      <div className="job-actions">
        <button className="btn btn-primary btn-lg" disabled={!canSubmit} onClick={handleSubmit}>
          {submitting ? 'Submitting...' : `Send (${taskCount} tasks)`}
        </button>
      </div>
    </div>
  );
}
