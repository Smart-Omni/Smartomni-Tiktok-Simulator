import { useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import type { AsyncResult } from '../../lib/useAsync';
import type { ShopSummary } from './types';
import { PaginatedList } from '../../components/console/PaginatedList';

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
  const bulk = async (shopId: string) => {
    try {
      const r = await api<{ created: number; totalProducts: number }>('/test-admin/catalog/bulk', { method: 'POST', body: { shopId, count: 50 } });
      setMsg(`Added ${r.created} products (${r.totalProducts} in this shop).`);
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
                <button onClick={() => void bulk(s.id)}>Add 50 test products</button>
              </article>
            ))}
          </div>}</PaginatedList>
        </div>
      )}
    </AsyncState>
  );
}
