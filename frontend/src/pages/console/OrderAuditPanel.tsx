import { AsyncState } from '../../components/AsyncState';
import { useAsync } from '../../lib/useAsync';
import { getOrderAudit } from './adminEndpoints';

export function OrderAuditPanel({ shopId, orderRef, onClose }: { shopId: string; orderRef: string; onClose: () => void }) {
  const audit = useAsync(() => getOrderAudit(shopId, orderRef), [shopId, orderRef], 5000);
  return <section className="admin-surface" aria-label="Order audit history"><div className="admin-section-title"><h2>History · {orderRef}</h2><button type="button" onClick={onClose}>Close history</button></div>
    <AsyncState {...audit} onRetry={audit.reload}>{(data) => <><p>Current status: <span className="pill">{data.status}</span></p>{data.history.length ? <ol className="admin-timeline">{data.history.map((h, index) => <li key={`${h.at}-${index}`}><strong>{h.from ?? 'Created'} → {h.to}</strong><span>{h.actor} · {new Date(h.at).toLocaleString()}</span>{h.note && <p>{h.note}</p>}</li>)}</ol> : <div className="state state-empty">No status history recorded.</div>}</>}</AsyncState>
  </section>;
}
