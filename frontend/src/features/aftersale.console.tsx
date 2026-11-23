import { PageActions } from '../components/console/PageActions';
import { RefreshCw } from 'lucide-react';
import { PaginatedList } from '../components/console/PaginatedList';
import { useState } from 'react';
import { AsyncState } from '../components/AsyncState';
import { api, vnd } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';
import { ArbitrationPanel } from '../pages/console/ArbitrationPanel';
import { statusTone } from '../components/console/statusTone';

interface AdminAftersale {
  id: string;
  orderId: string;
  kind: string;
  type: string;
  status: string;
  units: number;
  refundTotalVnd: number;
}
interface History {
  records: { from: string | null; to: string; actor: string; note: string; at: string }[];
}

export function AftersalePanel({ shopId }: { shopId: string }) {
  const list = useAsync(() => api<{ items: AdminAftersale[] }>(`/test-admin/aftersale?shopId=${encodeURIComponent(shopId)}`), [shopId], 5000);
  const [msg, setMsg] = useState<string>();
  const [history, setHistory] = useState<{ id: string; data: History }>();
  const [arbitrationRef, setArbitrationRef] = useState<string>();
  async function complete(id: string) {
    try {
      await api(`/test-admin/aftersale/${id}/complete?shopId=${encodeURIComponent(shopId)}`, { method: 'POST', body: {} });
      setMsg(`${id}: refund completed`);
      list.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function show(id: string) {
    try {
      setHistory({ id, data: await api<History>(`/test-admin/aftersale/${id}/records?shopId=${encodeURIComponent(shopId)}`) });
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div>
      <PageActions><button className="admin-icon-action" onClick={list.reload}><RefreshCw size={13} />Refresh</button></PageActions>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No cancellation or return requests for this shop.">
        {(d) => (
          <PaginatedList items={d.items} label="Requests">{(visible) => <div className="scroll"><table className="admin-data-table">
            <thead><tr><th>Request</th><th>Order</th><th>Kind</th><th>Units</th><th>Status</th><th className="num">Refund</th><th>Actions</th></tr></thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.orderId}</td>
                  <td>{r.kind} / {r.type}</td>
                  <td>{r.units}</td>
                  <td><span className="pill" data-tone={statusTone(r.status)}>{r.status}</span></td>
                  <td className="num">{vnd(r.refundTotalVnd)}</td>
                  <td><div className="admin-table-actions">
                    <button onClick={() => void show(r.id)}>History</button>{' '}
                    {r.kind === 'RETURN' && <button type="button" data-tone="warning" onClick={() => setArbitrationRef(r.id)}>Arbitrate</button>}{' '}
                    {r.status.endsWith('REQUEST_SUCCESS') ? <button data-tone="success" onClick={() => void complete(r.id)}>Complete refund</button> : null}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table></div>}</PaginatedList>
        )}
      </AsyncState>
      {arbitrationRef && <section aria-label="Arbitrate selected return"><div className="admin-section-title"><h2>Dispute · {arbitrationRef}</h2><button type="button" onClick={() => setArbitrationRef(undefined)}>Close arbitration</button></div><ArbitrationPanel key={arbitrationRef} shopId={shopId} initialRef={arbitrationRef} /></section>}
      {history ? (
        <section className="card" aria-label="aftersale history">
          <div className="admin-section-title"><h3>History of {history.id}</h3><button onClick={() => setHistory(undefined)}>Close history</button></div>
          <ul className="list">{history.data.records.map((h, i) => <li key={i}><span>{h.from ?? 'new'} → {h.to}</span><span className="muted">{h.actor} · {new Date(h.at).toLocaleString()}</span></li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'aftersale', label: 'Aftersale', order: 40, render: (c) => <AftersalePanel {...c} /> }];
export default tabs;
