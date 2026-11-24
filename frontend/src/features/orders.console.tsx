import { useState } from 'react';
import { AsyncState } from '../components/AsyncState';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';
import { OrderAuditPanel } from '../pages/console/OrderAuditPanel';
import { statusTone } from '../components/console/statusTone';
import { PageActions } from '../components/console/PageActions';
import { PaginatedList } from '../components/console/PaginatedList';
import { History, Plus, RefreshCw } from 'lucide-react';

const statusLabel = (status: string) => status.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());

interface AdminOrder {
  id: string;
  shopName: string;
  buyerName: string;
  status: string;
  units: number;
  updatedAt: string;
}

// Mirrors backend/src/orders/order-state.ts; the API is the authority and rejects anything not allowed.
// UNPAID also offers AWAITING_COLLECTION to show that an unpaid order cannot be shipped (the API refuses it).
const NEXT: Record<string, string[]> = {
  UNPAID: ['AWAITING_SHIPMENT', 'CANCELLED', 'AWAITING_COLLECTION'],
  AWAITING_SHIPMENT: ['PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'CANCELLED'],
  PARTIALLY_SHIPPING: ['AWAITING_COLLECTION'],
  AWAITING_COLLECTION: ['IN_TRANSIT'],
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
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <div className="admin-log-filters admin-order-filters">
        <label>Search orders<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Order ID or buyer name" /></label>
        <label>Status<select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="">All statuses</option>{Object.keys(NEXT).map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
        <button className="admin-icon-action" type="button" onClick={list.reload}><RefreshCw size={13} aria-hidden="true" />Refresh</button>
      <PageActions>
        <button className="admin-primary admin-icon-action" title="Create loyalty test orders before and after the 15-day boundary" disabled={!shopId} onClick={() => void loyalty()}><Plus size={14} aria-hidden="true" />Create loyalty orders</button>
      </PageActions>
      </div>
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No orders for this shop.">
        {(d) => (
          <PaginatedList key={`${query}:${statusFilter}`} items={d.items.filter((o) => (!statusFilter || o.status === statusFilter) && `${o.id} ${o.buyerName}`.toLowerCase().includes(query.toLowerCase()))} label="Orders">{(visible) => <div className="scroll"><table className="admin-orders-table">
            <thead><tr><th>Order</th><th>Buyer</th><th>Units</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.id}>
                  <td><button type="button" className="admin-text-button admin-order-reference" onClick={() => setAuditRef(o.id)} aria-label={`View history of ${o.id}`}>{o.id}</button><small className="admin-order-history-hint"><History size={11} aria-hidden="true" />View history</small></td>
                  <td>{o.buyerName}</td>
                  <td>{o.units}</td>
                  <td><span className="pill" data-tone={statusTone(o.status)} title={o.status}>{statusLabel(o.status)}</span></td>
                  <td><div className="admin-order-actions">{[...(NEXT[o.status] ?? [])].sort((a, b) => Number(a === 'CANCELLED') - Number(b === 'CANCELLED')).map((to) => <button key={to} data-tone={statusTone(to)} title={to} onClick={() => void go(o.id, to)}>{to === 'CANCELLED' ? 'Cancel order' : statusLabel(to)}</button>)}</div>{!(NEXT[o.status]?.length) && <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>{!d.items.some((o) => (!statusFilter || o.status === statusFilter) && `${o.id} ${o.buyerName}`.toLowerCase().includes(query.toLowerCase())) && <div className="state state-empty">No orders match these filters.</div>}</div>}</PaginatedList>
        )}
      </AsyncState>
      {auditRef && <OrderAuditPanel key={auditRef} shopId={shopId} orderRef={auditRef} onClose={() => setAuditRef(undefined)} />}
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'orders', label: 'Orders', order: 10, render: (c) => <OrdersPanel {...c} /> }];
export default tabs;
