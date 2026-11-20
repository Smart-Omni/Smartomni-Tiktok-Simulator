import { useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';

interface Fault {
  id: string;
  shopId: string | null;
  target: string;
  kind: string;
  pathMatch: string | null;
  params: Record<string, unknown>;
  remaining: number | null;
}

export function FaultsPanel({ shopId }: { shopId: string }) {
  const faults = useAsync(() => api<{ items: Fault[] }>('/test-admin/faults'), [], 5000);
  const [target, setTarget] = useState<'WEBHOOK' | 'API'>('WEBHOOK');
  const [kind, setKind] = useState('HTTP_ERROR');
  const [pathMatch, setPathMatch] = useState('');
  const [status, setStatus] = useState('500');
  const [delayMs, setDelayMs] = useState('1000');
  const [remaining, setRemaining] = useState('1');
  const [global, setGlobal] = useState(false);
  const [msg, setMsg] = useState<string>();

  const create = async () => {
    try {
      await api('/test-admin/faults', {
        method: 'POST',
        body: {
          shopId: global ? null : shopId,
          target,
          kind,
          pathMatch: pathMatch || null,
          params: kind === 'HTTP_ERROR' ? { status: Number(status) } : kind === 'DELAY' ? { delayMs: Number(delayMs) } : {},
          remaining: remaining ? Number(remaining) : null,
        },
      });
      setMsg(undefined);
      faults.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    await api(`/test-admin/faults/${id}`, { method: 'DELETE' });
    faults.reload();
  };

  return (
    <div>
      <div className="card">
        <h3>Inject a fault</h3>
        <div className="row-wrap">
          <label>Target <select value={target} onChange={(e) => setTarget(e.target.value as 'WEBHOOK' | 'API')}><option>WEBHOOK</option><option>API</option></select></label>
          <label>Kind <select value={kind} onChange={(e) => setKind(e.target.value)}><option>HTTP_ERROR</option><option>DELAY</option><option>DROP</option><option>DUPLICATE</option><option>REORDER</option><option>TIMEOUT_BEFORE_WRITE</option><option>TIMEOUT_AFTER_WRITE</option><option>APP_ERROR_200</option></select></label>
          <label>{target === 'WEBHOOK' ? 'Topic' : 'Path prefix'} <input value={pathMatch} onChange={(e) => setPathMatch(e.target.value)} placeholder="(any)" /></label>
          {kind === 'HTTP_ERROR' ? <label>Status <input size={4} value={status} onChange={(e) => setStatus(e.target.value)} /></label> : null}
          {kind === 'DELAY' ? <label>Delay ms <input size={6} value={delayMs} onChange={(e) => setDelayMs(e.target.value)} /></label> : null}
          <label>Uses <input size={4} value={remaining} onChange={(e) => setRemaining(e.target.value)} placeholder="unlimited" /></label>
          <label><input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> all shops</label>
          <button onClick={create} disabled={!global && !shopId}>Add fault</button>
        </div>
        {msg ? <div className="state state-error" role="alert">{msg}</div> : null}
      </div>
      <AsyncState {...faults} onRetry={faults.reload} isEmpty={(d) => d.items.length === 0} emptyText="No active faults.">
        {(d) => (
          <div className="scroll"><table>
            <thead><tr><th>Target</th><th>Kind</th><th>Match</th><th>Params</th><th>Uses left</th><th>Scope</th><th /></tr></thead>
            <tbody>
              {d.items.map((f) => (
                <tr key={f.id}><td>{f.target}</td><td>{f.kind}</td><td>{f.pathMatch ?? '(any)'}</td><td><code>{JSON.stringify(f.params)}</code></td><td>{f.remaining ?? 'unlimited'}</td><td>{f.shopId ? 'shop' : 'all'}</td><td><button onClick={() => remove(f.id)}>Remove</button></td></tr>
              ))}
            </tbody>
          </table></div>
        )}
      </AsyncState>
    </div>
  );
}
