import { useState, useCallback } from 'react';
import { NewJobPage } from './NewJobPage';
import { JobDashboard } from './JobDashboard';

type View = { mode: 'new' } | { mode: 'dashboard'; jobId?: string };

export function DistributePage() {
  const [view, setView] = useState<View>({ mode: 'new' });

  const handleJobCreated = useCallback((jobId: string) => {
    setView({ mode: 'dashboard', jobId });
  }, []);

  const handleNewDistribution = useCallback(() => {
    setView({ mode: 'new' });
  }, []);

  if (view.mode === 'dashboard') {
    return <JobDashboard jobId={view.jobId} onBack={handleNewDistribution} />;
  }

  return <NewJobPage onJobCreated={handleJobCreated} />;
}
