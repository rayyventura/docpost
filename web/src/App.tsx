import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { PageLoading } from './PageLoading';
import { LoginPage } from './auth/LoginPage';
import { RegisterPage } from './auth/RegisterPage';
import { ForgotPasswordPage } from './auth/ForgotPasswordPage';
import { ResetPasswordPage } from './auth/ResetPasswordPage';
import { DistributePage } from './jobs/DistributePage';
import { DestinationsPage } from './destinations/DestinationsPage';
import { JobDashboard } from './jobs/JobDashboard';
import { Layout } from './layout/Layout';
import type { ReactNode } from 'react';

function ProtectedLayout() {
  const { isAuthenticated, ready } = useAuth();
  const location = useLocation();
  if (!ready) {
    return <PageLoading label="Loading session" />;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

function PublicRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, ready } = useAuth();
  const location = useLocation();
  if (!ready) {
    return <PageLoading label="Loading session" />;
  }
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname;
  if (isAuthenticated) {
    return <Navigate to={from && from !== '/login' ? from : '/'} replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route
            path="/login"
            element={
              <PublicRoute>
                <LoginPage />
              </PublicRoute>
            }
          />
          <Route
            path="/register"
            element={
              <PublicRoute>
                <RegisterPage />
              </PublicRoute>
            }
          />
          <Route
            path="/forgot-password"
            element={
              <PublicRoute>
                <ForgotPasswordPage />
              </PublicRoute>
            }
          />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<ProtectedLayout />}>
            <Route path="/" element={<DistributePage />}>
              <Route index element={<DestinationsPage />} />
              <Route path="send" element={null} />
              <Route path="deliveries" element={<JobDashboard />} />
              <Route path="deliveries/:id" element={<JobDashboard />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
