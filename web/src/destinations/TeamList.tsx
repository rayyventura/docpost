import { useState, useEffect } from 'react';
import { apiRequest } from '../api/client';
import { ContentReveal } from '../ContentReveal';
import { PageLoading } from '../PageLoading';
import { TeamIcon } from './TeamIcon';

interface Team {
  id: string;
  name: string;
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
    return <PageLoading label="Loading teams" />;
  }

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  if (teams.length === 0) {
    return (
      <ContentReveal>
        <p className="empty-state">You are not on a team yet, so there is nowhere to file documents.</p>
      </ContentReveal>
    );
  }

  return (
    <ContentReveal>
    <ul className="item-list">
      {teams.map((team) => (
        <li key={team.id}>
          <button
            className="item-card"
            onClick={() => onSelect(team.id, team.name)}
          >
            <span className="item-icon item-icon--team" aria-hidden="true">
              <TeamIcon />
            </span>
            <div className="item-info">
              <span className="item-name">{team.name}</span>
            </div>
          </button>
        </li>
      ))}
    </ul>
    </ContentReveal>
  );
}
