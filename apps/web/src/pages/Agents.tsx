import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentRecord } from '../types';

export default function Agents({ onAgentClick }: { onAgentClick?: (agentId: string) => void }) {
  const [agents, setAgents] = useState<AgentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents()
      .then((a) => setAgents(a.agents))
      .catch((e: any) => setError(e.message));
  }, []);

  if (error) return <EmptyState title="Failed to load agents" message={error} />;
  if (agents === null) return <Skeleton label="Loading agents..." />;
  if (agents.length === 0) return <EmptyState title="No agents" message="Register an agent on the backend to see it here." />;

  return (
    <section>
      <h1>Agents</h1>
      <table>
        <thead>
          <tr><th>ID</th><th>Name</th><th>Address</th><th>Capabilities</th><th>Status</th></tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id} onClick={() => onAgentClick?.(a.id)} style={{ cursor: onAgentClick ? 'pointer' : undefined }}>
              <td><code>{a.id}</code></td>
              <td>{a.displayName}</td>
              <td><code>{a.stellarAddress}</code></td>
              <td>{a.capabilities.join(', ')}</td>
              <td><StatusBadge status={a.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'badge-ok'
    : status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return <span className={'badge ' + cls}>{status}</span>;
}

function Skeleton({ label }: { label: string }) {
  return <div className="skeleton">{label}</div>;
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
    </div>
  );
}
