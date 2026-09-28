import { useCallback, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { DocumentsTree } from './DocumentsTree';
import type { FilesLocationState, SendLocationState } from '../jobs/types';

function filesReveal(state: unknown): FilesLocationState | null {
  const files = state as FilesLocationState | null;
  if (!files?.teamId || !files.binderId || !files.teamName || !files.binderName) {
    return null;
  }
  return files;
}

export function DestinationsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const reveal = useMemo(() => filesReveal(location.state), [location.key, location.state]);
  const [sendTarget, setSendTarget] = useState<SendLocationState | null>(null);

  const handleActiveFolder = useCallback((target: SendLocationState | null) => {
    setSendTarget(target);
  }, []);

  const sendFilesHere = useCallback(() => {
    if (!sendTarget) return;
    void navigate('/send', { state: sendTarget });
  }, [navigate, sendTarget]);

  return (
    <div className="destinations-page">
      <p className="page-lead page-lead--single">
        Authorized users can download documents from this destination hierarchy. Expand a team, binder, or folder here — the rest of the tree stays visible so you can move between them.
      </p>
      <div className="destinations-toolbar">
        <p className="destinations-path">
          {sendTarget
            ? [sendTarget.destination.teamName, sendTarget.destination.binderName, sendTarget.destination.folderName]
                .filter(Boolean)
                .join(' / ')
            : 'Choose a folder to send documents into it.'}
        </p>
        {sendTarget && (
          <button type="button" className="btn btn-primary" onClick={sendFilesHere}>
            Send documents here
          </button>
        )}
      </div>

      <div className="destinations-content">
        <DocumentsTree reveal={reveal} onActiveFolderChange={handleActiveFolder} />
      </div>
    </div>
  );
}
