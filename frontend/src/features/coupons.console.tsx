import { useState } from 'react';
import { ArrowDown, Check, Layers, Plus, RefreshCw, Search, Tag, Ticket, X } from 'lucide-react';
import { PageActions } from '../components/console/PageActions';
import { PaginatedList } from '../components/console/PaginatedList';
import { statusTone } from '../components/console/statusTone';
import { AsyncState } from '../components/AsyncState';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';

export interface AdminCoupon {
  id: string;
  title: string;
  promoCode: string;
  status: string;
  redeemedCount: number;
  redemptionLimit: number | null;
  startAt: string;
  endAt: string;
  /** Phase 09c: batch of single-use codes, null for a single voucher. */
  batchId: string | null;
  /** Orders that used the coupon (this link exists only on /test-admin). */
  usages: { orderId: string; discountVnd: number; at: string }[];
}
interface CouponPage {
  items: AdminCoupon[];
  next: string;
}

const PAGE = 200;
const couponsUrl = (shopId: string, batchId: string, after = '') =>
  `/test-admin/coupons?${new URLSearchParams({ shopId, limit: String(PAGE), ...(batchId ? { batchId } : {}), ...(after ? { after } : {}) })}`;

/**
 * Read-only overview. Coupon status is derived from the BUSINESS clock: move it on the Clock tab to cross a start/expiry boundary.
 * The first page refreshes every 5 s; "Load more" appends the following pages (cursor `next`).
 */
