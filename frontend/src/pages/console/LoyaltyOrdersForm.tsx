import { useState } from 'react';
import { createLoyaltyOrders, type LoyaltyOrdersResult } from './adminEndpoints';

const vnd = (n: number | undefined) => (n == null ? '—' : `${n.toLocaleString('en-US')} VND`);
const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Test data for SmartOmni's "points N days after completion" rule: five orders around the threshold. The result table shows
 * which case each order is and the amounts, because points come from sub_total, not the total.
 */
export function LoyaltyOrdersForm({ shopId, onCreated }: { shopId: string; onCreated?: () => void }) {
  const [buyerId, setBuyerId] = useState('');
  const [thresholdDays, setThresholdDays] = useState('15');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState<LoyaltyOrdersResult>();
  const thresholdValid = /^\d+$/.test(thresholdDays) && Number(thresholdDays) >= 1 && Number(thresholdDays) <= 365;

  async function create() {
    if (!shopId || !thresholdValid || busy) return;
    setBusy(true);
    try {
      const r = await createLoyaltyOrders({ shopId, thresholdDays: Number(thresholdDays), ...(buyerId.trim() ? { buyerId: buyerId.trim() } : {}) });
      setResult(r);
      setMsg(`Created ${r.orders.length} loyalty test orders: ${r.orders.map((o) => `${o.orderId} (${o.status})`).join(', ')}`);
      onCreated?.();
    } catch (e) {
      setMsg(`${(e as Error).message}. Check Orders before submitting again: some test orders may already have been created.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <form className="card admin-scenario-form" aria-label="Loyalty order scenario" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <h3>Create loyalty test orders</h3>
        <p>Creates five test orders: three around the completion threshold, one delivered and one awaiting shipment. Each submission creates new orders.</p>
        <fieldset className="admin-fields-grid" disabled={busy}>
          <label>Buyer ID (optional)<input value={buyerId} onChange={(e) => setBuyerId(e.target.value)} placeholder="First buyer in this shop" /></label>
          <label>Completion threshold (days)<input type="number" min={1} max={365} step={1} required value={thresholdDays} onChange={(e) => setThresholdDays(e.target.value)} aria-invalid={!thresholdValid} /></label>
          {!thresholdValid && <p role="alert">Choose a whole number from 1 to 365 days.</p>}
          <button className="admin-primary" disabled={!shopId || !thresholdValid}>{busy ? 'Creating orders…' : 'Generate loyalty orders'}</button>
        </fieldset>
      </form>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      {result && (
        <section aria-label="Loyalty test orders">
          <p className="muted">{result.note}</p>
          <div className="scroll"><table className="admin-data-table">
            <thead><tr><th>Case</th><th>Order</th><th>Status</th><th>Completed at</th><th className="num">Sub total</th><th className="num">Shipping</th><th className="num">Total</th></tr></thead>
            <tbody>
              {result.orders.map((o) => (
                <tr key={o.orderId}>
                  <td>{o.label}</td>
                  <td><code>{o.orderId}</code></td>
                  <td>{o.status}</td>
                  <td>{time(o.completedAt)}</td>
                  <td className="num"><strong>{vnd(o.amountsVnd?.subTotal)}</strong></td>
                  <td className="num">{vnd(o.amountsVnd?.shippingFee)}</td>
                  <td className="num">{vnd(o.amountsVnd?.total)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}
    </div>
  );
}
