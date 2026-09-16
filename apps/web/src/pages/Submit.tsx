import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SubmitPaymentIntent } from '../types';

export default function Submit() {
  const [agents, setAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents()
      .then((a) => {
        setAgents(a.agents.map((x) => ({ id: x.id, displayName: x.displayName })));
        if (a.agents.length > 0) setSelectedAgent(a.agents[0]!.id);
      })
      .catch((e: any) => setError(e.message));
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    if (!selectedAgent) return setError('Select an agent');
    if (!amount || parseFloat(amount) <= 0) return setError('Amount must be positive');
    if (!destination || !destination.startsWith('G')) return setError('Destination must be a valid Stellar account (G...)');
    if (!reason || reason.length < 3) return setError('Reason must be at least 3 characters');

    // IMPORTANT: only XLM payment is exposed — no XDR, no contract_call/trustline/account_settings.
    const intent: SubmitPaymentIntent = {
      type: 'payment',
      asset: 'XLM',
      destination,
      amount,
      reason,
    };
    setLoading(true);
    api.submitPayment(selectedAgent, intent)
      .then((r) => {
        setResult(`Intent submitted. Activity: ${r.activityId}${r.approvalId ? ', Approval: ' + r.approvalId : ''}. Status: ${r.status}`);
      })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <section>
      <h1>Submit Payment Intent</h1>
      <p>Submit an XLM payment intent for policy evaluation. Only XLM is supported in the MVP.</p>
      {error && <ErrorMessage msg={error} />}
      {result && <div className="success">{result}</div>}
      <form onSubmit={handleSubmit}>
        <label>
          Agent
          <select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
          </select>
        </label>
        <label>
          Amount (XLM)
          <input type="number" step="0.0000001" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          Destination (Stellar G...)
          <input type="text" value={destination} onChange={(e) => setDestination(e.target.value)} />
        </label>
        <label>
          Reason
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="submit" disabled={loading}>{loading ? 'Submitting...' : 'Submit'}</button>
      </form>
    </section>
  );
}

function ErrorMessage({ msg }: { msg: string }) {
  return <div className="error">{msg}</div>;
}
