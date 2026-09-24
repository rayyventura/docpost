import { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../api/client';
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
}

function destKey(d: { teamId: string; binderId: string; folderId?: string | null }): string {
  return `${d.teamId}:${d.binderId}:${d.folderId ?? ''}`;
}

export function DestinationTree({ selected, onChange }: DestinationTreeProps) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loadingTeams, setLoadingTeams] = useState(true);

  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
  const [expandedBinders, setExpandedBinders] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const [bindersByTeam, setBindersByTeam] = useState<Map<string, Binder[]>>(new Map());
  const [foldersByParent, setFoldersByParent] = useState<Map<string, FolderNode[]>>(new Map());

  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set());

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
      if (!foldersByParent.has(parentKey)) {
        markLoading(parentKey, true);
        try {
          const data = await apiRequest<{ folders: { id: string; name: string }[] }>(
            `/destinations/binders/${binder.id}/contents`,
          );
          setFoldersByParent((prev) => {
            const next = new Map(prev);
            next.set(
              parentKey,
              (data.folders ?? []).map((f) => ({
                id: f.id,
                name: f.name,
                binderId: binder.id,
                binderName: binder.name,
                teamId: binder.teamId,
                teamName: binder.teamName,
                parentId: null,
              })),
            );
            return next;
          });
        } catch (err) {
          console.error(err);
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
      if (!foldersByParent.has(parentKey)) {
        markLoading(parentKey, true);
        try {
          const data = await apiRequest<{ folders: { id: string; name: string }[] }>(
            `/destinations/folders/${folder.id}/contents`,
          );
          setFoldersByParent((prev) => {
            const next = new Map(prev);
            next.set(
              parentKey,
              (data.folders ?? []).map((f) => ({
                id: f.id,
                name: f.name,
                binderId: folder.binderId,
                binderName: folder.binderName,
                teamId: folder.teamId,
                teamName: folder.teamName,
                parentId: folder.id,
              })),
            );
            return next;
          });
        } catch (err) {
          console.error(err);
          markLoading(parentKey, false);
          return;
        }
        markLoading(parentKey, false);
      }

      setExpandedFolders((prev) => new Set(prev).add(folder.id));
    },
    [expandedFolders, foldersByParent, markLoading],
  );

  const isSelected = useCallback(
    (d: { teamId: string; binderId: string; folderId?: string | null }): boolean =>
      selected.some((s) => destKey(s) === destKey(d)),
    [selected],
  );

  const toggleDestination = useCallback(
    (dest: Destination) => {
      const key = destKey(dest);
      if (selected.some((s) => destKey(s) === key)) {
        onChange(selected.filter((s) => destKey(s) !== key));
      } else {
        onChange([...selected, dest]);
      }
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
      const hasChildren = childFolders ? childFolders.length > 0 : !foldersByParent.has(childKey);

      const dest: Destination = {
        teamId: folder.teamId,
        teamName: folder.teamName,
        binderId: folder.binderId,
        binderName: folder.binderName,
        folderId: folder.id,
        folderName: folder.name,
      };

      return (
        <div key={folder.id}>
          <div className="tree-row" style={{ paddingLeft: `${depth * 20}px` }}>
            <button
              className="tree-arrow"
              onClick={() => toggleFolder(folder)}
              aria-label={isExpanded ? 'Collapse' : 'Expand'}
            >
              {isLoading ? (
                <span className="tree-spinner" />
              ) : hasChildren ? (
                isExpanded ? '▾' : '▸'
              ) : (
                ''
              )}
            </button>
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

  if (loadingTeams) {
    return (
      <div className="dest-tree">
        <div className="tree-panel-header">Destinations</div>
        <div className="tree-loading">Loading teams...</div>
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
      <div className="tree-scroll">
        {teams.map((team) => {
          const isExpanded = expandedTeams.has(team.id);
          const isLoading = loadingSet.has(`team:${team.id}`);
          const binders = bindersByTeam.get(team.id);

          return (
            <div key={team.id} className="tree-team-group">
              <div className="tree-row tree-row-team" onClick={() => toggleTeam(team)}>
                <button className="tree-arrow" aria-label={isExpanded ? 'Collapse' : 'Expand'}>
                  {isLoading ? (
                    <span className="tree-spinner" />
                  ) : isExpanded ? (
                    '▾'
                  ) : (
                    '▸'
                  )}
                </button>
                <span className="tree-name tree-name-team">{team.name}</span>
              </div>

              {isExpanded &&
                binders?.map((binder) => {
                  const binderExpanded = expandedBinders.has(binder.id);
                  const binderLoading = loadingSet.has(`binder:${binder.id}`);
                  const binderFolders = foldersByParent.get(`binder:${binder.id}`);
                  const hasFolders = binderFolders
                    ? binderFolders.length > 0
                    : !foldersByParent.has(`binder:${binder.id}`);

                  const binderDest: Destination = {
                    teamId: binder.teamId,
                    teamName: binder.teamName,
                    binderId: binder.id,
                    binderName: binder.name,
                  };

                  return (
                    <div key={binder.id}>
                      <div className="tree-row" style={{ paddingLeft: '20px' }}>
                        <button
                          className="tree-arrow"
                          onClick={() => toggleBinder(binder)}
                          aria-label={binderExpanded ? 'Collapse' : 'Expand'}
                        >
                          {binderLoading ? (
                            <span className="tree-spinner" />
                          ) : hasFolders ? (
                            binderExpanded ? '▾' : '▸'
                          ) : (
                            ''
                          )}
                        </button>
                        <label className="tree-check-label">
                          <input
                            type="checkbox"
                            checked={isSelected(binderDest)}
                            onChange={() => toggleDestination(binderDest)}
                          />
                          <span className="tree-name">{binder.name}</span>
                        </label>
                      </div>
                      {binderExpanded &&
                        renderFolders(`binder:${binder.id}`, 2)}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
