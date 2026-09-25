import { useState, useCallback } from 'react';
import { NewJobPage } from './NewJobPage';
import { JobDashboard } from './JobDashboard';

type Tab = 'new' | 'deliveries';

export function DistributePage() {
  const [activeTab, setActiveTab] = useState<Tab>('new');
  const [focusJobId, setFocusJobId] = useState<string | undefined>();

  const handleJobCreated = useCallback((jobId: string) => {
    setFocusJobId(jobId);
    setActiveTab('deliveries');
  }, []);

  return (
    <div className="distribute-page">
      <div className="page-tabs">
        <button
          className={`page-tab ${activeTab === 'new' ? 'page-tab--active' : ''}`}
          onClick={() => setActiveTab('new')}
        >
          New Distribution
        </button>
        <button
          className={`page-tab ${activeTab === 'deliveries' ? 'page-tab--active' : ''}`}
          onClick={() => {
            setFocusJobId(undefined);
            setActiveTab('deliveries');
          }}
        >
          Deliveries
        </button>
      </div>

      <div className={`tab-panel ${activeTab === 'new' ? 'tab-panel--active' : ''}`}>
        <NewJobPage onJobCreated={handleJobCreated} />
      </div>
      <div className={`tab-panel ${activeTab === 'deliveries' ? 'tab-panel--active' : ''}`}>
        <JobDashboard jobId={focusJobId} />
      </div>
    </div>
  );
}
