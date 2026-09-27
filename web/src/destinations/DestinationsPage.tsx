import { useState, useCallback, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { TeamList } from './TeamList';
import { BinderList } from './BinderList';
import { FolderContents } from './FolderContents';
import type { Destination, FilesLocationState, SendLocationState } from '../jobs/types';

interface BreadcrumbItem {
  label: string;
  level: 'teams' | 'binders' | 'contents';
  id?: string;
  teamId?: string;
  teamName?: string;
  binderId?: string;
  binderName?: string;
  folderId?: string;
  folderName?: string;
}

function breadcrumbFromFilesState(state: unknown): BreadcrumbItem[] {
  const files = state as FilesLocationState | null;
  if (!files?.teamId || !files.binderId || !files.teamName || !files.binderName) {
    return [{ label: 'Teams', level: 'teams' }];
  }

  return [
    { label: 'Teams', level: 'teams' },
    {
      label: files.teamName,
      level: 'binders',
      id: files.teamId,
      teamId: files.teamId,
      teamName: files.teamName,
    },
    {
      label: files.binderName,
      level: 'contents',
      id: files.binderId,
      teamId: files.teamId,
      teamName: files.teamName,
      binderId: files.binderId,
      binderName: files.binderName,
    },
    ...(files.folderPath ?? []).map((folder) => ({
      label: folder.name,
      level: 'contents' as const,
      id: folder.id,
      teamId: files.teamId,
      teamName: files.teamName,
      binderId: files.binderId,
      binderName: files.binderName,
      folderId: folder.id,
      folderName: folder.name,
    })),
  ];
}

export function DestinationsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>(() =>
    breadcrumbFromFilesState(location.state),
  );

  useEffect(() => {
    setBreadcrumb(breadcrumbFromFilesState(location.state));
  }, [location.key]);

  const current = breadcrumb[breadcrumb.length - 1];

  const selectTeam = useCallback((teamId: string, teamName: string) => {
    setBreadcrumb((prev) => [
      ...prev,
      { label: teamName, level: 'binders', id: teamId, teamId, teamName },
    ]);
  }, []);

  const selectBinder = useCallback((binderId: string, binderName: string) => {
    setBreadcrumb((prev) => {
      const team = prev.find((item) => item.level === 'binders');
      return [
        ...prev,
        {
          label: binderName,
          level: 'contents',
          id: binderId,
          teamId: team?.teamId,
          teamName: team?.teamName,
          binderId,
          binderName,
        },
      ];
    });
  }, []);

  const selectFolder = useCallback((folderId: string, folderName: string) => {
    setBreadcrumb((prev) => {
      const parent = prev[prev.length - 1];
      return [
        ...prev,
        {
          label: folderName,
          level: 'contents',
          id: folderId,
          teamId: parent.teamId,
          teamName: parent.teamName,
          binderId: parent.binderId,
          binderName: parent.binderName,
          folderId,
          folderName,
        },
      ];
    });
  }, []);

  const navigateTo = useCallback((index: number) => {
    setBreadcrumb((prev) => prev.slice(0, index + 1));
  }, []);

  const isBinderContents = current.level === 'contents' && !current.folderId;

  const sendTarget = useMemo((): SendLocationState | null => {
    if (current.level !== 'contents' || !current.teamId || !current.binderId || !current.teamName || !current.binderName) {
      return null;
    }

    const destination: Destination = {
      teamId: current.teamId,
      teamName: current.teamName,
      binderId: current.binderId,
      binderName: current.binderName,
      ...(current.folderId && current.folderName
        ? { folderId: current.folderId, folderName: current.folderName }
        : {}),
    };

    const folderPath = breadcrumb
      .map((item) => item.folderId)
      .filter((id): id is string => Boolean(id));

    return { destination, folderPath };
  }, [breadcrumb, current]);

  const sendFilesHere = useCallback(() => {
    if (!sendTarget) return;
    void navigate('/send', { state: sendTarget });
  }, [navigate, sendTarget]);

  return (
    <div className="destinations-page">
      <p className="page-lead page-lead--single">Sent documents are stored in this destination hierarchy. Open a team, then a binder or folder, to find one.</p>
      <div className="destinations-toolbar">
        <nav className="breadcrumb" aria-label="Navigation">
          {breadcrumb.map((item, index) => {
            const isLast = index === breadcrumb.length - 1;
            return (
              <span key={index} className="breadcrumb-item">
                {index > 0 && <span className="breadcrumb-separator">/</span>}
                {isLast ? (
                  <span className="breadcrumb-current">{item.label}</span>
                ) : (
                  <button
                    className="breadcrumb-link"
                    onClick={() => navigateTo(index)}
                  >
                    {item.label}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        {sendTarget && (
          <button type="button" className="btn btn-primary" onClick={sendFilesHere}>
            Send files here
          </button>
        )}
      </div>

      <div className="destinations-content">
        {current.level === 'teams' && (
          <TeamList onSelect={selectTeam} />
        )}
        {current.level === 'binders' && current.id && (
          <BinderList teamId={current.id} onSelect={selectBinder} />
        )}
        {current.level === 'contents' && current.id && (
          <FolderContents
            id={current.id}
            type={isBinderContents ? 'binder' : 'folder'}
            onSelectFolder={selectFolder}
          />
        )}
      </div>
    </div>
  );
}
