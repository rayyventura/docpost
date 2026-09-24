import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuth();

  return (
    <div className="app-layout">
      <header className="app-header">
        <div className="header-inner">
          <h1 className="app-title">DocPost</h1>
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
