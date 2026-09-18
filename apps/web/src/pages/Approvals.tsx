import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ApprovalRecord } from '../types';

export default function Approvals() {
  const [approvals, setApprovals] = useState<ApprovalRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const load = () => {
    api.listApprovals('pending_approval')
      .then((r) => setApprovals(r.approvals))
      .catch((e: any) => setError(e.message));
  };

  useEffect(() => { load(); }, []);

  if (error) return <EmptyState title="Failed to load approvals" message={error} />;
  if (approvals === null) return <Skeleton label="Loading approvals..." />;
  if (approvals.length === 0) return (
    <EmptyState
      title="No pending approvals"
      message="Approvals requiring action will appear here."
    />
  );

  return (
    <section>
      <h1>Pending Approvals</h1>
      <table>
        <thead>
          <tr><th>ID</th><th>Agent</th><th>Intent</th><th>Amount</th><th>Expires</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {approvals.map((a) => (
            <tr key={a.id}>
              <td><code>{a.id.slice(0, 8)}</code></td>
              <td><code>{a.agentId}</code></td>
              <td>{a.intent.type}</td>
              <td>{a.intent.amount || '-'} {a.intent.asset || ''}</td>
              <td>{a.expiresAt ? new Date(a.expiresAt).toLocaleString() : 'no expiry'}</td>
              <td>
                <button
                  disabled={loadingId === a.id}
                  onClick={() => { setLoadingId(a.id); api.approve(a.id).finally(() => setLoadingId(null)); }}
                >
                  {loadingId === a.id ? 'Processing...' : 'Approve'}
                </button>
                {' '}
                <button
                  disabled={loadingId === a.id}
                  onClick={() => {
                    if (!confirm('Reject this approval? This cannot be undone.')) return;
                    setLoadingId(a.id);
                    api.reject(a.id).finally(() => setLoadingId(null));
                  }}
                >
                  Reject
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
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
