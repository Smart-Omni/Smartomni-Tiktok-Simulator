import { useState } from 'react';
import { AsyncState } from '../components/AsyncState';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';
import { OrderAuditPanel } from '../pages/console/OrderAuditPanel';
import { statusTone } from '../components/console/statusTone';

interface AdminOrder {
  id: string;
  shopName: string;
  buyerName: string;
  status: string;
  units: number;
  updatedAt: string;
  releaseAt: string | null;
}

// Mirrors backend/src/orders/order-state.ts; the API is the authority and rejects anything not allowed.
const NEXT: Record<string, string[]> = {
  UNPAID: ['ON_HOLD', 'CANCELLED'],
  ON_HOLD: ['AWAITING_SHIPMENT', 'CANCELLED', 'AWAITING_COLLECTION'],
  AWAITING_SHIPMENT: ['PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'CANCELLED'],
  PARTIALLY_SHIPPING: ['AWAITING_COLLECTION', 'CANCELLED'],
  AWAITING_COLLECTION: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function OrdersPanel({ shopId }: { shopId: string }) {
  const list = useAsync(() => api<{ items: AdminOrder[] }>(`/test-admin/orders?shopId=${encodeURIComponent(shopId)}`), [shopId], 5000);
  const [msg, setMsg] = useState<string>();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [auditRef, setAuditRef] = useState<string>();
  async function go(id: string, to: string) {
    try {
      await api(`/test-admin/orders/${id}/transition`, { method: 'POST', body: { to, shopId } });
      setMsg(`${id} -> ${to}`);
      list.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function releaseDue() {
    try {
      const r = await api<{ released: string[] }>('/test-admin/orders/release-due', { method: 'POST', body: {} });
      setMsg(`Released ${r.released.length} held order(s).`);
      list.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function loyalty() {
    try {
      const r = await api<{ orders: { label: string; orderId: string; status: string }[] }>('/test-admin/scenarios/loyalty-orders', { method: 'POST', body: { shopId } });
      setMsg(`Created ${r.orders.length} loyalty test orders: ${r.orders.map((o) => `${o.orderId} (${o.status})`).join(', ')}`);
      list.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div>
      <div className="row-wrap">
        <button onClick={() => void loyalty()}>Create loyalty test orders (before/after 15 days)</button>
        <button onClick={() => void releaseDue()}>Release due holds</button>
      </div>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <div className="admin-toolbar">
        <label>Search orders<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Order ID or buyer name" /></label>
        <label>Status<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All statuses</option>{Object.keys(NEXT).map((s) => <option key={s}>{s}</option>)}</select></label>
        <button type="button" onClick={list.reload}>Refresh orders</button>
        <span className="muted">Filters apply to the loaded orders.</span>
      </div>
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No orders for this shop.">
        {(d) => (
          <div className="scroll"><table>
            <thead><tr><th>Order</th><th>Buyer</th><th>Units</th><th>Status</th><th>Hold until</th><th>Move to</th></tr></thead>
            <tbody>
              {d.items.filter((o) => (!statusFilter || o.status === statusFilter) && `${o.id} ${o.buyerName}`.toLowerCase().includes(query.toLowerCase())).map((o) => (
                <tr key={o.id}>
                  <td><button type="button" className="admin-text-button" onClick={() => setAuditRef(o.id)} aria-label={`View history of ${o.id}`}>{o.id}</button></td>
                  <td>{o.buyerName}</td>
                  <td>{o.units}</td>
                  <td><span className="pill" data-tone={statusTone(o.status)}>{o.status}</span></td>
                  <td>{o.releaseAt && o.status === 'ON_HOLD' ? new Date(o.releaseAt).toLocaleString() : ''}</td>
                  <td><div className="admin-table-actions">{(NEXT[o.status] ?? []).map((to) => <button key={to} data-tone={statusTone(to)} onClick={() => void go(o.id, to)}>{to}</button>)}</div></td>
                </tr>
              ))}
            </tbody>
          </table>{!d.items.some((o) => (!statusFilter || o.status === statusFilter) && `${o.id} ${o.buyerName}`.toLowerCase().includes(query.toLowerCase())) && <div className="state state-empty">No orders match these filters.</div>}</div>
        )}
      </AsyncState>
      {auditRef && <OrderAuditPanel key={auditRef} shopId={shopId} orderRef={auditRef} onClose={() => setAuditRef(undefined)} />}
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'orders', label: 'Orders', order: 10, render: (c) => <OrdersPanel {...c} /> }];
export default tabs;
