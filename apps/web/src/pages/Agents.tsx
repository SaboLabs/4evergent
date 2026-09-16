import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentRecord } from '../types';

export default function Agents({ onAgentClick }: { onAgentClick?: (agentId: string) => void }) {
  const [agents, setAgents] = useState<AgentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = () => {
    api.listAgents()
      .then((a) => setAgents(a.agents))
      .catch((e: any) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    if (!name.trim()) { setCreateError('Name is required'); return; }
    setCreating(true);
    try {
      const caps = capabilities.trim() ? capabilities.split(',').map((c) => c.trim()).filter(Boolean) : [];
      const res = await api.createAgent({ displayName: name.trim(), description: description.trim() || undefined, capabilities: caps.length ? caps : undefined });
      setName('');
      setDescription('');
      setCapabilities('');
      setShowCreate(false);
      setAgents((prev) => [...(prev ?? []), res.agent]);
      onAgentClick?.(res.agent.id);
    } catch (e: any) {
      setCreateError(e.message);
    } finally {
      setCreating(false);
    }
  };

  if (error) return <EmptyState title="Failed to load agents" message={error} />;
  if (agents === null) return <Skeleton label="Loading agents..." />;

  return (
    <section>
      <h1>Agents</h1>
      {agents.length === 0 && !showCreate ? (
        <div className="empty-state">
          <h2>No agents yet</h2>
          <p>Create your first agent to start submitting intents and schedules.</p>
          <button onClick={() => setShowCreate(true)}>Create Agent</button>
        </div>
      ) : (
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
      )}

      {agents.length > 0 && !showCreate && (
        <button onClick={() => setShowCreate(true)}>Create Agent</button>
      )}

      {showCreate && (
        <div className="modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Create Agent</h2>
            <form onSubmit={handleCreate}>
              <label>
                Name
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Agent"
                  required
                />
              </label>
              <label>
                Description
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional description"
                />
              </label>
              <label>
                Capabilities (comma-separated)
                <input
                  type="text"
                  value={capabilities}
                  onChange={(e) => setCapabilities(e.target.value)}
                  placeholder="payment"
                />
              </label>
              {createError && <div className="error">{createError}</div>}
              <div className="form-actions">
                <button type="button" onClick={() => setShowCreate(false)} disabled={creating}>Cancel</button>
                <button type="submit" disabled={creating}>{creating ? 'Creating...' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
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
