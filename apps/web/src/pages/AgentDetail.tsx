import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentRecord, ActivityRecord } from '../types';

export default function AgentDetail({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [activity, setActivity] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [a, act] = await Promise.all([
          api.getAgent(agentId),
          api.agentActivity(agentId, 20),
        ]);
        setAgent(a);
        setActivity(act.activity);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [agentId]);

  if (loading) {
    return <Skeleton label="Loading agent..." />;
  }
  if (error) {
    return <EmptyState title="Failed to load agent" message={error} />;
  }
  if (!agent) {
    return (
      <div className="empty-state">
        <h2>Agent not found</h2>
        <p>This agent does not exist or you do not have access.</p>
      </div>
    );
  }

  return (
    <section>
      <h1>{agent.displayName}</h1>
      <div className="cards">
        <Card title="ID" value={agent.id} />
        <Card title="Status" value={agent.status} />
        <Card title="Address" value={agent.stellarAddress.slice(0, 12) + '...'} />
        <Card title="Capabilities" value={agent.capabilities.join(', ')} />
      </div>
      <div className="block">
        <h2>Recent Activity</h2>
        {activity === null ? (
          <Skeleton label="Loading activity..." />
        ) : activity.length === 0 ? (
          <div className="empty-state">
            <p>This agent has no activity yet.</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>ID</th><th>Type</th><th>Amount</th><th>Status</th><th>Time</th></tr>
            </thead>
            <tbody>
              {activity.map((r) => (
                <tr key={r.id}>
                  <td><code>{r.id.slice(0, 8)}</code></td>
                  <td>{r.intent.type}</td>
                  <td>{r.intent.amount || '-'} {r.intent.asset || ''}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

function Card({ title, value }: { title: string; value: string }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="card-value">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'submitted' ? 'badge-ok'
    : status === 'failed' || status === 'rejected' ? 'badge-err'
    : 'badge-info';
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
