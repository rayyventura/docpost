import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';
import { ContentReveal } from '../ContentReveal';
import { PageLoading } from '../PageLoading';
import { BinderIcon } from './BinderIcon';

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
      setLoading(true);
      setError('');
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
    return <PageLoading label="Loading binders" />;
  }

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (binders.length === 0) {
    return (
      <ContentReveal>
        <p className="empty-state">This team has no binders yet.</p>
      </ContentReveal>
    );
  }

  return (
    <ContentReveal>
    <ul className="item-list">
      {binders.map((binder) => (
        <li key={binder.id}>
          <button
            className="item-card"
            onClick={() => onSelect(binder.id, binder.name)}
          >
            <span className="item-icon item-icon--binder" aria-hidden="true">
              <BinderIcon />
            </span>
            <div className="item-info">
              <span className="item-name">{binder.name}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
    </ContentReveal>
  );
}
