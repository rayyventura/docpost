import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';
import { PasswordInput } from './PasswordInput';
import { Link, useNavigate } from 'react-router-dom';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-branding">
        <h1 className="auth-brand-title">DocPost</h1>
        <p className="auth-brand-tagline">Healthcare Distributed Document Delivery Platform</p>
      </div>
      <div className="auth-card">
        <h2>Sign In</h2>
        <p className="auth-subtitle">Welcome back to DocPost</p>

        {error && <div className="error-banner">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              autoFocus
            />
          </div>

          <div className="form-field">
            <label htmlFor="password">Password</label>
            <PasswordInput
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your password"
              required
              autoComplete="current-password"
            />
          </div>

          <p className="auth-forgot">
            <Link to="/forgot-password">Forgot password?</Link>
          </p>

          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <p className="auth-footer">
          Don&apos;t have an account? <Link to="/register">Create one</Link>
        </p>
      </div>
    </div>
  );
}
