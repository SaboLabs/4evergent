import { useEffect, useState } from 'react';
import { api } from '../api';

export default function Overview() {
  const [health, setHealth] = useState<string | null>(null);
  const [agents, setAgents] = useState<any[] | null>(null);
  const [approvals, setApprovals] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [h, a, ap] = await Promise.all([
          api.health(),
          api.listAgents(),
          api.listApprovals('pending_approval'),
        ]);
        setHealth(h.signerAccountId);
        setAgents(a.agents);
        setApprovals(ap.approvals);
      } catch (e: any) {
        setError(e.message ?? 'Failed to fetch');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Skeleton label="Connecting to API..." />;
  if (error) return <EmptyState title="API Unavailable" message={error} />;

  const activeAgents = agents?.filter((a) => a.status === 'active').length ?? 0;
  const pausedAgents = agents?.filter((a) => a.status === 'paused').length ?? 0;
  const disabledAgents = agents?.filter((a) => a.status === 'disabled').length ?? 0;
  const pendingApprovals = approvals?.length ?? 0;

  return (
    <section>
      <h1>Overview</h1>
      <div className="cards">
        <Card title="Signer Account" value={health ? health.slice(0, 12) + '...' : 'unknown'} />
        <Card title="Active Agents" value={String(activeAgents)} />
        <Card title="Paused Agents" value={String(pausedAgents)} />
        <Card title="Disabled Agents" value={String(disabledAgents)} />
        <Card title="Pending Approvals" value={String(pendingApprovals)} />
      </div>
    </section>
  );
}

export function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
    </div>
  );
}

export function Skeleton({ label }: { label: string }) {
  return <div className="skeleton">{label}</div>;
}

export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}
