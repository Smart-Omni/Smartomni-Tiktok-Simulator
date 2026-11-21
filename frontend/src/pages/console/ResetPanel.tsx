import { useState } from 'react';
import { api } from '../../lib/api';
import type { ShopSummary } from './types';

interface Plan {
  scope: string;
  shopId: string | null;
  description: string;
  affects: Record<string, number>;
  database: string;
  confirmationToken: string;
  expiresAt: string;
}

const SCOPES = ['LOGS', 'WEBHOOKS', 'SHOP', 'ALL'] as const;

/** Two-step reset: prepare shows exactly what will be deleted, then the operator must type the scope to confirm. */
export function ResetPanel({ shops, defaultShopId, onDone }: { shops: ShopSummary[]; defaultShopId: string; onDone: () => void }) {
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('LOGS');
  const [shopId, setShopId] = useState(defaultShopId);
  const [plan, setPlan] = useState<Plan>();
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const phrase = `RESET ${scope}`;

  const prepare = async () => {
    setBusy(true);
    setMsg(undefined);
    setTyped('');
    try {
      setPlan(await api<Plan>('/test-admin/reset/prepare', { method: 'POST', body: { scope, ...(scope === 'SHOP' ? { shopId: shopId || defaultShopId } : {}) } }));
    } catch (e) {
      setPlan(undefined);
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await api<{ deleted: Record<string, number> }>('/test-admin/reset', {
        method: 'POST',
        body: { scope: plan.scope, shopId: plan.shopId ?? undefined, confirmationToken: plan.confirmationToken },
      });
      setMsg(`Reset ${plan.scope} done. Removed: ${JSON.stringify(r.deleted)}`);
      setPlan(undefined);
      setTyped('');
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <div className="admin-log-filters admin-reset-fields">
        <label>Scope{' '}
          <select value={scope} onChange={(e) => { setScope(e.target.value as (typeof SCOPES)[number]); setPlan(undefined); }}>
            {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>{' '}
        {scope === 'SHOP' ? (
          <label>Shop{' '}
            <select value={shopId || defaultShopId} onChange={(e) => { setShopId(e.target.value); setPlan(undefined); }}>
              {shops.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        ) : null}{' '}
        <button className="admin-primary" onClick={prepare} disabled={busy || (scope === 'SHOP' && shops.length === 0)}>Review impact</button></div>
      </div>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      {plan ? (
        <div className="card danger admin-reset-confirmation">
          <h3>Confirm {plan.scope} reset</h3>
          <p>{plan.description}</p>
          <p className="muted">Database: <code>{plan.database}</code>. Will delete: <code>{JSON.stringify(plan.affects)}</code>. Token valid until {plan.expiresAt}.</p>
          <label>Type <code>{phrase}</code> to enable{' '}
            <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation phrase" />
          </label>{' '}
          <button className="danger-btn" disabled={busy || typed !== phrase} onClick={execute}>Execute reset</button>
        </div>
      ) : null}
    </div>
  );
}
