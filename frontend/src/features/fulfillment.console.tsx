import { PageActions } from '../components/console/PageActions';
import { RefreshCw } from 'lucide-react';
import { PaginatedList } from '../components/console/PaginatedList';
import { useState } from 'react';
import { AsyncState } from '../components/AsyncState';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';
import { statusTone } from '../components/console/statusTone';

interface AdminOrder {
  id: string;
  buyerName: string;
  status: string;
  releaseAt: string | null;
}

const STEP: Record<string, string> = { AWAITING_SHIPMENT: 'AWAITING_COLLECTION', AWAITING_COLLECTION: 'IN_TRANSIT', IN_TRANSIT: 'DELIVERED' };

export function FulfillmentPanel({ shopId }: { shopId: string }) {
  const list = useAsync(() => api<{ items: AdminOrder[] }>(`/test-admin/orders?shopId=${encodeURIComponent(shopId)}`), [shopId], 5000);
  const [msg, setMsg] = useState<string>();
  async function go(id: string, to: string) {
    try {
      await api(`/test-admin/orders/${id}/transition`, { method: 'POST', body: { to, shopId } });
      setMsg(`${id} -> ${to}`);
    } catch (e) {
      setMsg(`Refused: ${(e as Error).message}`);
    }
    list.reload();
  }
  return (
    <div>
      <PageActions><button className="admin-icon-action" onClick={list.reload}><RefreshCw size={13} />Refresh</button></PageActions>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No orders for this shop.">
        {(d) => (
          <PaginatedList items={d.items} label="Orders">{(visible) => <div className="scroll"><table className="admin-data-table">
            <thead><tr><th>Order</th><th>Buyer</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {visible.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.buyerName}</td>
                  <td><span className="pill" data-tone={statusTone(o.status)}>{o.status}</span></td>
                  <td>
                    {STEP[o.status] ? <button data-tone={statusTone(STEP[o.status])} onClick={() => void go(o.id, STEP[o.status])}>{STEP[o.status]}</button> : null}
                    {o.status === 'ON_HOLD' ? <button data-tone="warning" onClick={() => void go(o.id, 'AWAITING_COLLECTION')}>Try to ship (expect refusal)</button> : !STEP[o.status] && <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>}</PaginatedList>
        )}
      </AsyncState>
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'fulfillment', label: 'Fulfillment', order: 20, render: (c) => <FulfillmentPanel {...c} /> }];
export default tabs;
