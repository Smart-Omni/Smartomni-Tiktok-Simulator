import { PaginatedList } from '../../components/console/PaginatedList';
import { useState, type FormEvent } from 'react';
import { CheckCircle2, Search } from 'lucide-react';
import { AsyncState } from '../../components/AsyncState';
import { useAsync } from '../../lib/useAsync';
import { vnd } from '../../lib/api';
import { createSandboxOrders, getSandboxProducts, type SandboxProducts, type SandboxResult } from './adminEndpoints';

export function SandboxPanel({ shopId }: { shopId: string }) {
  const catalog = useAsync(() => getSandboxProducts(shopId), [shopId]);
  return <AsyncState {...catalog} onRetry={catalog.reload} isEmpty={(d) => d.products.length === 0} emptyText="No active products with normal SKUs. Prepare products in Shops & scenarios first.">{(data) => <SandboxForm shopId={shopId} catalog={data} onCreated={catalog.reload} />}</AsyncState>;
}

function SandboxForm({ shopId, catalog, onCreated }: { shopId: string; catalog: SandboxProducts; onCreated: () => void }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Record<string, number>>({});
  const [count, setCount] = useState(1);
  const [pay, setPay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<SandboxResult>();
  const rows = catalog.products.flatMap((p) => p.sku_list.map((s) => ({ ...s, productId: p.product_id, title: p.title })));
  const selected = rows.filter((r) => r.id in items);
  const shown = rows.filter((r) => `${r.title} ${r.seller_sku} ${r.id}`.toLowerCase().includes(query.toLowerCase()));
  const valid = selected.length > 0 && selected.length <= 20 && Number.isInteger(count) && count >= 1 && count <= catalog.limits.max_order_count && selected.every((r) => Number.isInteger(items[r.id]) && items[r.id] >= 1 && items[r.id] <= catalog.limits.max_quantity_per_sku && items[r.id] * count <= r.stock_count);
  const total = selected.reduce((sum, r) => sum + r.price * items[r.id], 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      setResult(await createSandboxOrders({ shopId, order_count: count, pay, items: selected.map((r) => ({ product_id: r.productId, sku_id: r.id, quantity: items[r.id] })) }));
      onCreated();
    } catch (e) {
      setError(`${(e as Error).message}. Check Orders before creating another batch; some orders may already exist.`);
    } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="admin-sandbox">
      <div className="admin-sandbox-layout">
        <section className="admin-surface">
          <div className="admin-section-title"><h2>Select products</h2><span>{selected.length} / 20 SKUs selected</span></div>
          <label className="admin-search"><Search size={16} /><input aria-label="Search sandbox products" placeholder="Search product, seller SKU or SKU ID" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          <PaginatedList key={query} items={shown} label="SKUs">{(visible) => <div className="admin-catalog-scroll"><table><thead><tr><th>Select</th><th>Product / SKU</th><th>Unit price</th><th>Stock</th><th>Qty / order</th></tr></thead><tbody>{visible.map((r) => <tr key={r.id}>
            <td><input type="checkbox" aria-label={`Select ${r.seller_sku}`} checked={r.id in items} disabled={busy || r.stock_count === 0 || (!(r.id in items) && selected.length >= 20)} onChange={(e) => setItems((prev) => { const next = { ...prev }; if (e.target.checked) next[r.id] = 1; else delete next[r.id]; return next; })} /></td>
            <td><strong>{r.title}</strong><small>{r.seller_sku}</small></td><td>{vnd(r.price)}</td><td>{r.stock_count}</td>
            <td><input type="number" min={1} max={catalog.limits.max_quantity_per_sku} aria-label={`Quantity of ${r.seller_sku}`} disabled={busy || !(r.id in items)} value={items[r.id] ?? 1} onChange={(e) => setItems((prev) => ({ ...prev, [r.id]: Number(e.target.value) }))} />{r.id in items && items[r.id] * count > r.stock_count ? <small className="admin-error-text">Insufficient stock for this batch</small> : null}</td>
          </tr>)}</tbody></table>{!shown.length && <div className="state state-empty">No products match your search.</div>}</div>}</PaginatedList>
        </section>
        <section className="admin-surface admin-batch-summary">
          <h2>Batch settings</h2>
          <label>Number of orders<input type="number" min={1} max={catalog.limits.max_order_count} value={count} disabled={busy} onChange={(e) => setCount(Number(e.target.value))} /></label>
          <p className="muted">Maximum {catalog.limits.max_order_count} orders; {catalog.limits.max_quantity_per_sku} units per SKU per order.</p>
          <label className="admin-check"><input type="checkbox" checked={pay} disabled={busy} onChange={(e) => setPay(e.target.checked)} /> Simulate payment after checkout</label>
          <dl className="admin-summary-list"><div><dt>Selected SKUs</dt><dd>{selected.length}</dd></div><div><dt>Items per order</dt><dd>{selected.reduce((n, r) => n + items[r.id], 0)}</dd></div><div><dt>Item subtotal / order</dt><dd>{vnd(total)}</dd></div><div><dt>Initial order status</dt><dd>{pay ? 'ON_HOLD' : 'UNPAID'}</dd></div></dl>
          <p className="muted">Item subtotal excludes shipping and other checkout adjustments.</p>
          <p className="muted">Successful orders are kept if a batch partially fails.</p>
          <button className="admin-primary" type="submit" disabled={!valid || busy}>{busy ? 'Creating orders…' : result ? 'Create another batch' : 'Create test orders'}</button>
        </section>
      </div>
      {error && <div className="state state-error" role="alert">{error}</div>}
      {result && <section className="admin-surface" aria-label="Batch result"><div className="admin-section-title"><h2><CheckCircle2 size={18} /> Batch result</h2><span>{result.created.length} created · {result.failed.length} failed</span></div>
        {result.created.length > 0 && <PaginatedList items={result.created} label="Orders">{(visible) => <div className="scroll"><table><thead><tr><th>Order ID</th><th>Status</th></tr></thead><tbody>{visible.map((o) => <tr key={o.order_id}><td>{o.order_id}</td><td><span className="pill ok">{o.status}</span></td></tr>)}</tbody></table></div>}</PaginatedList>}
        {result.failed.map((f) => <div className="state state-error" key={f.index}>Order {f.index + 1}: {f.error}</div>)}
        {result.request_id && <p className="muted">Request ID: {result.request_id}</p>}
      </section>}
    </form>
  );
}
