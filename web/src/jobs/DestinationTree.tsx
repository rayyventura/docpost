import { useState, useEffect, useCallback, useRef } from 'react';
import { apiRequest } from '../api/client';
import { ContentReveal } from '../ContentReveal';
import { PageLoading } from '../PageLoading';
import type { Destination } from './types';

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

interface DestinationTreeProps {
  selected: Destination[];
  onChange: (destinations: Destination[]) => void;
  revealFolderPath?: string[];
  revealFolderId?: string;
}

function destKey(d: { teamId: string; binderId?: string | null; folderId?: string | null }): string {
  return `${d.teamId}:${d.binderId ?? ''}:${d.folderId ?? ''}`;
}

function folderAncestorPath(
  folder: FolderNode,
  foldersByParent: Map<string, FolderNode[]>,
): Array<{ id: string; name: string }> {
  const byId = new Map<string, FolderNode>();
  for (const nodes of foldersByParent.values()) {
    for (const node of nodes) byId.set(node.id, node);
  }

  const path: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  let current: FolderNode | undefined = folder;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift({ id: current.id, name: current.name });
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
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
      onClick={onClick}
      aria-label={expanded ? 'Collapse' : 'Expand'}
    >
      {loading ? <span className="tree-spinner" /> : expanded ? '▾' : '▸'}
    </button>
  );
}

