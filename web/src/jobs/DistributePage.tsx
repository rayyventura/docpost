import { NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { NewJobPage } from './NewJobPage';

function tabClass(isActive: boolean): string {
  return `page-tab ${isActive ? 'page-tab--active' : ''}`;
}

export function DistributePage() {
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const onSend = location.pathname === '/send';

  return (
    <div className="distribute-page">
      <div className="page-tabs">
        <NavLink to="/" end className={({ isActive }) => tabClass(isActive)}>
          Files
        </NavLink>
        <NavLink to="/send" className={({ isActive }) => tabClass(isActive)}>
          Send
        </NavLink>
        <NavLink
          to={id ? `/deliveries/${id}` : '/deliveries'}
          className={({ isActive }) => tabClass(isActive)}
        >
          Deliveries
        </NavLink>
      </div>

      <div className={`tab-panel ${onSend ? 'tab-panel--active' : ''}`}>
        <NewJobPage />
      </div>
      {!onSend && (
        <div className="tab-panel tab-panel--active">
          <Outlet />
        </div>
      )}
    </div>
  );
}
