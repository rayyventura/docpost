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
}

interface FolderItem {
  id: string;
  name: string;
  type: 'folder' | 'document';
}

interface DestinationPickerProps {
  selected: Destination[];
  onAdd: (dest: Destination) => void;
  onRemove: (index: number) => void;
}

export function DestinationPicker({ selected, onAdd, onRemove }: DestinationPickerProps) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [binders, setBinders] = useState<Binder[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);
  const [selectedBinder, setSelectedBinder] = useState<Binder | null>(null);
  const [folderPath, setFolderPath] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiRequest<Team[]>('/destinations/teams').then(setTeams).catch(console.error);
  }, []);

  const selectTeam = useCallback(async (team: Team) => {
    setSelectedTeam(team);
    setSelectedBinder(null);
    setFolderPath([]);
    setFolders([]);
    setLoading(true);
    try {
      const data = await apiRequest<Binder[]>(`/destinations/teams/${team.id}/binders`);
      setBinders(data);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  const selectBinder = useCallback(async (binder: Binder) => {
    setSelectedBinder(binder);
    setFolderPath([]);
    setLoading(true);
    try {
      const data = await apiRequest<{ folders: FolderItem[] }>(`/destinations/binders/${binder.id}/contents`);
      setFolders(data.folders ?? []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  const openFolder = useCallback(async (folder: { id: string; name: string }) => {
    setFolderPath((prev) => [...prev, folder]);
    setLoading(true);
    try {
      const data = await apiRequest<{ folders: FolderItem[] }>(`/destinations/folders/${folder.id}/contents`);
      setFolders(data.folders ?? []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  const goBack = useCallback(() => {
    if (folderPath.length > 0) {
      const newPath = folderPath.slice(0, -1);
      setFolderPath(newPath);
      const parentId = newPath.length > 0 ? newPath[newPath.length - 1].id : null;
      setLoading(true);
      const url = parentId
        ? `/destinations/folders/${parentId}/contents`
        : `/destinations/binders/${selectedBinder!.id}/contents`;
      apiRequest<{ folders: FolderItem[] }>(url)
        .then((data) => setFolders(data.folders ?? []))
        .catch(console.error)
        .finally(() => setLoading(false));
    } else if (selectedBinder) {
      setSelectedBinder(null);
      setFolders([]);
    } else if (selectedTeam) {
      setSelectedTeam(null);
      setBinders([]);
    }
  }, [folderPath, selectedBinder, selectedTeam]);

  const addCurrentLocation = useCallback(() => {
    if (!selectedTeam || !selectedBinder) return;

    const dest: Destination = {
      teamId: selectedTeam.id,
      teamName: selectedTeam.name,
      binderId: selectedBinder.id,
      binderName: selectedBinder.name,
    };

    if (folderPath.length > 0) {
      const current = folderPath[folderPath.length - 1];
      dest.folderId = current.id;
      dest.folderName = current.name;
    }

    // Check for duplicates
    const isDuplicate = selected.some(
      (s) =>
        s.teamId === dest.teamId &&
        s.binderId === dest.binderId &&
        (s.folderId ?? null) === (dest.folderId ?? null),
    );

    if (!isDuplicate) {
      onAdd(dest);
    }
  }, [selectedTeam, selectedBinder, folderPath, selected, onAdd]);

  return (
    <div className="destination-picker">
      <div className="dest-browser">
        <div className="dest-nav">
          {(selectedTeam || selectedBinder || folderPath.length > 0) && (
            <button className="btn btn-sm" onClick={goBack}>
              &larr; Back
            </button>
          )}
          <span className="dest-path">
            {selectedTeam ? selectedTeam.name : 'Select a team'}
            {selectedBinder && ` / ${selectedBinder.name}`}
            {folderPath.map((f) => ` / ${f.name}`).join('')}
          </span>
          {selectedBinder && (
            <button className="btn btn-sm btn-primary" onClick={addCurrentLocation}>
              + Add this destination
            </button>
          )}
        </div>

        {loading && <p className="loading">Loading...</p>}

        {!selectedTeam && !loading && (
          <ul className="dest-list">
            {teams.map((t) => (
              <li key={t.id} className="dest-item" onClick={() => selectTeam(t)}>
                {t.name}
              </li>
            ))}
          </ul>
        )}

        {selectedTeam && !selectedBinder && !loading && (
          <ul className="dest-list">
            {binders.map((b) => (
              <li key={b.id} className="dest-item" onClick={() => selectBinder(b)}>
                {b.name}
              </li>
            ))}
          </ul>
        )}

        {selectedBinder && !loading && (
          <ul className="dest-list">
            {folders
              .filter((f) => f.type === 'folder')
              .map((f) => (
                <li key={f.id} className="dest-item" onClick={() => openFolder(f)}>
                  📁 {f.name}
                </li>
              ))}
            {folders.filter((f) => f.type === 'folder').length === 0 && (
              <li className="dest-empty">No subfolders</li>
            )}
          </ul>
        )}
      </div>

      {selected.length > 0 && (
        <div className="dest-selected">
          <h4>Selected destinations ({selected.length})</h4>
          <ul className="dest-tags">
            {selected.map((d, i) => (
              <li key={i} className="dest-tag">
                {d.teamName} / {d.binderName}
                {d.folderName && ` / ${d.folderName}`}
                <button className="dest-tag-remove" onClick={() => onRemove(i)}>
                  &times;
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
