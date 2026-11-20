import { useState, type FormEvent } from 'react';
import { Scale } from 'lucide-react';
import { arbitrateAftersale, type ArbitrationDecision } from './adminEndpoints';

export function ArbitrationPanel({ shopId, initialRef = '' }: { shopId: string; initialRef?: string }) {
  const [ref, setRef] = useState(initialRef);
  const [decision, setDecision] = useState<ArbitrationDecision>('IN_ARBITRATION');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ id: string; arbitration_status: ArbitrationDecision; changed: boolean }>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ref.trim() || busy) return;
    setBusy(true); setError(undefined); setResult(undefined);
    try { setResult(await arbitrateAftersale(shopId, ref.trim(), decision, note.trim())); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="admin-arbitration-layout">
      <form onSubmit={submit} className="admin-surface admin-form">
        <h2>Arbitration decision</h2>
        <label>Aftersale request ID<input required value={ref} disabled={busy} onChange={(e) => { setRef(e.target.value); setResult(undefined); }} placeholder="Request ID from Returns & refunds" /></label>
        <label>Target arbitration status<select value={decision} disabled={busy} onChange={(e) => setDecision(e.target.value as ArbitrationDecision)}><option value="IN_ARBITRATION">Open dispute — IN_ARBITRATION</option><option value="ARBITRATION_WIN">Resolve — ARBITRATION_WIN</option><option value="ARBITRATION_LOSS">Resolve — ARBITRATION_LOSS</option></select></label>
        <label>Operator note <span className="muted">Optional · up to 300 characters</span><textarea maxLength={300} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} /></label>
        <button className="admin-primary" type="submit" disabled={!ref.trim() || busy}>{busy ? 'Applying decision…' : 'Apply arbitration decision'}</button>
        {error && <div className="state state-error" role="alert">{error}</div>}
        {result && <div className="state state-empty" role="status"><div><strong>{result.changed ? 'Decision applied' : 'Already in this state'}</strong><p>Request {result.id}</p><span className="pill ok">{result.arbitration_status}</span></div></div>}
      </form>
      <aside className="admin-callout"><Scale size={20} /><div><strong>Dispute lifecycle</strong><p>Use a return request from the selected shop. The API validates each transition.</p><ol><li>NO_ARBITRATION</li><li>IN_ARBITRATION</li><li>ARBITRATION_WIN or ARBITRATION_LOSS</li></ol><p>These controls affect simulator data and can emit webhook events.</p></div></aside>
    </div>
  );
}
