import { useCallback } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { NewJobPage } from './NewJobPage';
import { JobDashboard } from './JobDashboard';
import { DestinationsPage } from '../destinations/DestinationsPage';

function tabClass(isActive: boolean): string {
  return `page-tab ${isActive ? 'page-tab--active' : ''}`;
}

export function DistributePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { jobId } = useParams<{ jobId: string }>();

  const activeTab = location.pathname.startsWith('/deliveries')
    ? 'deliveries'
    : location.pathname.startsWith('/send')
      ? 'new'
      : 'files';

  const handleJobCreated = useCallback((createdJobId: string) => {
    void navigate(`/deliveries/${createdJobId}`);
  }, [navigate]);

  return (
    <div className="distribute-page">
      <div className="page-tabs">
        <NavLink to="/" end className={({ isActive }) => tabClass(isActive)}>
          Files
        </NavLink>
        <NavLink to="/send" className={({ isActive }) => tabClass(isActive)}>
          Send
        </NavLink>
        <NavLink to="/deliveries" className={({ isActive }) => tabClass(isActive)}>
          Deliveries
        </NavLink>
      </div>

      <div className={`tab-panel ${activeTab === 'new' ? 'tab-panel--active' : ''}`}>
        <NewJobPage onJobCreated={handleJobCreated} />
      </div>
      <div className={`tab-panel ${activeTab === 'files' ? 'tab-panel--active' : ''}`}>
        <DestinationsPage />
      </div>
      <div className={`tab-panel ${activeTab === 'deliveries' ? 'tab-panel--active' : ''}`}>
        <JobDashboard jobId={jobId} onOpenFiles={() => void navigate('/')} />
      </div>
    </div>
  );
}
