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
    <div className="files-stage">
      <DocumentsTree reveal={reveal} onSendHere={sendFilesHere} />
    </div>
  );
}
