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
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No orders for this shop.">
        {(d) => (
          <table>
            <thead><tr><th>Order</th><th>Buyer</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {d.items.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.buyerName}</td>
                  <td><span className="pill" data-tone={statusTone(o.status)}>{o.status}</span></td>
                  <td>
                    {STEP[o.status] ? <button data-tone={statusTone(STEP[o.status])} onClick={() => void go(o.id, STEP[o.status])}>{STEP[o.status]}</button> : null}
                    {o.status === 'ON_HOLD' ? <button data-tone="warning" onClick={() => void go(o.id, 'AWAITING_COLLECTION')}>Try to ship (expect refusal)</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncState>
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'fulfillment', label: 'Fulfillment', order: 20, render: (c) => <FulfillmentPanel {...c} /> }];
export default tabs;
