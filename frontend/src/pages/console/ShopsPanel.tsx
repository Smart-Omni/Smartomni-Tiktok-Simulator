import { useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import type { AsyncResult } from '../../lib/useAsync';
import type { ShopSummary } from './types';
import { PaginatedList } from '../../components/console/PaginatedList';

/** POST /test-admin/catalog/bulk: ACTIVATE products with priced SKUs (fake data), also used by Seller Center Products. */
export function BulkProductsForm({ shopId, shopName, onCreated }: { shopId: string; shopName: string; onCreated: (message: string) => void }) {
  const [count, setCount] = useState('50');
  const [skus, setSkus] = useState('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const whole = (value: string, max: number) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max;
  const valid = whole(count, 500) && whole(skus, 5);
  async function create() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const r = await api<{ created: number; totalProducts: number }>('/test-admin/catalog/bulk', { method: 'POST', body: { shopId, count: Number(count), skusPerProduct: Number(skus) } });
      onCreated(`Added ${r.created} products to ${shopName} (${r.totalProducts} in this shop).`);
    } catch (e) {
      setError(`${(e as Error).message}. Check the shop catalog before submitting again: some products may already have been created.`);
    } finally { setBusy(false); }
  }
  return <form className="admin-scenario-form" aria-label={`Create test products for ${shopName}`} onSubmit={(e) => { e.preventDefault(); void create(); }}>
    <fieldset className="admin-fields-grid" disabled={busy}>
      <label>Products to create<input type="number" required min={1} max={500} step={1} value={count} onChange={(e) => setCount(e.target.value)} /></label>
      <label>SKUs per product<input type="number" required min={1} max={5} step={1} value={skus} onChange={(e) => setSkus(e.target.value)} /></label>
      {!valid && <p role="alert">Choose 1–500 products and 1–5 SKUs per product, using whole numbers.</p>}
      <button disabled={!valid}>{busy ? 'Adding products…' : `Add ${count || '0'} test products`}</button>
    </fieldset>
    {error && <p className="state state-error" role="alert">{error}</p>}
  </form>;
}

export function ShopsPanel({ shops }: { shops: AsyncResult<{ items: ShopSummary[] }> }) {
  const [msg, setMsg] = useState<string>();
  const activate = async (shopId: string, key: string) => {
    try {
      await api(`/test-admin/shops/${shopId}/scenario`, { method: 'POST', body: { key } });
      setMsg(`Scenario "${key}" activated.`);
      shops.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <AsyncState {...shops} onRetry={shops.reload} isEmpty={(d) => d.items.length === 0} emptyText="No shops yet. Run Seed on the Status tab.">
      {(d) => (
        <div>
          {msg ? <div className="state state-empty">{msg}</div> : null}
          <PaginatedList items={d.items} label="Shops" initialPageSize={6}>{(visible) => <div className="admin-shops-grid">
            {visible.map((s) => (
              <article key={s.id} className="card admin-shop-card">
                <h3>{s.name}</h3>
                <div className="muted">{s.region} / {s.currency}<span className="admin-shop-id">TikTok shop ID {s.tiktokShopId}</span></div>
                <div className="muted">{s.counts.products} products, {s.counts.buyers} buyers, {s.counts.webhookJobs} webhook jobs</div>
                <label className="admin-shop-scenario">
                  Scenario{' '}
                  <select value={s.activeScenarioId ?? ''} onChange={(e) => { const sc = s.scenarios.find((x) => x.id === e.target.value); if (sc) void activate(s.id, sc.key); }}>
                    {s.scenarios.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
                  </select>
                </label>
                <div className="muted admin-scenario-description">{s.scenarios.find((x) => x.id === s.activeScenarioId)?.description}</div>
                <BulkProductsForm shopId={s.id} shopName={s.name} onCreated={(message) => { setMsg(message); shops.reload(); }} />
              </article>
            ))}
          </div>}</PaginatedList>
        </div>
      )}
    </AsyncState>
  );
}
