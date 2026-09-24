import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface Binder {
  id: string;
  name: string;
}

interface BinderListProps {
  teamId: string;
  onSelect: (binderId: string, binderName: string) => void;
}

export function BinderList({ teamId, onSelect }: BinderListProps) {
  const [binders, setBinders] = useState<Binder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function fetchBinders() {
      try {
        const data = await apiRequest<Binder[]>(`/destinations/teams/${teamId}/binders`);
        if (!cancelled) {
          setBinders(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load binders');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchBinders();
    return () => { cancelled = true; };
  }, [teamId]);

  if (loading) {
    return <div className="loading-spinner" aria-label="Loading binders" />;
  }

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (binders.length === 0) {
    return <p className="empty-state">No binders found in this team.</p>;
  }

  return (
    <ul className="item-list">
      {binders.map((binder) => (
        <li key={binder.id}>
          <button
            className="item-card"
            onClick={() => onSelect(binder.id, binder.name)}
          >
            <span className="item-icon" aria-hidden="true">&#x1F4DA;</span>
            <div className="item-info">
              <span className="item-name">{binder.name}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
