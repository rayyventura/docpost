import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface Folder {
  id: string;
  name: string;
}

interface Document {
  id: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
}

interface ContentsResponse {
  folders: Folder[];
  documents: Document[];
}

interface FolderContentsProps {
  id: string;
  type: 'binder' | 'folder';
  onSelectFolder: (folderId: string, folderName: string) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function contentTypeIcon(contentType: string): string {
  if (contentType.startsWith('image/')) return '\uD83D\uDDBC\uFE0F';
  if (contentType.includes('pdf')) return '\uD83D\uDCC4';
  if (contentType.includes('spreadsheet') || contentType.includes('excel')) return '\uD83D\uDCCA';
  if (contentType.includes('presentation') || contentType.includes('powerpoint')) return '\uD83D\uDCCA';
  if (contentType.includes('word') || contentType.includes('document')) return '\uD83D\uDCC3';
  return '\uD83D\uDCC4';
}

export function FolderContents({ id, type, onSelectFolder }: FolderContentsProps) {
  const [contents, setContents] = useState<ContentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function fetchContents() {
      const path = type === 'binder'
        ? `/destinations/binders/${id}/contents`
        : `/destinations/folders/${id}/contents`;

      try {
        const data = await apiRequest<ContentsResponse>(path);
        if (!cancelled) {
          setContents(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load contents');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchContents();
    return () => { cancelled = true; };
  }, [id, type]);

  if (loading) {
    return <div className="loading-spinner" aria-label="Loading contents" />;
  }

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (!contents) {
    return null;
  }

  const isEmpty = contents.folders.length === 0 && contents.documents.length === 0;

  if (isEmpty) {
    return <p className="empty-state">This location is empty.</p>;
  }

  return (
    <div className="folder-contents">
      {contents.folders.length > 0 && (
        <section>
          <h3 className="section-heading">Folders</h3>
          <ul className="item-list">
            {contents.folders.map((folder) => (
              <li key={folder.id}>
                <button
                  className="item-card"
                  onClick={() => onSelectFolder(folder.id, folder.name)}
                >
                  <span className="item-icon" aria-hidden="true">&#x1F4C1;</span>
                  <div className="item-info">
                    <span className="item-name">{folder.name}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {contents.documents.length > 0 && (
        <section>
          <h3 className="section-heading">Documents</h3>
          <ul className="item-list">
            {contents.documents.map((doc) => (
              <li key={doc.id}>
                <div className="item-card item-card--static">
                  <span className="item-icon" aria-hidden="true">
                    {contentTypeIcon(doc.contentType)}
                  </span>
                  <div className="item-info">
                    <span className="item-name">{doc.name}</span>
                    <span className="item-meta">
                      {formatFileSize(doc.sizeBytes)} &middot; {doc.contentType} &middot; {formatDate(doc.createdAt)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
