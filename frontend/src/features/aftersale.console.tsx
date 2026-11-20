import { useState } from 'react';
import { AsyncState } from '../components/AsyncState';
import { api, vnd } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';
import { ArbitrationPanel } from '../pages/console/ArbitrationPanel';

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
      <p className="muted">Complete = the refund was paid out (SUCCESS to COMPLETE). Returns never change the order status and the simulator never adds stock back.</p>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No cancellation or return requests for this shop.">
        {(d) => (
          <div className="scroll"><table>
            <thead><tr><th>Request</th><th>Order</th><th>Kind</th><th>Units</th><th>Status</th><th className="num">Refund</th><th /></tr></thead>
            <tbody>
              {d.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.orderId}</td>
                  <td>{r.kind} / {r.type}</td>
                  <td>{r.units}</td>
                  <td><span className="pill">{r.status}</span></td>
                  <td className="num">{vnd(r.refundTotalVnd)}</td>
                  <td>
                    <button onClick={() => void show(r.id)}>History</button>{' '}
                    {r.kind === 'RETURN' && <button type="button" onClick={() => setArbitrationRef(r.id)}>Arbitrate</button>}{' '}
                    {r.status.endsWith('REQUEST_SUCCESS') ? <button onClick={() => void complete(r.id)}>Complete refund</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </AsyncState>
      {arbitrationRef && <section aria-label="Arbitrate selected return"><div className="admin-section-title"><h2>Dispute · {arbitrationRef}</h2><button type="button" onClick={() => setArbitrationRef(undefined)}>Close arbitration</button></div><ArbitrationPanel key={arbitrationRef} shopId={shopId} initialRef={arbitrationRef} /></section>}
      {history ? (
        <section className="card" aria-label="aftersale history">
          <h3>History of {history.id}</h3>
          <ul className="list">{history.data.records.map((h, i) => <li key={i}><span>{h.from ?? 'new'} → {h.to}</span><span className="muted">{h.actor} · {new Date(h.at).toLocaleString()}</span></li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'aftersale', label: 'Aftersale', order: 40, render: (c) => <AftersalePanel {...c} /> }];
export default tabs;
