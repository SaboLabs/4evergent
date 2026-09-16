import { useState } from 'react';
import Overview from './pages/Overview';
import Agents from './pages/Agents';
import Activity from './pages/Activity';
import Approvals from './pages/Approvals';
import Submit from './pages/Submit';

type Tab = 'overview' | 'agents' | 'activity' | 'approvals' | 'submit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'activity', label: 'Activity' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'submit', label: 'Submit Intent' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('overview');

  return (
    <div className="layout">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▲</span>
          <span className="brand-name">4evergent</span>
        </div>
        <span className="badge badge-info">Testnet MVP</span>
      </header>
      <div className="body">
        <nav className="sidebar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <main className="content">
          {tab === 'overview' && <Overview />}
          {tab === 'agents' && <Agents />}
          {tab === 'activity' && <Activity />}
          {tab === 'approvals' && <Approvals />}
          {tab === 'submit' && <Submit />}
        </main>
      </div>
    </div>
  );
}

export function ErrorDisplay({ status, message }: { status?: number; message: string }) {
  if (status === 401 || status === 403) {
    return (
      <div className="error">
        <strong>Access Denied</strong>
        <p>{message}</p>
      </div>
    );
  }
  if (status === 404) {
    return (
      <div className="empty-state">
        <h2>Not Found</h2>
        <p>{message}</p>
      </div>
    );
  }
  return (
    <div className="error">
      <p>{message}</p>
    </div>
  );
}
