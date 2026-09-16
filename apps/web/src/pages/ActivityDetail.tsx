import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ActivityRecord } from '../types';

export default function ActivityDetail({ agentId, activityId }: { agentId: string; activityId: string }) {
  const [activity, setActivity] = useState<ActivityRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.activityDetail(agentId, activityId)
      .then((res) => setActivity(res.activity))
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [agentId, activityId]);

  if (loading) return <Skeleton label="Loading activity..." />;
  if (error) return <EmptyState title="Failed to load activity" message={error} />;
  if (!activity) return <NotFound />;

  const amount = activity.intent.amount || '-';
  const asset = activity.intent.asset || '';

  return (
    <section>
      <h1>Activity Detail</h1>
      <div className="cards">
        <Card title="ID" value={activity.id} />
        <Card title="Type" value={activity.intent.type} />
        <Card title="Amount" value={amount + ' ' + asset} />
        <Card title="Status" value={activity.status} />
        <Card title="Created" value={new Date(activity.createdAt).toLocaleString()} />
      </div>
      {activity.error && (
        <div className="block">
          <h2>Error</h2>
          <div className="error">{activity.error}</div>
        </div>
      )}
      {activity.policyDecision && (
        <div className="block">
          <h2>Policy Decision</h2>
          <table>
            <tbody>
              <tr><td>Result</td><td>{activity.policyDecision.result}</td></tr>
              <tr><td>Reason</td><td>{activity.policyDecision.reason}</td></tr>
              <tr><td>Rule</td><td>{activity.policyDecision.rule}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function NotFound() {
  return (
    <div className="empty-state">
      <h2>Activity not found</h2>
      <p>This activity does not exist or you do not have access.</p>
    </div>
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