export function DestinationTree({ selected, onChange, revealFolderPath = [], revealFolderId }: DestinationTreeProps) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loadingTeams, setLoadingTeams] = useState(true);

  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  const [expandedBinders, setExpandedBinders] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const [bindersByTeam, setBindersByTeam] = useState<Map<string, Binder[]>>(new Map());
  const [foldersByParent, setFoldersByParent] = useState<Map<string, FolderNode[]>>(new Map());
  const [emptyNodes, setEmptyNodes] = useState<Set<string>>(new Set());

  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set());
  const [revealing, setRevealing] = useState(Boolean(revealFolderId));
  const [focusFolderId, setFocusFolderId] = useState<string | null>(null);
  const revealedToken = useRef<string | null>(null);
  const bindersByTeamRef = useRef(bindersByTeam);
  const foldersByParentRef = useRef(foldersByParent);
  bindersByTeamRef.current = bindersByTeam;
  foldersByParentRef.current = foldersByParent;

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

  const toggleTeam = useCallback(
    async (team: Team) => {
      if (expandedTeams.has(team.id)) {
        setExpandedTeams((prev) => {
          const next = new Set(prev);
          next.delete(team.id);
          return next;
        });
        return;
      }

      if (!bindersByTeam.has(team.id)) {
        markLoading(`team:${team.id}`, true);
        try {
          const data = await apiRequest<{ id: string; name: string }[]>(
            `/destinations/teams/${team.id}/binders`,
          );
          setBindersByTeam((prev) => {
            const next = new Map(prev);
            next.set(
              team.id,
              data.map((b) => ({
                id: b.id,
                name: b.name,
                teamId: team.id,
                teamName: team.name,
              })),
            );
            return next;
          });
        } catch (err) {
          console.error(err);
          markLoading(`team:${team.id}`, false);
          return;
        }
        markLoading(`team:${team.id}`, false);
      }

      setExpandedTeams((prev) => new Set(prev).add(team.id));
    },
    [expandedTeams, bindersByTeam, markLoading],
  );

  const toggleBinder = useCallback(
    async (binder: Binder) => {
      if (expandedBinders.has(binder.id)) {
        setExpandedBinders((prev) => {
          const next = new Set(prev);
          next.delete(binder.id);
          return next;
        });
        return;
      }

      const parentKey = `binder:${binder.id}`;
      const cached = foldersByParent.get(parentKey);
      if (cached && cached.length === 0) return;

      if (!cached) {
        markLoading(parentKey, true);
        try {
          const data = await apiRequest<{ folders: { id: string; name: string }[] }>(
            `/destinations/binders/${binder.id}/contents`,
          );
          const childFolders = (data.folders ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            binderId: binder.id,
            binderName: binder.name,
            teamId: binder.teamId,
            teamName: binder.teamName,
            parentId: null,
          }));
          setFoldersByParent((prev) => {
            const next = new Map(prev);
            next.set(parentKey, childFolders);
            return next;
          });
          if (childFolders.length === 0) {
            setEmptyNodes((prev) => new Set(prev).add(parentKey));
            markLoading(parentKey, false);
            return;
          }
        } catch (err) {
          console.error(err);
          setEmptyNodes((prev) => new Set(prev).add(parentKey));
          markLoading(parentKey, false);
          return;
        }
        markLoading(parentKey, false);
      }

      setExpandedBinders((prev) => new Set(prev).add(binder.id));
    },
    [expandedBinders, foldersByParent, markLoading],
  );

  const toggleFolder = useCallback(
    async (folder: FolderNode) => {
      if (expandedFolders.has(folder.id)) {
        setExpandedFolders((prev) => {
          const next = new Set(prev);
          next.delete(folder.id);
          return next;
        });
        return;
      }

      const parentKey = `folder:${folder.id}`;
      const cached = foldersByParent.get(parentKey);
      if (cached && cached.length === 0) return;

      if (!cached) {
        markLoading(parentKey, true);
        try {
          const data = await apiRequest<{ folders: { id: string; name: string }[] }>(
            `/destinations/folders/${folder.id}/contents`,
          );
          const childFolders = (data.folders ?? []).map((f) => ({
            id: f.id,
            name: f.name,
            binderId: folder.binderId,
            binderName: folder.binderName,
            teamId: folder.teamId,
            teamName: folder.teamName,
            parentId: folder.id,
          }));
          setFoldersByParent((prev) => {
            const next = new Map(prev);
            next.set(parentKey, childFolders);
            return next;
          });
          if (childFolders.length === 0) {
            setEmptyNodes((prev) => new Set(prev).add(parentKey));
            markLoading(parentKey, false);
            return;
          }
        } catch (err) {
          console.error(err);
          setEmptyNodes((prev) => new Set(prev).add(parentKey));
          markLoading(parentKey, false);
          return;
        }
        markLoading(parentKey, false);
      }

      setExpandedFolders((prev) => new Set(prev).add(folder.id));
    },
    [expandedFolders, foldersByParent, markLoading],
  );

  useEffect(() => {
    if (!revealFolderId) {
      setRevealing(false);
      return;
    }

    const token = `${revealFolderId}:${revealFolderPath.join(',')}`;
    if (revealedToken.current === token) {
      setRevealing(false);
      return;
    }

    setRevealing(true);
    setFocusFolderId(null);

    if (loadingTeams || selected.length === 0) return;

    const dest = selected.find((item) => item.folderId === revealFolderId) ?? selected[selected.length - 1];
    if (!dest.binderId) {
      setRevealing(false);
      return;
    }

    let cancelled = false;

    const reveal = async () => {
      const team = teams.find((item) => item.id === dest.teamId) ?? {
        id: dest.teamId,
        name: dest.teamName,
      };

      if (!bindersByTeamRef.current.has(team.id)) {
        try {
          const data = await apiRequest<{ id: string; name: string }[]>(
            `/destinations/teams/${team.id}/binders`,
          );
          if (cancelled) return;
          setBindersByTeam((prev) => {
            const next = new Map(prev);
            next.set(
              team.id,
              data.map((binder) => ({
                id: binder.id,
                name: binder.name,
                teamId: team.id,
                teamName: team.name,
              })),
            );
            return next;
          });
        } catch (err) {
          console.error(err);
          return;
        }
      }
      if (cancelled) return;
      setExpandedTeams((prev) => new Set(prev).add(team.id));

      const binder: Binder = {
        id: dest.binderId,
        name: dest.binderName,
        teamId: dest.teamId,
        teamName: dest.teamName,
      };
      const binderKey = `binder:${binder.id}`;
      let binderFolders = foldersByParentRef.current.get(binderKey);
      if (!binderFolders) {
        try {
          const data = await apiRequest<{ folders: { id: string; name: string }[] }>(
            `/destinations/binders/${binder.id}/contents`,
          );
          if (cancelled) return;
          binderFolders = (data.folders ?? []).map((folder) => ({
            id: folder.id,
            name: folder.name,
            binderId: binder.id,
            binderName: binder.name,
            teamId: binder.teamId,
            teamName: binder.teamName,
            parentId: null,
          }));
          setFoldersByParent((prev) => {
            const next = new Map(prev);
            next.set(binderKey, binderFolders ?? []);
            return next;
          });
          if (binderFolders.length === 0) {
            setEmptyNodes((prev) => new Set(prev).add(binderKey));
          }
        } catch (err) {
          console.error(err);
          return;
        }
      }
      if (cancelled) return;
      if (binderFolders.length > 0) {
        setExpandedBinders((prev) => new Set(prev).add(binder.id));
      }

      const foldersToOpen = dest.folderId
        ? revealFolderPath.filter((folderId) => folderId !== dest.folderId)
        : [];

      let siblings = binderFolders;
      for (const folderId of foldersToOpen) {
        const folder = siblings.find((item) => item.id === folderId);
        if (!folder) break;

        const childKey = `folder:${folder.id}`;
        let children = foldersByParentRef.current.get(childKey);
        if (!children) {
          try {
            const data = await apiRequest<{ folders: { id: string; name: string }[] }>(
              `/destinations/folders/${folder.id}/contents`,
            );
            if (cancelled) return;
            children = (data.folders ?? []).map((item) => ({
              id: item.id,
              name: item.name,
              binderId: folder.binderId,
              binderName: folder.binderName,
              teamId: folder.teamId,
              teamName: folder.teamName,
              parentId: folder.id,
            }));
            setFoldersByParent((prev) => {
              const next = new Map(prev);
              next.set(childKey, children ?? []);
              return next;
            });
            if (children.length === 0) {
              setEmptyNodes((prev) => new Set(prev).add(childKey));
            }
          } catch (err) {
            console.error(err);
            break;
          }
        }
        if (children.length > 0) {
          setExpandedFolders((prev) => new Set(prev).add(folder.id));
        }
        siblings = children;
      }

      if (!cancelled) {
        setFocusFolderId(dest.folderId ?? revealFolderId);
      }
    };

    void reveal().catch((err) => {
      console.error(err);
    }).finally(() => {
      if (!cancelled) {
        revealedToken.current = token;
        setRevealing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadingTeams, selected, revealFolderPath, revealFolderId, teams]);

  useEffect(() => {
    if (revealing || !focusFolderId) return;
    let tries = 0;
    let frame = 0;
    const find = () => {
      const row = document.querySelector<HTMLElement>(`[data-folder-id="${focusFolderId}"]`);
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
  }, [revealing, focusFolderId, foldersByParent, expandedFolders, expandedBinders]);

  const isSelected = useCallback(
    (d: { teamId: string; binderId?: string | null; folderId?: string | null }): boolean =>
      selected.some((s) => destKey(s) === destKey(d)),
    [selected],
  );

  const toggleDestination = useCallback(
    (dest: Destination) => {
      if (!dest.binderId || !dest.folderId) return;

      const key = destKey(dest);
      if (selected.some((s) => destKey(s) === key)) {
        onChange(selected.filter((s) => destKey(s) !== key));
        return;
      }

      onChange([...selected, dest]);
    },
    [selected, onChange],
  );

  function renderFolders(parentKey: string, depth: number) {
    const folders = foldersByParent.get(parentKey);
    if (!folders || folders.length === 0) return null;

    return folders.map((folder) => {
      const childKey = `folder:${folder.id}`;
      const isExpanded = expandedFolders.has(folder.id);
      const isLoading = loadingSet.has(childKey);
      const childFolders = foldersByParent.get(childKey);
      const hasChildren = !emptyNodes.has(childKey) && (childFolders ? childFolders.length > 0 : !foldersByParent.has(childKey));

      const dest: Destination = {
        teamId: folder.teamId,
        teamName: folder.teamName,
        binderId: folder.binderId,
        binderName: folder.binderName,
        folderId: folder.id,
        folderName: folder.name,
        folderPath: folderAncestorPath(folder, foldersByParent),
      };

      return (
        <div key={folder.id}>
          <div
            className={`tree-row${isSelected(dest) ? ' tree-row--active' : ''}${focusFolderId === folder.id ? ' tree-row-doc--focus' : ''}`}
            style={{ paddingLeft: `${depth * 20}px` }}
            data-folder-id={folder.id}
          >
            <Expander
              loading={isLoading}
              expandable={hasChildren}
              expanded={isExpanded}
              onClick={() => toggleFolder(folder)}
            />
            <label className="tree-check-label">
              <input
                type="checkbox"
                checked={isSelected(dest)}
                onChange={() => toggleDestination(dest)}
              />
              <span className="tree-name">{folder.name}</span>
            </label>
          </div>
          {isExpanded && renderFolders(childKey, depth + 1)}
        </div>
      );
    });
  }

  if (loadingTeams || revealing) {
    return (
      <div className="dest-tree">
        <div className="tree-panel-header">Destinations</div>
        <PageLoading label={revealing ? 'Opening the destination' : 'Loading destinations'} />
      </div>
    );
  }

  if (teams.length === 0) {
    return (
      <div className="dest-tree">
        <div className="tree-panel-header">Destinations</div>
        <div className="tree-empty">No teams available</div>
      </div>
    );
  }

  return (
    <div className="dest-tree">
      <div className="tree-panel-header">
        Destinations
        {selected.length > 0 && (
          <span className="tree-badge">{selected.length}</span>
        )}
      </div>
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
                  onClick={() => toggleTeam(team)}
                  aria-label={isExpanded ? 'Collapse' : 'Expand'}
                >
                  {isLoading ? (
                    <span className="tree-spinner" />
                  ) : isExpanded ? (
                    '▾'
                  ) : (
                    '▸'
                  )}
                </button>
                <button
                  type="button"
                  className="tree-team-name"
                  onClick={() => toggleTeam(team)}
                >
                  {team.name}
                </button>
              </div>

              {isExpanded &&
                binders?.map((binder) => {
                  const binderExpanded = expandedBinders.has(binder.id);
                  const binderLoading = loadingSet.has(`binder:${binder.id}`);
                  const binderKey = `binder:${binder.id}`;
                  const binderFolders = foldersByParent.get(binderKey);
                  const hasFolders = !emptyNodes.has(binderKey) && (binderFolders
                    ? binderFolders.length > 0
                    : !foldersByParent.has(binderKey));

                  return (
                    <div key={binder.id}>
                      <div className="tree-row tree-row-binder" style={{ paddingLeft: '20px' }}>
                        <Expander
                          loading={binderLoading}
                          expandable={hasFolders}
                          expanded={binderExpanded}
                          onClick={() => toggleBinder(binder)}
                        />
                        <button
                          type="button"
                          className="tree-binder-name"
                          onClick={() => toggleBinder(binder)}
                        >
                          {binder.name}
                        </button>
                      </div>
                      {binderExpanded &&
                        renderFolders(`binder:${binder.id}`, 2)}
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
