import { useState, useCallback } from 'react';
import { TeamList } from './TeamList';
import { BinderList } from './BinderList';
import { FolderContents } from './FolderContents';

interface BreadcrumbItem {
  label: string;
  level: 'teams' | 'binders' | 'contents';
  id?: string;
}

export function DestinationsPage() {
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([
    { label: 'Teams', level: 'teams' },
  ]);

  const current = breadcrumb[breadcrumb.length - 1];

  const selectTeam = useCallback((teamId: string, teamName: string) => {
    setBreadcrumb((prev) => [
      ...prev,
      { label: teamName, level: 'binders', id: teamId },
    ]);
  }, []);

  const selectBinder = useCallback((binderId: string, binderName: string) => {
    setBreadcrumb((prev) => [
      ...prev,
      { label: binderName, level: 'contents', id: binderId },
    ]);
  }, []);

  const selectFolder = useCallback((folderId: string, folderName: string) => {
    setBreadcrumb((prev) => [
      ...prev,
      { label: folderName, level: 'contents', id: folderId },
    ]);
  }, []);

  const navigateTo = useCallback((index: number) => {
    setBreadcrumb((prev) => prev.slice(0, index + 1));
  }, []);

  // Determine if we are looking at binder contents or folder contents
  // Binder contents: breadcrumb length === 3 (Teams > Team > Binder)
  // Folder contents: breadcrumb length > 3
  const isBinderContents = breadcrumb.length === 3;

  return (
    <div className="destinations-page">
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
