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
    case 'submitted': return 'badge-ok';
    case 'confirmed': return 'badge-ok';
    case 'failed': return 'badge-err';
    case 'dead_letter': return 'badge-err';
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

  const isRetrying = execution.status === 'failed' && execution.nextRetryAt !== null && execution.errorClass === 'transient';
  const statusDisplay = isRetrying ? 'Retrying' : statusLabel(execution.status);
  const statusCls = isRetrying ? 'badge-warn' : statusClass(execution.status);

  return (
    <section>
      <h1>
        {onBack && <button onClick={onBack} style={{ marginRight: 8 }}>←</button>}
        Execution <code>{execution.id.slice(0, 8)}</code>
      </h1>

      <div className="detail-grid">
        <DetailCard title="Status">
          <span className={`badge ${statusCls}`}>{statusDisplay}</span>
          {execution.status === 'dead_letter' && (
            <p className="warning">This execution will not be retried automatically.</p>
          )}
        </DetailCard>
        <DetailCard title="Agent"><code>{execution.agentId}</code></DetailCard>
        <DetailCard title="Intent">{execution.intent.type}</DetailCard>
        <DetailCard title="Amount">
          {execution.intent.type === 'payment'
            ? `${execution.intent.amount} ${(execution.intent.assetDetails as { code?: string } | undefined)?.code ?? execution.intent.asset}`
            : '-'}
        </DetailCard>
        <DetailCard title="Attempt">
          {execution.attempt > 0 ? String(execution.attempt) : '-'}
        </DetailCard>
        <DetailCard title="Next Retry">
          {execution.nextRetryAt ? new Date(execution.nextRetryAt).toLocaleString() : '-'}
        </DetailCard>
        <DetailCard title="Created">{new Date(execution.createdAt).toLocaleString()}</DetailCard>
        <DetailCard title="Updated">{new Date(execution.updatedAt).toLocaleString()}</DetailCard>
        <DetailCard title="Started">
          {execution.startedAt ? new Date(execution.startedAt).toLocaleString() : '-'}
        </DetailCard>
        <DetailCard title="Completed">
          {execution.completedAt ? new Date(execution.completedAt).toLocaleString() : '-'}
        </DetailCard>
        <DetailCard title="Transaction Hash">
          {execution.txHash ? <code>{execution.txHash}</code> : '-'}
        </DetailCard>
        <DetailCard title="Error">
          {execution.error ?? '-'}
        </DetailCard>
      </div>

      {execution.error && (
        <div className="block">
          <h2>Error Details</h2>
          <div className="error-display">{execution.error}</div>
        </div>
      )}
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
