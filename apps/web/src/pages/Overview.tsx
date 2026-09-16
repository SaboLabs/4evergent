import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentRecord } from '../types';

export default function Overview() {
  const [health, setHealth] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [h, a] = await Promise.all([api.health(), api.listAgents()]);
        setHealth(h.signerAccountId);
        setAgents(a.agents);
      } catch (e: any) {
        setError(e.message ?? 'Failed to fetch');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Skeleton label="Connecting to API..." />;
  if (error) return <EmptyState title="API Unavailable" message={error} />;

  return (
    <section>
      <h1>Overview</h1>
      <div className="cards">
        <Card title="Signer Account" value={health ?? 'unknown'} />
        <Card title="Agents" value={String(agents?.length ?? 0)} />
        <Card title="Network" value="Testnet" />
        <Card title="Pipeline" value="Active" />
      </div>
      {agents && agents.length > 0 && (
        <div className="block">
          <h2>Agents</h2>
          <table>
            <thead>
              <tr><th>ID</th><th>Name</th><th>Status</th></tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id}>
                  <td><code>{a.id}</code></td>
                  <td>{a.displayName}</td>
                  <td><Badge status={a.active ? 'active' : 'inactive'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

export function Badge({ status }: { status: string }) {
  const cls = `badge badge-${status === 'active' ? 'ok' : status === 'failed' || status === 'rejected' ? 'err' : 'info'}`;
  return <span className={cls}>{status}</span>;
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
