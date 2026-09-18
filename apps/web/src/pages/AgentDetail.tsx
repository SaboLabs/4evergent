import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AgentRecord, ActivityRecord, PolicyRules } from '../types';
import { ScheduleList } from './ScheduleList';
import { ExecutionList } from './ExecutionList';

const DEFAULT_POLICY: PolicyRules = {
  maxTxAmount: { XLM: '100' },
  dailySpendingLimit: { XLM: '500' },
  allowedAssets: ['XLM'],
  allowedDestinations: [],
  allowedContractIds: [],
  txTypeRestrictions: {
    payment: true,
    trustline: true,
    contract_call: false,
    account_settings: false,
  },
  approvalThreshold: '50',
  requireHumanApprovalForAmountAbove: '50',
};

function deepClonePolicy(policy: PolicyRules): PolicyRules {
  return {
    maxTxAmount: { ...policy.maxTxAmount },
    dailySpendingLimit: { ...policy.dailySpendingLimit },
    allowedAssets: [...policy.allowedAssets],
    allowedDestinations: [...policy.allowedDestinations],
    allowedContractIds: [...policy.allowedContractIds],
    txTypeRestrictions: { ...policy.txTypeRestrictions },
    approvalThreshold: policy.approvalThreshold,
    requireHumanApprovalForAmountAbove: policy.requireHumanApprovalForAmountAbove,
  };
}

