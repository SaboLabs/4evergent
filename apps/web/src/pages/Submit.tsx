import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SubmitPaymentIntent } from '../types';

export default function Submit() {
  const [agents, setAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [intentType, setIntentType] = useState<'payment' | 'trustline'>('payment');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  const [assetCode, setAssetCode] = useState('XLM');
  const [issuer, setIssuer] = useState('');
  const [trustlineAssetCode, setTrustlineAssetCode] = useState('');
  const [trustlineIssuer, setTrustlineIssuer] = useState('');
  const [trustlineLimit, setTrustlineLimit] = useState('');
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
    if (!reason || reason.length < 3) return setError('Reason must be at least 3 characters');

    setLoading(true);
    if (intentType === 'payment') {
      if (!amount || parseFloat(amount) <= 0) { setLoading(false); return setError('Amount must be positive'); }
      if (!destination || !destination.startsWith('G')) { setLoading(false); return setError('Destination must be a valid Stellar account (G...)'); }
      const isNativeXLM = assetCode === 'XLM';
      const intent: SubmitPaymentIntent = {
        type: 'payment',
        asset: assetCode === 'XLM' ? 'XLM' : assetCode,
        ...((!isNativeXLM && issuer) ? { assetDetails: { code: assetCode, issuer } } : {}),
        destination,
        amount,
        reason,
      };
      api.submitPayment(selectedAgent, intent)
        .then((r) => {
          setResult(`Intent submitted. Activity: ${r.activityId}${r.approvalId ? ', Approval: ' + r.approvalId : ''}. Status: ${r.status}`);
        })
        .catch((e: any) => setError(e.message))
        .finally(() => setLoading(false));
    } else {
      if (!trustlineAssetCode || trustlineAssetCode.length < 1) { setLoading(false); return setError('Asset code is required'); }
      if (trustlineAssetCode === 'XLM') { setLoading(false); return setError('XLM is native — use payment instead'); }
      if (!trustlineIssuer || !trustlineIssuer.startsWith('G')) { setLoading(false); return setError('Issuer must be a valid Stellar account (G...)'); }
      api.submitTrustline(selectedAgent, {
        type: 'trustline',
        assetCode: trustlineAssetCode,
        issuer: trustlineIssuer,
        limit: trustlineLimit || undefined,
        reason,
      })
        .then((r) => {
          setResult(`Trustline intent submitted. Activity: ${r.activityId}${r.approvalId ? ', Approval: ' + r.approvalId : ''}. Status: ${r.status}`);
        })
        .catch((e: any) => setError(e.message))
        .finally(() => setLoading(false));
    }
  };

  return (
    <section>
      <h1>Submit Intent</h1>
      {error && <ErrorMessage msg={error} />}
      {result && <div className="success">{result}</div>}
      <form onSubmit={handleSubmit}>
        <label>
          Intent Type
          <select value={intentType} onChange={(e) => setIntentType(e.target.value as any)}>
            <option value="payment">Payment</option>
            <option value="trustline">Trustline</option>
          </select>
        </label>

        <label>
          Agent
          <select value={selectedAgent} onChange={(e) => setSelectedAgent(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.displayName || a.id}</option>)}
          </select>
        </label>

        {intentType === 'payment' ? (
          <>
            <label>
              Asset
              <select value={assetCode} onChange={(e) => setAssetCode(e.target.value)}>
                <option value="XLM">XLM (native)</option>
                <option value="USDC">USDC</option>
                <option value="BTC">BTC</option>
                <option value="other">Other (specify)</option>
              </select>
            </label>
            {assetCode === 'other' && (
              <label>
                Asset Code
                <input type="text" value={assetCode === 'other' ? '' : assetCode} onChange={(e) => setAssetCode(e.target.value)} placeholder="e.g. USDC" />
              </label>
            )}
            {assetCode !== 'XLM' && (
              <label>
                Issuer (Stellar G...)
                <input type="text" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="G..." />
              </label>
            )}
            <label>
              Amount
              <input type="number" step="0.0000001" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <label>
              Destination (Stellar G...)
              <input type="text" value={destination} onChange={(e) => setDestination(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <label>
              Asset Code
              <input type="text" value={trustlineAssetCode} onChange={(e) => setTrustlineAssetCode(e.target.value)} placeholder="e.g. USDC" />
            </label>
            <label>
              Issuer (Stellar G...)
              <input type="text" value={trustlineIssuer} onChange={(e) => setTrustlineIssuer(e.target.value)} placeholder="G..." />
            </label>
            <label>
              Trustline Limit (optional)
              <input type="number" step="0.0000001" min="0" value={trustlineLimit} onChange={(e) => setTrustlineLimit(e.target.value)} placeholder="No limit" />
            </label>
          </>
        )}

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
