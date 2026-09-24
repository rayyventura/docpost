import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';

interface Team {
  id: string;
  name: string;
  region: string;
}

interface TeamListProps {
  onSelect: (teamId: string, teamName: string) => void;
}

export function TeamList({ onSelect }: TeamListProps) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function fetchTeams() {
      try {
        const data = await apiRequest<Team[]>('/destinations/teams');
        if (!cancelled) {
          setTeams(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load teams');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchTeams();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="loading-spinner" aria-label="Loading teams" />;
  }

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (teams.length === 0) {
    return <p className="empty-state">No teams found.</p>;
  }

  return (
    <ul className="item-list">
      {teams.map((team) => (
        <li key={team.id}>
          <button
            className="item-card"
            onClick={() => onSelect(team.id, team.name)}
          >
            <span className="item-icon" aria-hidden="true">&#x1F465;</span>
            <div className="item-info">
              <span className="item-name">{team.name}</span>
              <span className="item-badge">{team.region}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
