import { useState, useEffect, useCallback, useRef } from 'react';
import { apiDownload, apiRequest } from '../api/client';
import { ContentReveal } from '../ContentReveal';
import { PageLoading } from '../PageLoading';
import { formatDate } from '../formatDate';
import type { Destination, FilesLocationState, SendLocationState } from '../jobs/types';
import { BinderIcon } from './BinderIcon';
import { TeamIcon } from './TeamIcon';

interface Team {
  id: string;
  name: string;
}

interface Binder {
  id: string;
  name: string;
  teamId: string;
  teamName: string;
}

interface FolderNode {
  id: string;
  name: string;
  binderId: string;
  binderName: string;
  teamId: string;
  teamName: string;
  parentId: string | null;
}

interface DocumentNode {
  id: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string;
}

interface NodeContents {
  folders: FolderNode[];
  documents: DocumentNode[];
}

interface DocumentsTreeProps {
  reveal?: FilesLocationState | null;
  onSendHere: (target: SendLocationState) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const size = bytes / Math.pow(k, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fileKind(contentType: string): string {
  if (contentType.includes('pdf')) return 'PDF';
  if (contentType.includes('word') || contentType.includes('wordprocessingml')) return 'Word';
  if (contentType.includes('spreadsheet') || contentType.includes('excel')) return 'Excel';
  if (contentType === 'image/png') return 'PNG';
  if (contentType === 'image/jpeg') return 'JPEG';
  return 'File';
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="folder-icon">
      <path
        d="M3.5 7.25A1.75 1.75 0 0 1 5.25 5.5h4.1c.4 0 .78.17 1.05.46l1.1 1.18c.27.29.65.46 1.05.46h6.2A1.75 1.75 0 0 1 20.5 9.35v8.4A1.75 1.75 0 0 1 18.75 19.5H5.25A1.75 1.75 0 0 1 3.5 17.75Z"
        fill="currentColor"
        opacity="0.14"
      />
      <path
        d="M3.5 7.25A1.75 1.75 0 0 1 5.25 5.5h4.1c.4 0 .78.17 1.05.46l1.1 1.18c.27.29.65.46 1.05.46h6.2A1.75 1.75 0 0 1 20.5 9.35v8.4A1.75 1.75 0 0 1 18.75 19.5H5.25A1.75 1.75 0 0 1 3.5 17.75Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="file-icon">
      <path d="M7 3.75h6.2L18.5 9v11.25A1.75 1.75 0 0 1 16.75 22H7.25A1.75 1.75 0 0 1 5.5 20.25V5.5A1.75 1.75 0 0 1 7.25 3.75Z" fill="currentColor" opacity="0.12" />
      <path d="M13 3.75V8.5h5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3.75h6.2L18.5 9v11.25A1.75 1.75 0 0 1 16.75 22H7.25A1.75 1.75 0 0 1 5.5 20.25V5.5A1.75 1.75 0 0 1 7.25 3.75Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Expander({
  loading,
  expandable,
  expanded,
  onClick,
}: {
  loading: boolean;
  expandable: boolean;
  expanded: boolean;
  onClick: () => void;
}) {
  if (!loading && !expandable) {
    return <span className="tree-arrow-gap" aria-hidden="true" />;
  }

  return (
    <button
      type="button"
      className="tree-arrow"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={expanded ? 'Collapse' : 'Expand'}
    >
      {loading ? <span className="tree-spinner" /> : expanded ? '▾' : '▸'}
    </button>
  );
}

function sendTargetFor(
  folder: FolderNode,
  folderPath: string[],
): SendLocationState {
  const destination: Destination = {
    teamId: folder.teamId,
    teamName: folder.teamName,
    binderId: folder.binderId,
    binderName: folder.binderName,
    folderId: folder.id,
    folderName: folder.name,
    folderPath: folderPath.map((id) => ({
      id,
      name: id === folder.id ? folder.name : '',
    })),
  };
  return { destination, folderPath };
}

function folderSegmentId(segment: { id?: string } | string | undefined): string | undefined {
  if (!segment) return undefined;
  return typeof segment === 'string' ? segment : segment.id;
}

export function DocumentsTree({ reveal, onSendHere }: DocumentsTreeProps) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loadingTeams, setLoadingTeams] = useState(true);

  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  const [expandedBinders, setExpandedBinders] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const [bindersByTeam, setBindersByTeam] = useState<Map<string, Binder[]>>(new Map());
  const [contentsByParent, setContentsByParent] = useState<Map<string, NodeContents>>(new Map());
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [focusDocumentId, setFocusDocumentId] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(Boolean(reveal?.teamId && reveal.binderId));
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState('');

  const bindersByTeamRef = useRef(bindersByTeam);
  const contentsByParentRef = useRef(contentsByParent);
  bindersByTeamRef.current = bindersByTeam;
  contentsByParentRef.current = contentsByParent;

  useEffect(() => {
    apiRequest<Team[]>('/destinations/teams')
      .then(setTeams)
      .catch(console.error)
      .finally(() => setLoadingTeams(false));
  }, []);

  const markLoading = useCallback((key: string, on: boolean) => {
    setLoadingSet((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const loadBinders = useCallback(async (team: Team): Promise<Binder[]> => {
    const cached = bindersByTeamRef.current.get(team.id);
    if (cached) return cached;

    const data = await apiRequest<{ id: string; name: string }[]>(
      `/destinations/teams/${team.id}/binders`,
    );
    const binders = data.map((binder) => ({
      id: binder.id,
      name: binder.name,
      teamId: team.id,
      teamName: team.name,
    }));
    setBindersByTeam((prev) => {
      const next = new Map(prev);
      next.set(team.id, binders);
      return next;
    });
    return binders;
  }, []);

  const loadContents = useCallback(async (
    parentKey: string,
    path: string,
    mapFolders: (folder: { id: string; name: string }) => FolderNode,
  ): Promise<NodeContents> => {
    const cached = contentsByParentRef.current.get(parentKey);
    if (cached) return cached;

    const data = await apiRequest<{ folders: { id: string; name: string }[]; documents: DocumentNode[] }>(path);
    const contents: NodeContents = {
      folders: (data.folders ?? []).map(mapFolders),
      documents: data.documents ?? [],
    };
    setContentsByParent((prev) => {
      const next = new Map(prev);
      next.set(parentKey, contents);
      return next;
    });
    return contents;
  }, []);

  const toggleTeam = useCallback(async (team: Team) => {
    if (expandedTeams.has(team.id)) {
      setExpandedTeams((prev) => {
        const next = new Set(prev);
        next.delete(team.id);
        return next;
      });
      return;
    }

    markLoading(`team:${team.id}`, true);
    try {
      await loadBinders(team);
      setExpandedTeams((prev) => new Set(prev).add(team.id));
    } catch (err) {
      console.error(err);
    }
    markLoading(`team:${team.id}`, false);
  }, [expandedTeams, loadBinders, markLoading]);

  const toggleBinder = useCallback(async (binder: Binder) => {
    if (expandedBinders.has(binder.id)) {
      setExpandedBinders((prev) => {
        const next = new Set(prev);
        next.delete(binder.id);
        return next;
      });
      return;
    }

    const parentKey = `binder:${binder.id}`;
    markLoading(parentKey, true);
    try {
      await loadContents(parentKey, `/destinations/binders/${binder.id}/contents`, (folder) => ({
        id: folder.id,
        name: folder.name,
        binderId: binder.id,
        binderName: binder.name,
        teamId: binder.teamId,
        teamName: binder.teamName,
        parentId: null,
      }));
      setExpandedBinders((prev) => new Set(prev).add(binder.id));
    } catch (err) {
      console.error(err);
    }
    markLoading(parentKey, false);
  }, [expandedBinders, loadContents, markLoading]);

  const toggleFolder = useCallback(async (folder: FolderNode) => {
    if (expandedFolders.has(folder.id)) {
      setExpandedFolders((prev) => {
        const next = new Set(prev);
        next.delete(folder.id);
        return next;
      });
      return;
    }

    const parentKey = `folder:${folder.id}`;
    markLoading(parentKey, true);
    try {
      await loadContents(parentKey, `/destinations/folders/${folder.id}/contents`, (child) => ({
        id: child.id,
        name: child.name,
        binderId: folder.binderId,
        binderName: folder.binderName,
        teamId: folder.teamId,
        teamName: folder.teamName,
        parentId: folder.id,
      }));
      setExpandedFolders((prev) => new Set(prev).add(folder.id));
    } catch (err) {
      console.error(err);
    }
    markLoading(parentKey, false);
  }, [expandedFolders, loadContents, markLoading]);

  const selectFolder = useCallback((folder: FolderNode) => {
    setActiveFolderId(folder.id);
    if (!expandedFolders.has(folder.id)) {
      void toggleFolder(folder);
    }
  }, [expandedFolders, toggleFolder]);

  useEffect(() => {
    if (!reveal?.teamId || !reveal.binderId) {
      setRevealing(false);
      return;
    }

    setRevealing(true);
    setFocusDocumentId(null);

    if (loadingTeams) return;

    let cancelled = false;

    const openPath = async () => {
      const team = teams.find((item) => item.id === reveal.teamId) ?? {
        id: reveal.teamId,
        name: reveal.teamName,
      };

      try {
        await loadBinders(team);
        if (cancelled) return;
        setExpandedTeams((prev) => new Set(prev).add(team.id));

        const binder: Binder = {
          id: reveal.binderId,
          name: reveal.binderName,
          teamId: reveal.teamId,
          teamName: reveal.teamName,
        };
        const binderKey = `binder:${binder.id}`;
        const binderContents = await loadContents(
          binderKey,
          `/destinations/binders/${binder.id}/contents`,
          (folder) => ({
            id: folder.id,
            name: folder.name,
            binderId: binder.id,
            binderName: binder.name,
            teamId: binder.teamId,
            teamName: binder.teamName,
            parentId: null,
          }),
        );
        if (cancelled) return;
        setExpandedBinders((prev) => new Set(prev).add(binder.id));

        const path = reveal.folderPath ?? [];
        let siblings = binderContents.folders;
        let selected: FolderNode | undefined;
        let currentContents = binderContents;
        let openedTarget = path.length === 0 && !reveal.folderId;

        for (const [index, segment] of path.entries()) {
          const segmentId = folderSegmentId(segment);
          if (!segmentId) break;
          const folder = siblings.find((item) => item.id === segmentId);
          if (!folder) break;
          selected = folder;
          const isLast = index === path.length - 1;
          const childKey = `folder:${folder.id}`;
          const childContents = await loadContents(
            childKey,
            `/destinations/folders/${folder.id}/contents`,
            (child) => ({
              id: child.id,
              name: child.name,
              binderId: folder.binderId,
              binderName: folder.binderName,
              teamId: folder.teamId,
              teamName: folder.teamName,
              parentId: folder.id,
            }),
          );
          if (cancelled) return;
          setExpandedFolders((prev) => new Set(prev).add(folder.id));
          siblings = childContents.folders;
          currentContents = childContents;
          if (isLast) {
            openedTarget = true;
            break;
          }
        }

        const leafId = folderSegmentId(path[path.length - 1]) ?? reveal.folderId;
        if (!openedTarget && leafId) {
          const childKey = `folder:${leafId}`;
          currentContents = await loadContents(
            childKey,
            `/destinations/folders/${leafId}/contents`,
            (child) => ({
              id: child.id,
              name: child.name,
              binderId: binder.id,
              binderName: binder.name,
              teamId: binder.teamId,
              teamName: binder.teamName,
              parentId: leafId,
            }),
          );
          if (cancelled) return;
          setExpandedFolders((prev) => new Set(prev).add(leafId));
          setActiveFolderId(leafId);
          openedTarget = true;
        } else if (selected) {
          setActiveFolderId(selected.id);
        }

        const match = currentContents.documents.find((doc) => {
          if (reveal.documentId && doc.id === reveal.documentId) return true;
          if (reveal.fileName && doc.name === reveal.fileName) return true;
          return false;
        });

        if (match) {
          setFocusDocumentId(match.id);
          setDownloadError('');
        } else if (openedTarget && (reveal.documentId || reveal.fileName)) {
          setFocusDocumentId(null);
          setDownloadError('Document not found');
        } else {
          setFocusDocumentId(null);
        }
      } catch (err) {
        console.error(err);
      } finally {
        if (!cancelled) setRevealing(false);
      }
    };

    void openPath();
    return () => {
      cancelled = true;
    };
  }, [loadingTeams, reveal, teams, loadBinders, loadContents]);

  useEffect(() => {
    if (!focusDocumentId) return;
    let tries = 0;
    let frame = 0;
    const find = () => {
      const row = document.querySelector<HTMLElement>(`[data-document-id="${focusDocumentId}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (tries < 12) {
        tries += 1;
        frame = requestAnimationFrame(find);
      }
    };
    find();
    return () => cancelAnimationFrame(frame);
  }, [focusDocumentId, contentsByParent, expandedFolders, expandedBinders]);

  async function downloadDocument(documentId: string, name: string) {
    setDownloadingId(documentId);
    setDownloadError('');
    try {
      await apiDownload(`/destinations/documents/${documentId}/download`, name);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadingId(null);
    }
  }

  function renderContents(parentKey: string, depth: number, folderPath: string[]) {
    const contents = contentsByParent.get(parentKey);
    if (!contents) return null;

    if (contents.folders.length === 0 && contents.documents.length === 0) {
      return (
        <div className="tree-empty-inline" style={{ paddingLeft: `${depth * 20 + 16}px` }}>
          Nothing has been sent here yet.
        </div>
      );
    }

    return (
      <>
        {contents.folders.map((folder) => {
          const childKey = `folder:${folder.id}`;
          const isExpanded = expandedFolders.has(folder.id);
          const isLoading = loadingSet.has(childKey);
          const childContents = contentsByParent.get(childKey);
          const hasChildren = !childContents
            || childContents.folders.length > 0
            || childContents.documents.length > 0;
          const nextPath = [...folderPath, folder.id];

          return (
            <div key={folder.id}>
              <div
                className={`tree-row tree-row-folder${activeFolderId === folder.id ? ' tree-row--active' : ''}`}
                style={{ paddingLeft: `${depth * 20}px` }}
                data-folder-id={folder.id}
                onClick={() => selectFolder(folder)}
              >
                <Expander
                  loading={isLoading}
                  expandable={hasChildren}
                  expanded={isExpanded}
                  onClick={() => void toggleFolder(folder)}
                />
                <span className="tree-node-icon" aria-hidden="true">
                  <FolderIcon />
                </span>
                <button
                  type="button"
                  className="tree-folder-name"
                  onClick={(event) => {
                    event.stopPropagation();
                    selectFolder(folder);
                  }}
                >
                  {folder.name}
                </button>
                <button
                  type="button"
                  className="btn btn-sm tree-send-here"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSendHere(sendTargetFor(folder, nextPath));
                  }}
                >
                  Send documents here
                </button>
              </div>
              {isExpanded && renderContents(childKey, depth + 1, nextPath)}
            </div>
          );
        })}
        {contents.documents.map((doc) => (
          <div
            key={doc.id}
            data-document-id={doc.id}
            className={`tree-row tree-row-doc${focusDocumentId === doc.id ? ' tree-row-doc--focus' : ''}`}
            style={{ paddingLeft: `${depth * 20}px` }}
          >
            <span className="tree-arrow-gap" aria-hidden="true" />
            <span className="tree-node-icon" aria-hidden="true">
              <FileIcon />
            </span>
            <div className="tree-doc-info">
              <span className="tree-name">{doc.name}</span>
              <span className="tree-doc-meta">
                {formatFileSize(Number(doc.sizeBytes))} · {fileKind(doc.contentType)} · {formatDate(doc.createdAt)}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm item-download"
              disabled={downloadingId === doc.id}
              onClick={() => void downloadDocument(doc.id, doc.name)}
            >
              {downloadingId === doc.id ? 'Downloading...' : 'Download'}
            </button>
          </div>
        ))}
      </>
    );
  }

  if (loadingTeams || revealing) {
    return (
      <div className="dest-tree documents-tree">
        <PageLoading label={revealing ? 'Opening the document' : 'Loading documents'} />
      </div>
    );
  }

  if (teams.length === 0) {
    return (
      <div className="dest-tree documents-tree">
        <p className="empty-state">You are not on a team yet, so there is nowhere to file documents.</p>
      </div>
    );
  }

  return (
    <div className="dest-tree documents-tree">
      {downloadError && <div className="error-banner">{downloadError}</div>}
      <ContentReveal className="tree-scroll">
        {teams.map((team) => {
          const isExpanded = expandedTeams.has(team.id);
          const isLoading = loadingSet.has(`team:${team.id}`);
          const binders = bindersByTeam.get(team.id);

          return (
            <div key={team.id} className="tree-team-group">
              <div className="tree-row tree-row-team">
                <button
                  type="button"
                  className="tree-arrow"
                  onClick={() => void toggleTeam(team)}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isLoading ? <span className="tree-spinner" /> : isExpanded ? '▾' : '▸'}
                </button>
                <span className="tree-node-icon" aria-hidden="true">
                  <TeamIcon />
                </span>
                <button
                  type="button"
                  className="tree-team-name"
                  onClick={() => void toggleTeam(team)}
                >
                  {team.name}
                </button>
              </div>

              {isExpanded &&
                binders?.map((binder) => {
                  const binderExpanded = expandedBinders.has(binder.id);
                  const binderKey = `binder:${binder.id}`;
                  const binderLoading = loadingSet.has(binderKey);
                  const binderContents = contentsByParent.get(binderKey);
                  const hasChildren = !binderContents
                    || binderContents.folders.length > 0
                    || binderContents.documents.length > 0;

                  return (
                    <div key={binder.id}>
                      <div className="tree-row tree-row-binder" style={{ paddingLeft: '20px' }}>
                        <Expander
                          loading={binderLoading}
                          expandable={hasChildren}
                          expanded={binderExpanded}
                          onClick={() => void toggleBinder(binder)}
                        />
                        <span className="tree-node-icon" aria-hidden="true">
                          <BinderIcon />
                        </span>
                        <button
                          type="button"
                          className="tree-binder-name"
                          onClick={() => void toggleBinder(binder)}
                        >
                          {binder.name}
                        </button>
                      </div>
                      {binderExpanded && renderContents(binderKey, 2, [])}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </ContentReveal>
    </div>
  );
}
