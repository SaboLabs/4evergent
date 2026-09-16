import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ScheduleRecord } from '../types';

interface ScheduleListProps {
  agentId: string;
  onError?: (msg: string) => void;
}

export function ScheduleList({ agentId, onError }: ScheduleListProps) {
  const [schedules, setSchedules] = useState<ScheduleRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api.listSchedules(agentId)
      .then((r) => setSchedules(r.schedules))
      .catch((e: any) => {
        setError(e.message);
        onError?.(e.message);
      });
  };

  useEffect(() => { load(); }, [agentId]);

  if (error) return <div className="error">{error}</div>;
  if (schedules === null) return <div className="skeleton">Loading schedules...</div>;
  if (schedules.length === 0) {
    return (
      <div className="empty-state">
        <p>No schedules for this agent.</p>
      </div>
    );
  }

  const handleAction = async (scheduleId: string, action: 'pause' | 'resume' | 'disable') => {
    try {
      if (action === 'pause') await api.pauseSchedule(agentId, scheduleId);
      else if (action === 'resume') await api.resumeSchedule(agentId, scheduleId);
      else await api.disableSchedule(agentId, scheduleId);
      load();
    } catch (e: any) {
      onError?.(e.message);
    }
  };

  return (
    <table>
      <thead>
        <tr><th>ID</th><th>Expression</th><th>Next Run</th><th>Status</th><th>Actions</th></tr>
      </thead>
      <tbody>
        {schedules.map((s) => (
          <tr key={s.id}>
            <td><code>{s.id.slice(0, 8)}</code></td>
            <td>{s.scheduleExpression}</td>
            <td>{new Date(s.nextRunAt).toLocaleString()}</td>
            <td><StatusBadge status={s.status} /></td>
            <td>
              {s.status === 'active' && (
                <>
                  <button onClick={() => handleAction(s.id, 'pause')}>Pause</button>
                  {' '}
                  <button onClick={() => handleAction(s.id, 'disable')}>Disable</button>
                </>
              )}
              {s.status === 'paused' && (
                <>
                  <button onClick={() => handleAction(s.id, 'resume')}>Resume</button>
                  {' '}
                  <button onClick={() => handleAction(s.id, 'disable')}>Disable</button>
                </>
              )}
              {s.status === 'disabled' && (
                <button onClick={() => handleAction(s.id, 'resume')}>Resume</button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'active' ? 'badge-ok'
    : status === 'paused' ? 'badge-warn'
    : 'badge-err';
  return <span className={'badge ' + cls}>{status}</span>;
}
