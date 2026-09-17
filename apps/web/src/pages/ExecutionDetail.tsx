import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ExecutionRecord, ExecutionStatus } from '../types';

function statusLabel(status: ExecutionStatus): string {
  switch (status) {
    case 'queued': return 'Queued';
    case 'executing': return 'Executing';
    case 'submitted': return 'Submitted';
    case 'confirmed': return 'Confirmed';
    case 'failed': return 'Failed';
    case 'dead_letter': return 'Dead Letter';
  }
}

function statusClass(status: ExecutionStatus): string {
  switch (status) {
    case 'queued': return 'badge-info';
    case 'executing': return 'badge-warn';
    case 'submitted': return 'badge-warn';
    case 'confirmed': return 'badge-ok';
    case 'failed': return 'badge-err';
    case 'dead_letter': return 'badge-err';
  }
}

function statusDescription(status: ExecutionStatus): string | null {
  switch (status) {
    case 'queued':
      return 'Execution is waiting in the queue.';
    case 'executing':
      return 'Execution is being processed by the worker.';
    case 'submitted':
      return 'Transaction submitted to Stellar. Waiting for on-chain confirmation.';
    case 'confirmed':
      return 'Transaction confirmed on-chain.';
    case 'failed':
      return 'Transaction failed on-chain.';
    case 'dead_letter':
      return 'Execution failed and will not be retried automatically.';
  }
}

export default function ExecutionDetail({ executionId, onBack }: { executionId: string; onBack?: () => void }) {
  const [execution, setExecution] = useState<ExecutionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getExecution(executionId)
      .then((r) => setExecution(r.execution))
      .catch((e: any) => setError(e.message ?? 'Failed to load execution'))
      .finally(() => setLoading(false));
  }, [executionId]);

  if (loading) return <Skeleton label="Loading execution..." />;
  if (error) return <EmptyState title="Failed to load execution" message={error} />;
  if (!execution) return <EmptyState title="Execution not found" message="This execution does not exist or you do not have access." />;

  const desc = statusDescription(execution.status);

  return (
    <section>
      <h1>
        {onBack && <button onClick={onBack} style={{ marginRight: 8 }}>←</button>}
        Execution <code>{execution.id.slice(0, 8)}</code>
      </h1>

      <div className="detail-grid">
        <DetailCard title="Status">
          <span className={`badge ${statusClass(execution.status)}`}>
            {statusLabel(execution.status)}
          </span>
          {desc && <p className="status-desc">{desc}</p>}
        </DetailCard>
        <DetailCard title="Agent"><code>{execution.agentId}</code></DetailCard>
        <DetailCard title="Intent">{execution.intent.type}</DetailCard>
        <DetailCard title="Amount">
          {execution.intent.type === 'payment'
            ? `${execution.intent.amount} ${(execution.intent.assetDetails as { code?: string } | undefined)?.code ?? execution.intent.asset}`
            : '-'}
        </DetailCard>
        <DetailCard title="Transaction Hash">
          {execution.txHash ? <code className="copyable" title="Click to copy" onClick={() => navigator.clipboard?.writeText(execution.txHash as string)}>{(execution.txHash as string).slice(0, 12)}…{(execution.txHash as string).slice(-8)}</code> : '-'}
        </DetailCard>
        <DetailCard title="Attempt">
          {execution.attempt > 0 ? String(execution.attempt) : '-'}
        </DetailCard>
        <DetailCard title="Created">{new Date(execution.createdAt).toLocaleString()}</DetailCard>
        <DetailCard title="Updated">{new Date(execution.updatedAt).toLocaleString()}</DetailCard>
        <DetailCard title="Started">
          {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : '-'}
        </DetailCard>
        <DetailCard title="Completed">
          {execution.completedAt ? new Date(execution.completedAt).toLocaleString() : '-'}
        </DetailCard>
        <DetailCard title="Error">
          {execution.error ?? '-'}
        </DetailCard>
      </div>
    </section>
  );
}

function DetailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="detail-card">
      <div className="detail-card-title">{title}</div>
      <div className="detail-card-value">{children}</div>
    </div>
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
