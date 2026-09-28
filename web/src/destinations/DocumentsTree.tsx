import { useState, useEffect, useCallback, useRef } from 'react';
import { apiDownload, apiRequest } from '../api/client';
import { ContentReveal } from '../ContentReveal';
import { PageLoading } from '../PageLoading';
import { formatDate } from '../formatDate';
import { SidebarTree } from '../layout/SidebarTree';
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

type SelectedNode =
  | { kind: 'team'; team: Team }
  | { kind: 'binder'; binder: Binder }
  | { kind: 'folder'; folder: FolderNode; path: string[] };

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

function documentCount(contents: NodeContents | undefined): number {
  return contents?.documents.length ?? 0;
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
  const [selected, setSelected] = useState<SelectedNode | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const [focusDocumentId, setFocusDocumentId] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(Boolean(reveal?.teamId && reveal.binderId));
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState('');

  const bindersByTeamRef = useRef(bindersByTeam);
  const contentsByParentRef = useRef(contentsByParent);
  const revealedToken = useRef<string | null>(null);
  const focusTimer = useRef(0);
  bindersByTeamRef.current = bindersByTeam;
  contentsByParentRef.current = contentsByParent;

  useEffect(() => {
    apiRequest<Team[]>('/destinations/teams')
      .then(setTeams)
      .catch(console.error)
      .finally(() => setLoadingTeams(false));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      if (event.repeat) return;
      const search = searchRef.current;
      if (!search) return;
      event.preventDefault();
      search.focus();
      search.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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

  const selectTeam = useCallback((team: Team) => {
    setSelected({ kind: 'team', team });
    setQuery('');
    if (!expandedTeams.has(team.id)) {
      void toggleTeam(team);
    }
  }, [expandedTeams, toggleTeam]);

  const selectBinder = useCallback((binder: Binder) => {
    setSelected({ kind: 'binder', binder });
    setQuery('');
    if (!expandedBinders.has(binder.id)) {
      void toggleBinder(binder);
    }
  }, [expandedBinders, toggleBinder]);

  const selectFolder = useCallback((folder: FolderNode, path: string[]) => {
    setSelected({ kind: 'folder', folder, path });
    setQuery('');
    if (!expandedFolders.has(folder.id)) {
      void toggleFolder(folder);
    }
  }, [expandedFolders, toggleFolder]);

  useEffect(() => {
    if (!reveal?.teamId || !reveal.binderId) {
      setRevealing(false);
      return;
    }

    const token = [
      reveal.teamId,
      reveal.binderId,
      reveal.folderId ?? '',
      reveal.documentId ?? reveal.fileName ?? '',
    ].join(':');
    if (revealedToken.current === token) {
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
        setSelected({ kind: 'binder', binder });

        const path = reveal.folderPath ?? [];
        let siblings = binderContents.folders;
        let selectedFolder: FolderNode | undefined;
        let currentContents = binderContents;
        let openedTarget = path.length === 0 && !reveal.folderId;
        const openedPath: string[] = [];

        for (const [index, segment] of path.entries()) {
          const segmentId = folderSegmentId(segment);
          if (!segmentId) break;
          const folder = siblings.find((item) => item.id === segmentId);
          if (!folder) break;
          selectedFolder = folder;
          openedPath.push(folder.id);
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
          const leafFolder = selectedFolder && selectedFolder.id === leafId
            ? selectedFolder
            : {
                id: leafId,
                name: reveal.folderPath?.at(-1)?.name || 'Folder',
                binderId: binder.id,
                binderName: binder.name,
                teamId: binder.teamId,
                teamName: binder.teamName,
                parentId: null,
              };
          setSelected({
            kind: 'folder',
            folder: leafFolder,
            path: openedPath.length > 0 ? openedPath : [leafId],
          });
          openedTarget = true;
        } else if (selectedFolder) {
          setSelected({ kind: 'folder', folder: selectedFolder, path: openedPath });
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
        if (!cancelled) {
          revealedToken.current = token;
          setRevealing(false);
        }
      }
    };

    void openPath();
    return () => {
      cancelled = true;
    };
  }, [loadingTeams, reveal, teams, loadBinders, loadContents]);

  useEffect(() => {
    if (revealing || !focusDocumentId) return;
    let tries = 0;
    let frame = 0;
    const find = () => {
      const row = document.querySelector<HTMLElement>(`[data-document-id="${focusDocumentId}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        window.clearTimeout(focusTimer.current);
        focusTimer.current = window.setTimeout(() => setFocusDocumentId(null), 1600);
        return;
      }
      if (tries < 24) {
        tries += 1;
        frame = requestAnimationFrame(find);
      }
    };
    find();
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(focusTimer.current);
    };
  }, [focusDocumentId, revealing]);

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

  function renderFolders(parentKey: string, depth: number, folderPath: string[]) {
    const contents = contentsByParent.get(parentKey);
    if (!contents) return null;

    return contents.folders.map((folder) => {
      const childKey = `folder:${folder.id}`;
      const isExpanded = expandedFolders.has(folder.id);
      const isLoading = loadingSet.has(childKey);
      const childContents = contentsByParent.get(childKey);
      const hasChildren = !childContents || childContents.folders.length > 0;
      const nextPath = [...folderPath, folder.id];
      const isActive = selected?.kind === 'folder' && selected.folder.id === folder.id;
      const count = documentCount(childContents);

      return (
        <div key={folder.id}>
          <div
            className={`tree-row tree-row-folder${isActive ? ' tree-row--active' : ''}`}
            style={{ paddingLeft: `${depth * 20}px` }}
            data-folder-id={folder.id}
            onClick={() => selectFolder(folder, nextPath)}
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
                selectFolder(folder, nextPath);
              }}
            >
              {folder.name}
            </button>
            {count > 0 && <span className="tree-count">{count}</span>}
          </div>
          {isExpanded && renderFolders(childKey, depth + 1, nextPath)}
        </div>
      );
    });
  }

  const selectedContents = selected?.kind === 'binder'
    ? contentsByParent.get(`binder:${selected.binder.id}`)
    : selected?.kind === 'folder'
      ? contentsByParent.get(`folder:${selected.folder.id}`)
      : undefined;
  const selectedLoading = selected?.kind === 'binder'
    ? loadingSet.has(`binder:${selected.binder.id}`)
    : selected?.kind === 'folder'
      ? loadingSet.has(`folder:${selected.folder.id}`)
      : false;
  const documents = selectedContents?.documents ?? [];
  const visibleDocuments = query.trim()
    ? documents.filter((doc) => doc.name.toLowerCase().includes(query.trim().toLowerCase()))
    : documents;

  const opening = revealing || loadingTeams;
  const openingLabel = revealing ? 'Opening the document' : 'Loading documents';

  const tree = (
    <div className="dest-tree dest-tree--rail documents-tree">
      {opening ? (
        <PageLoading label={openingLabel} />
      ) : teams.length === 0 ? (
        <p className="tree-empty">You are not on a team yet, so there is nowhere to file documents.</p>
      ) : (
        <div className="tree-scroll">
          <ContentReveal>
            {teams.map((team) => {
              const isExpanded = expandedTeams.has(team.id);
              const isLoading = loadingSet.has(`team:${team.id}`);
              const binders = bindersByTeam.get(team.id);
              const teamActive = selected?.kind === 'team' && selected.team.id === team.id;

              return (
                <div key={team.id} className="tree-team-group">
                  <div className={`tree-row tree-row-team${teamActive ? ' tree-row--active' : ''}`}>
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
                      onClick={() => selectTeam(team)}
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
                      const hasChildren = !binderContents || binderContents.folders.length > 0;
                      const binderActive = selected?.kind === 'binder' && selected.binder.id === binder.id;
                      const count = documentCount(binderContents);

                      return (
                        <div key={binder.id}>
                          <div
                            className={`tree-row tree-row-binder${binderActive ? ' tree-row--active' : ''}`}
                            style={{ paddingLeft: '20px' }}
                            onClick={() => selectBinder(binder)}
                          >
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
                              onClick={(event) => {
                                event.stopPropagation();
                                selectBinder(binder);
                              }}
                            >
                              {binder.name}
                            </button>
                            {count > 0 && <span className="tree-count">{count}</span>}
                          </div>
                          {binderExpanded && renderFolders(binderKey, 2, [])}
                        </div>
                      );
                    })}
                </div>
              );
            })}
          </ContentReveal>
        </div>
      )}
    </div>
  );

  const title = selected?.kind === 'folder'
    ? selected.folder.name
    : selected?.kind === 'binder'
      ? selected.binder.name
      : selected?.kind === 'team'
        ? selected.team.name
        : 'Documents';
  const crumb = selected?.kind === 'folder'
    ? `${selected.folder.teamName} · ${selected.folder.binderName}`
    : selected?.kind === 'binder'
      ? selected.binder.teamName
      : null;

  return (
    <>
      <SidebarTree pane="docs">{tree}</SidebarTree>
      <div className="files-pane">
        {opening ? (
          <PageLoading label={openingLabel} />
        ) : (
          <>
            <div className="files-pane-header">
              <div className="files-pane-heading">
                {crumb && <p className="files-pane-crumb">{crumb}</p>}
                <h2 className="files-pane-title">{title}</h2>
                {!selected && (
                  <p className="files-pane-lead">
                    Browse files by team, binder, and folder.
                  </p>
                )}
                {(selected?.kind === 'folder' || selected?.kind === 'binder') && (
                  <p className="files-pane-lead">
                    Only authorized study staff can download.
                  </p>
                )}
              </div>
              <div className="files-pane-tools">
                {(selected?.kind === 'binder' || selected?.kind === 'folder') && (
                  <div className="files-search-wrap">
                    <input
                      ref={searchRef}
                      className="files-search"
                      type="search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search"
                      aria-label="Search"
                    />
                    {query && (
                      <button
                        type="button"
                        className="files-search-clear"
                        onClick={() => {
                          setQuery('');
                          searchRef.current?.focus();
                        }}
                        aria-label="Clear search"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}
                {selected?.kind === 'folder' && !selectedLoading && documents.length > 0 && (
                  <button
                    type="button"
                    className="files-pane-send"
                    onClick={() => onSendHere(sendTargetFor(selected.folder, selected.path))}
                  >
                    Send documents to this location
                  </button>
                )}
              </div>
            </div>
            {downloadError && <div className="error-banner">{downloadError}</div>}
            <div className="files-pane-body">
              {!selected || selected.kind === 'team' ? (
                <p className="empty-state">Select a binder or folder to see its documents.</p>
              ) : selectedLoading && !selectedContents ? (
                <PageLoading label="Loading documents" />
              ) : documents.length === 0 ? (
                <ContentReveal>
                  <div className="empty-state empty-state--compact">
                    <p>No documents have been sent here yet.</p>
                    {selected.kind === 'folder' && (
                      <button
                        type="button"
                        className="files-pane-send"
                        onClick={() => onSendHere(sendTargetFor(selected.folder, selected.path))}
                      >
                        Send documents to this location
                      </button>
                    )}
                  </div>
                </ContentReveal>
              ) : visibleDocuments.length === 0 ? (
                <ContentReveal>
                  <p className="empty-state empty-state--compact">No documents match that search.</p>
                </ContentReveal>
              ) : (
                <ContentReveal>
                  <ul className="doc-list">
                    {visibleDocuments.map((doc) => {
                      const kind = fileKind(doc.contentType);
                      return (
                        <li
                          key={doc.id}
                          data-document-id={doc.id}
                          className={`doc-row${focusDocumentId === doc.id ? ' doc-row--focus' : ''}`}
                        >
                          <span className={`doc-kind doc-kind--${kind.toLowerCase()}`}>{kind}</span>
                          <div className="doc-info">
                            <span className="doc-name">{doc.name}</span>
                            <span className="doc-meta">
                              {kind.toLowerCase()} · {formatFileSize(Number(doc.sizeBytes))} · {formatDate(doc.createdAt)}
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
                        </li>
                      );
                    })}
                  </ul>
                </ContentReveal>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