function PolicySettings({ agentId }: { agentId: string }) {
  const [policy, setPolicy] = useState<PolicyRules | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [form, setForm] = useState<PolicyRules | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await api.getPolicy(agentId);
        if (cancelled) return;
        setPolicy(deepClonePolicy(res.policy));
        setForm(deepClonePolicy(res.policy));
        setVersion(res.version);
        setUpdatedAt(res.updatedAt);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to load policy');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  const updateForm = (patch: Partial<PolicyRules>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateAmountField = (
    field: 'maxTxAmount' | 'dailySpendingLimit',
    asset: string,
    value: string,
  ) => {
    setForm((prev) => {
      if (!prev) return prev;
      const next = { ...prev[field] };
      if (value.trim() === '') {
        delete next[asset];
      } else {
        next[asset] = value;
      }
      return { ...prev, [field]: next };
    });
  };

  const addListItem = (field: 'allowedAssets' | 'allowedDestinations' | 'allowedContractIds', value: string) => {
    if (!value.trim()) return;
    setForm((prev) => {
      if (!prev) return prev;
      if (prev[field].includes(value.trim())) return prev;
      return { ...prev, [field]: [...prev[field], value.trim()] };
    });
  };

  const removeListItem = (field: 'allowedAssets' | 'allowedDestinations' | 'allowedContractIds', value: string) => {
    setForm((prev) => {
      if (!prev) return prev;
      return { ...prev, [field]: prev[field].filter((v) => v !== value) };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await api.updatePolicy(agentId, form);
      setPolicy(deepClonePolicy(res.policy));
      setForm(deepClonePolicy(res.policy));
      setVersion(res.version);
      setUpdatedAt(new Date().toISOString());
      setSuccess(`Policy updated (version ${res.version})`);
    } catch (e: any) {
      setError(e.message ?? 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Skeleton label="Loading policy..." />;
  if (error && !form) return <div className="error">{error}</div>;
  if (!form) return <div className="error">Unable to load policy</div>;

  const isDirty =
    policy && JSON.stringify(form) !== JSON.stringify(policy);

  return (
    <form onSubmit={handleSave} className="policy-form">
      {error && <div className="error">{error}</div>}
      {success && <div className="success">{success}</div>}

      <div className="policy-section">
        <h3>Limits</h3>
        <div className="form-grid">
          <label>
            <span>Max Transaction Amount (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.maxTxAmount.XLM ?? ''}
              onChange={(e) => updateAmountField('maxTxAmount', 'XLM', e.target.value)}
              placeholder="100"
            />
            <small>Maximum amount allowed for a single intent. Transactions above this are denied.</small>
          </label>
          <label>
            <span>Daily Spending Limit (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.dailySpendingLimit.XLM ?? ''}
              onChange={(e) => updateAmountField('dailySpendingLimit', 'XLM', e.target.value)}
              placeholder="500"
            />
            <small>Aggregate daily spending limit enforced by backend. Once reached, further intents are denied until the next day.</small>
          </label>
          <label>
            <span>Approval Threshold (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.approvalThreshold}
              onChange={(e) => updateForm({ approvalThreshold: e.target.value })}
              placeholder="50"
            />
            <small>Intents above this amount require human approval before execution.</small>
          </label>
          <label>
            <span>Require Human Approval Above (XLM)</span>
            <input
              type="number"
              step="0.0000001"
              min="0"
              value={form.requireHumanApprovalForAmountAbove}
              onChange={(e) => updateForm({ requireHumanApprovalForAmountAbove: e.target.value })}
              placeholder="50"
            />
            <small>Amount above which human approval is required. Should match approval threshold.</small>
          </label>
        </div>
      </div>

      <div className="policy-section">
        <h3>Allowed Assets</h3>
        <div className="chip-list">
          {form.allowedAssets.map((asset) => (
            <span key={asset} className="chip">
              {asset}
              <button type="button" className="chip-remove" onClick={() => removeListItem('allowedAssets', asset)}>×</button>
            </span>
          ))}
        </div>
        <div className="inline-input">
          <input
            type="text"
            placeholder="Add asset (e.g. USDC)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addListItem('allowedAssets', (e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </div>
        <small>Assets the agent is allowed to transact with.</small>
      </div>

      <div className="policy-section">
        <h3>Allowed Destinations</h3>
        <div className="chip-list">
          {form.allowedDestinations.length === 0 && <span className="muted">No restrictions (any destination allowed)</span>}
          {form.allowedDestinations.map((dest) => (
            <span key={dest} className="chip">
              {dest}
              <button type="button" className="chip-remove" onClick={() => removeListItem('allowedDestinations', dest)}>×</button>
            </span>
          ))}
        </div>
        <div className="inline-input">
          <input
            type="text"
            placeholder="Add destination (G...)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addListItem('allowedDestinations', (e.target as HTMLInputElement).value);
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
        </div>
        <small>Optional whitelist of allowed destination addresses. Empty means any destination is allowed.</small>
      </div>

      <div className="policy-section">
        <h3>Allowed Operations</h3>
        <div className="checkbox-grid">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.txTypeRestrictions.payment ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, payment: e.target.checked } })}
            />
            <span>Payment</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.txTypeRestrictions.trustline ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, trustline: e.target.checked } })}
            />
            <span>Trustline</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.txTypeRestrictions.contract_call ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, contract_call: e.target.checked } })}
            />
            <span>Contract Call</span>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.txTypeRestrictions.account_settings ?? false}
              onChange={(e) => updateForm({ txTypeRestrictions: { ...form.txTypeRestrictions, account_settings: e.target.checked } })}
            />
            <span>Account Settings</span>
          </label>
        </div>
      </div>

      <div className="policy-meta">
        {version !== null && <span className="muted">Version: {version}</span>}
        {updatedAt && <span className="muted">Last updated: {new Date(updatedAt).toLocaleString()}</span>}
      </div>

      <div className="form-actions">
        <button type="submit" disabled={saving || !isDirty}>
          {saving ? 'Saving...' : 'Save Policy'}
        </button>
        {!isDirty && <span className="muted">No changes</span>}
      </div>
    </form>
  );
}

export default function AgentDetail({ agentId }: { agentId: string }) {
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [activity, setActivity] = useState<ActivityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

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
      <div className="block">
        <h2>Schedules</h2>
        {scheduleError && <div className="error">{scheduleError}</div>}
        <ScheduleList agentId={agentId} onError={setScheduleError} />
      </div>
      <div className="block">
        <h2>Executions</h2>
        <ExecutionList agentId={agentId} />
      </div>
      <div className="block">
        <h2>Policy</h2>
        <PolicySettings agentId={agentId} />
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
