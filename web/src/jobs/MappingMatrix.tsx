import { useCallback } from 'react';
import type { SelectedFile, Destination, Mapping } from './types';

interface MappingMatrixProps {
  files: SelectedFile[];
  destinations: Destination[];
  mappings: Mapping[];
  onMappingsChange: (mappings: Mapping[]) => void;
}

export function MappingMatrix({ files, destinations, mappings, onMappingsChange }: MappingMatrixProps) {
  const readyFiles = files.filter((f) => f.status === 'ready' || f.status === 'hashing');

  const isChecked = (fileId: string, dest: Destination): boolean => {
    const mapping = mappings.find((m) => m.fileId === fileId);
    if (!mapping) return false;
    return mapping.destinations.some(
      (d) =>
        d.teamId === dest.teamId &&
        d.binderId === dest.binderId &&
        (d.folderId ?? null) === (dest.folderId ?? null),
    );
  };

  const toggle = useCallback(
    (fileId: string, dest: Destination) => {
      const existing = mappings.find((m) => m.fileId === fileId);

      if (!existing) {
        onMappingsChange([...mappings, { fileId, destinations: [dest] }]);
        return;
      }

      const has = existing.destinations.some(
        (d) =>
          d.teamId === dest.teamId &&
          d.binderId === dest.binderId &&
          (d.folderId ?? null) === (dest.folderId ?? null),
      );

      const updated = mappings.map((m) => {
        if (m.fileId !== fileId) return m;
        if (has) {
          return {
            ...m,
            destinations: m.destinations.filter(
              (d) =>
                !(
                  d.teamId === dest.teamId &&
                  d.binderId === dest.binderId &&
                  (d.folderId ?? null) === (dest.folderId ?? null)
                ),
            ),
          };
        } else {
          return { ...m, destinations: [...m.destinations, dest] };
        }
      });

      onMappingsChange(updated.filter((m) => m.destinations.length > 0));
    },
    [mappings, onMappingsChange],
  );

  const selectAllForFile = useCallback(
    (fileId: string) => {
      const existing = mappings.find((m) => m.fileId === fileId);
      const allSelected = existing && existing.destinations.length === destinations.length;

      if (allSelected) {
        onMappingsChange(mappings.filter((m) => m.fileId !== fileId));
      } else {
        const updated = mappings.filter((m) => m.fileId !== fileId);
        updated.push({ fileId, destinations: [...destinations] });
        onMappingsChange(updated);
      }
    },
    [mappings, destinations, onMappingsChange],
  );

  const selectAllForDest = useCallback(
    (dest: Destination) => {
      const allChecked = readyFiles.every((f) => isChecked(f.id, dest));

      if (allChecked) {
        // Uncheck this destination from all files
        const updated = mappings.map((m) => ({
          ...m,
          destinations: m.destinations.filter(
            (d) =>
              !(
                d.teamId === dest.teamId &&
                d.binderId === dest.binderId &&
                (d.folderId ?? null) === (dest.folderId ?? null)
              ),
          ),
        }));
        onMappingsChange(updated.filter((m) => m.destinations.length > 0));
      } else {
        // Check this destination for all files
        const updated = [...mappings];
        for (const file of readyFiles) {
          const existing = updated.find((m) => m.fileId === file.id);
          if (!existing) {
            updated.push({ fileId: file.id, destinations: [dest] });
          } else if (!isChecked(file.id, dest)) {
            existing.destinations.push(dest);
          }
        }
        onMappingsChange(updated);
      }
    },
    [readyFiles, mappings, destinations, onMappingsChange],
  );

  const taskCount = mappings.reduce((sum, m) => sum + m.destinations.length, 0);

  if (readyFiles.length === 0 || destinations.length === 0) {
    return (
      <div className="mapping-matrix-empty">
        <p>Add files and destinations to create mappings</p>
      </div>
    );
  }

  return (
    <div className="mapping-matrix">
      <div className="mapping-header">
        <h3>File-Destination Mapping</h3>
        <span className="task-count">{taskCount} tasks will be created</span>
      </div>
      <div className="matrix-scroll">
        <table className="matrix-table">
          <thead>
            <tr>
              <th>File</th>
              {destinations.map((d, i) => (
                <th key={i} className="dest-col">
                  <button className="select-all-col" onClick={() => selectAllForDest(d)}>
                    {d.binderName}
                    {d.folderName && ` / ${d.folderName}`}
                  </button>
                  <small className="dest-team-label">{d.teamName}</small>
                </th>
              ))}
              <th>
                <span className="select-label">All</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {readyFiles.map((f) => (
              <tr key={f.id}>
                <td className="file-col">{f.file.name}</td>
                {destinations.map((d, i) => (
                  <td key={i} className="check-col">
                    <input
                      type="checkbox"
                      checked={isChecked(f.id, d)}
                      onChange={() => toggle(f.id, d)}
                    />
                  </td>
                ))}
                <td className="check-col">
                  <button className="select-all-row" onClick={() => selectAllForFile(f.id)}>
                    {mappings.find((m) => m.fileId === f.id)?.destinations.length ===
                    destinations.length
                      ? 'None'
                      : 'All'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
