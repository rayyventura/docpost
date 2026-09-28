import { useCallback, useMemo } from 'react';
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

  const sendFilesHere = useCallback((target: SendLocationState) => {
    void navigate('/send', { state: target });
  }, [navigate]);

  return (
    <div className="destinations-page">
      <p className="page-lead page-lead--single">
        Authorized users can download documents from this destination hierarchy. Expand a team, binder, or folder here. The rest of the tree stays visible so you can move between them.
      </p>
      <div className="destinations-content">
        <DocumentsTree reveal={reveal} onSendHere={sendFilesHere} />
      </div>
    </div>
  );
}
