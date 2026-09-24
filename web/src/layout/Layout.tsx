import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuth();
  const location = useLocation();

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-inner">
          <h1 className="app-title">DocPost</h1>
          <nav className="header-nav">
            <Link to="/" className={`nav-link ${location.pathname === '/' ? 'active' : ''}`}>
              Distribute
            </Link>
            <Link
              to="/destinations"
              className={`nav-link ${location.pathname === '/destinations' ? 'active' : ''}`}
            >
              Browse
            </Link>
          </nav>
          {user && (
            <div className="header-user">
              <span className="user-name">{user.name}</span>
              <button className="btn btn-outline" onClick={logout}>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="app-main">
        {children}
      </main>
    </div>
  );
}
