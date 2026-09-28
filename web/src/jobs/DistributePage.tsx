import { useState } from 'react';
import { NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { SidebarTreeSlotProvider } from '../layout/SidebarTree';
import { NewJobPage } from './NewJobPage';

function navClass(isActive: boolean): string {
  return `rail-link ${isActive ? 'rail-link--active' : ''}`;
}

export function DistributePage() {
  const location = useLocation();
  const { id } = useParams<{ id: string }>();
  const { user, logout } = useAuth();
  const [docsSlot, setDocsSlot] = useState<HTMLElement | null>(null);
  const [sendSlot, setSendSlot] = useState<HTMLElement | null>(null);
  const onSend = location.pathname === '/send';
  const onAudit = location.pathname.startsWith('/deliveries');
  const onDocuments = !onSend && !onAudit;

  return (
    <SidebarTreeSlotProvider docs={docsSlot} send={sendSlot}>
      <div className={`workspace${onAudit ? ' workspace--audit' : ''}`}>
        <aside className="workspace-rail">
          <div className="rail-brand">
            <img src="/favicon.png" alt="" width="28" height="28" />
            <span>DocPost</span>
          </div>
          <nav className="rail-nav" aria-label="Primary">
            <NavLink to="/" end className={({ isActive }) => navClass(isActive)}>
              Documents
            </NavLink>
            <NavLink to="/send" className={({ isActive }) => navClass(isActive)}>
              Distribute documents
            </NavLink>
            <NavLink
              to={id ? `/deliveries/${id}` : '/deliveries'}
              className={({ isActive }) => navClass(isActive)}
            >
              Audit trail
            </NavLink>
          </nav>
          <div className={`rail-tree-host${onAudit ? ' rail-tree-host--empty' : ''}`}>
            <div
              className={`rail-tree${onDocuments ? '' : ' rail-tree--hidden'}`}
              ref={setDocsSlot}
            />
            <div
              className={`rail-tree${onSend ? '' : ' rail-tree--hidden'}`}
              ref={setSendSlot}
            />
          </div>
          {user && (
            <div className="rail-user">
              <div className="rail-user-meta">
                <span className="rail-user-name">{user.name}</span>
                <span className="rail-user-email">{user.email}</span>
              </div>
              <button type="button" className="rail-signout" onClick={logout}>
                Sign out
              </button>
            </div>
          )}
        </aside>
        <div className="workspace-stage">
          <div className={`stage-panel ${onSend ? 'stage-panel--active' : ''}`}>
            <NewJobPage />
          </div>
          {!onSend && (
            <div className="stage-panel stage-panel--active">
              <Outlet />
            </div>
          )}
        </div>
      </div>
    </SidebarTreeSlotProvider>
  );
}