export function CouponsPanel({ shopId }: { shopId: string }) {
  const [batchId, setBatchId] = useState('');
  // pages loaded with "Load more", kept only for the filter they were loaded with
  const [loaded, setLoaded] = useState<{ key: string; items: AdminCoupon[]; next: string } | null>(null);
  const [msg, setMsg] = useState('');
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const first = useAsync(() => api<CouponPage>(couponsUrl(shopId, batchId)), [shopId, batchId], 5000);
  const key = `${shopId}|${batchId}`;
  const more = loaded?.key === key ? loaded : null;
  const next = more ? more.next : (first.data?.next ?? '');
  const items = [...(first.data?.items ?? []), ...(more?.items ?? [])];
  const filtered = items.filter((c) => (!status || c.status === status) && `${c.promoCode} ${c.title}`.toLowerCase().includes(query.trim().toLowerCase()));

  async function loadMore() {
    if (loadingMore || !next) return;
    setLoadingMore(true);
    try {
      const page = await api<CouponPage>(couponsUrl(shopId, batchId, next));
      setLoaded({ key, items: [...(more?.items ?? []), ...page.items], next: page.next });
    } catch (e) {
      setFailed(true);
      setMsg((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }
  async function loyaltyVouchers() {
    if (creating || !shopId) return;
    setCreating(true);
    setMsg('');
    setFailed(false);
    try {
      const r = await api<{ batches: { title: string; codes: unknown[] }[] }>('/test-admin/scenarios/loyalty-vouchers', { method: 'POST', body: { shopId } });
      setMsg(`Created ${r.batches.map((b) => `${b.title} (${b.codes.length} codes)`).join(', ')}`);
      first.reload();
    } catch (e) {
      setFailed(true);
      setMsg((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="admin-coupons">
      {msg && <div className={failed ? 'state state-error' : 'admin-coupon-notice'} role={failed ? 'alert' : 'status'}>{!failed && <Check size={16} />}{msg}<button type="button" aria-label="Dismiss notification" onClick={() => setMsg('')}><X size={14} /></button></div>}
      <div className="admin-coupon-metrics" aria-label="Loaded coupon summary">
        {[
          { label: 'Codes loaded', value: items.length, icon: Ticket },
          { label: 'Ongoing codes', value: items.filter((c) => c.status === 'ONGOING').length, icon: Tag },
          { label: 'Redemptions', value: items.reduce((sum, c) => sum + c.redeemedCount, 0), icon: Check },
        ].map(({ label, value, icon: Icon }) => <div key={label}><span className="admin-coupon-metric-icon"><Icon size={18} /></span><div><span>{label}</span><strong>{first.data ? value.toLocaleString() : '—'}</strong></div></div>)}
      </div>
      <section className="admin-coupon-register" aria-label="Coupon register">
        <div className="admin-coupon-register-heading"><PageActions>
        <button className="admin-icon-action" onClick={first.reload} disabled={first.loading}><RefreshCw size={14} />Refresh</button>
        <button className="admin-primary admin-icon-action" disabled={creating || !shopId} onClick={() => void loyaltyVouchers()}><Plus size={14} />{creating ? 'Creating batches…' : 'Create loyalty voucher batches'}</button>
      </PageActions><span className="admin-coupon-live"><span />Auto refresh · 5s</span></div>
        <div className="admin-coupon-filters">
          <label className="admin-coupon-search"><Search size={15} aria-hidden="true" /><input aria-label="Search coupons" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search code or voucher name" /></label>
          <label>Status<select aria-label="Coupon status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="ONGOING">Ongoing</option><option value="NOT_START">Not started</option><option value="EXPIRED">Expired</option><option value="DEACTIVATED">Deactivated</option></select></label>
          <label>Batch ID<input aria-label="Filter by batch" value={batchId} placeholder="All batches" onChange={(e) => setBatchId(e.target.value.trim())} /></label>
          {(query || status || batchId) && <button className="admin-text-button" onClick={() => { setQuery(''); setStatus(''); setBatchId(''); }}>Clear filters</button>}
        </div>
      <AsyncState {...first} onRetry={first.reload}>
        {() => items.length === 0 ? (
          <div className="admin-coupon-empty"><span><Ticket size={28} strokeWidth={1.3} /></span><h3>{batchId ? 'No codes in this batch' : 'No vouchers yet'}</h3><p>{batchId ? 'Check the batch ID or clear the filter to see all vouchers.' : 'Create loyalty batches above, or add a voucher in Seller Center.'}</p>{batchId && <button onClick={() => setBatchId('')}>Clear batch filter</button>}</div>
        ) : (
          <>
            <PaginatedList key={JSON.stringify([key, query, status])} items={filtered} label="Coupons">{(visible) => <div className="scroll"><table className="admin-coupons-table">
              <thead><tr><th>Voucher</th><th>Source</th><th>Status</th><th>Redemptions</th><th>Validity</th><th>Orders</th></tr></thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id}>
                    <td><strong className="admin-coupon-code">{c.promoCode}</strong><span className="admin-coupon-title">{c.title}</span></td>
                    <td>{c.batchId ? <button className="admin-coupon-batch" title={c.batchId} aria-label={`Filter batch ${c.batchId}`} onClick={() => setBatchId(c.batchId!)}><Layers size={13} />{c.batchId.slice(0, 8)}</button> : <span className="admin-coupon-single">Single voucher</span>}</td>
                    <td><span className="pill" data-tone={statusTone(c.status)}>{c.status}</span></td>
                    <td><span className="admin-coupon-usage">{c.redeemedCount}<span> / {c.redemptionLimit ?? 'Unlimited'}</span></span>{c.redemptionLimit != null && <progress aria-label={`Redemptions for ${c.promoCode}`} max={c.redemptionLimit} value={c.redeemedCount} />}</td>
                    <td className="admin-coupon-dates"><span>{new Date(c.startAt).toLocaleString()}</span><span>to {new Date(c.endAt).toLocaleString()}</span></td>
                    <td>{c.usages.length ? <details className="admin-coupon-orders"><summary>{c.usages.length} {c.usages.length === 1 ? 'order' : 'orders'}</summary>{c.usages.map((u) => <code key={u.orderId}>{u.orderId}</code>)}</details> : <span className="muted">No orders</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>{filtered.length === 0 && <div className="admin-coupon-no-results">No vouchers match your search. Try another code or clear the filters.</div>}</div>}</PaginatedList>
            {next && <div className="admin-coupon-load-more"><span>More codes are available for this shop.</span><button className="admin-icon-action" disabled={loadingMore} onClick={() => void loadMore()}><ArrowDown size={14} />{loadingMore ? 'Loading…' : 'Load more'}</button></div>}
          </>
        )}
      </AsyncState>
        <div className="admin-coupon-footer"><Layers size={14} /><span>Batch codes are private and single use. Counts reflect loaded codes{batchId ? ' in the selected batch' : ''}.</span></div>
      </section>
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'coupons', label: 'Coupons', order: 60, render: (c) => <CouponsPanel {...c} /> }];
export default tabs;
