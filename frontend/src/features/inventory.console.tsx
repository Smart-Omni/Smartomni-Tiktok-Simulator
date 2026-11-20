import { AsyncState } from '../components/AsyncState';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';

export interface InventoryHistory {
  changes: { seq: number; sku: string; sellerSku: string; warehouse: string; warehouseName: string; before: number; after: number; source: string; noop: boolean; requestId: string | null; note: string; at: string }[];
  attempts: { seq: number; product: string; outcome: string; itemsTotal: number; itemsApplied: number; itemsFailed: number; requestId: string | null; at: string }[];
}

export function InventoryHistoryView({ data }: { data: InventoryHistory }) {
  return (
    <div>
      <h3>Stock changes (before / after)</h3>
      {data.changes.length === 0 ? <div className="state state-empty">No stock changes yet.</div> : (
        <div className="scroll">
          <table>
            <thead><tr><th>#</th><th>SKU</th><th>Warehouse</th><th className="num">Before</th><th className="num">After</th><th>Source</th><th>Request</th><th>When</th></tr></thead>
            <tbody>
              {data.changes.map((c) => (
                <tr key={c.seq}>
                  <td>{c.seq}</td>
                  <td>{c.sellerSku}<div className="muted">{c.sku}</div></td>
                  <td>{c.warehouseName}</td>
                  <td className="num">{c.before}</td>
                  <td className="num">{c.after}</td>
                  <td><span className={`pill ${c.source === 'API' ? 'ok' : ''}`}>{c.source}</span>{c.noop ? <span className="pill warn" title="The value was already stored, so a retry changed nothing">no-op retry</span> : null}</td>
                  <td className="muted">{c.requestId ?? c.note}</td>
                  <td>{new Date(c.at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>Update Inventory API calls</h3>
      {data.attempts.length === 0 ? <div className="state state-empty">SmartOmni has not called Update Inventory yet.</div> : (
        <table>
          <thead><tr><th>#</th><th>Product</th><th>Outcome</th><th className="num">SKUs</th><th>Request</th><th>When</th></tr></thead>
          <tbody>
            {data.attempts.map((a) => (
              <tr key={a.seq}>
                <td>{a.seq}</td>
                <td>{a.product}</td>
                <td><span className={`pill ${a.outcome === 'APPLIED' ? 'ok' : a.outcome === 'PARTIAL' ? 'warn' : 'bad'}`}>{a.outcome}</span></td>
                <td className="num">{a.itemsApplied} ok / {a.itemsFailed} failed of {a.itemsTotal}</td>
                <td className="muted">{a.requestId}</td>
                <td>{new Date(a.at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}


export function InventoryPanel({ shopId }: { shopId: string }) {
  const history = useAsync(() => api<InventoryHistory>(`/test-admin/inventory/history?shopId=${encodeURIComponent(shopId)}&limit=100`), [shopId], 5000);
  return (
    <div>
      <AsyncState {...history} onRetry={history.reload}>
        {(d) => <InventoryHistoryView data={d} />}
      </AsyncState>
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'inventory', label: 'Inventory', order: 30, render: (c) => <InventoryPanel {...c} /> }];
export default tabs;
