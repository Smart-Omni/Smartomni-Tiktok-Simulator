import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
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
  const first = useAsync(() => api<CouponPage>(couponsUrl(shopId, batchId)), [shopId, batchId], 5000);
  const key = `${shopId}|${batchId}`;
  const more = loaded?.key === key ? loaded : null;
  const next = more ? more.next : (first.data?.next ?? '');

  async function loadMore() {
    try {
      const page = await api<CouponPage>(couponsUrl(shopId, batchId, next));
      setLoaded({ key, items: [...(more?.items ?? []), ...page.items], next: page.next });
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  async function loyaltyVouchers() {
    try {
      const r = await api<{ batches: { title: string; codes: unknown[] }[] }>('/test-admin/scenarios/loyalty-vouchers', { method: 'POST', body: { shopId } });
      setMsg(`Created ${r.batches.map((b) => `${b.title} (${b.codes.length} codes)`).join(', ')}`);
      first.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div>
      <PageActions><button className="admin-icon-action" onClick={first.reload}><RefreshCw size={13} />Refresh</button></PageActions>
      <div className="row-wrap">
        <button onClick={() => void loyaltyVouchers()}>Create loyalty voucher batches</button>
        <label>
          Batch{' '}
          <input aria-label="Filter by batch" value={batchId} placeholder="batch id" onChange={(e) => setBatchId(e.target.value.trim())} />
        </label>
        <span className="muted">Create coupons and code batches in the Seller view. Voucher creation is deliberately not available on the TikTok API router.</span>
      </div>
      {msg ? <p className="muted">{msg}</p> : null}
      <AsyncState {...first} onRetry={first.reload} isEmpty={(d) => d.items.length === 0} emptyText="No coupons for this shop.">
        {(d) => (
          <>
            <PaginatedList key={key} items={[...d.items, ...(more?.items ?? [])]} label="Coupons">{(visible) => <div className="scroll"><table className="admin-data-table">
              <thead><tr><th>Code</th><th>Title</th><th>Batch</th><th>Status</th><th>Used</th><th>Used in order</th><th>From</th><th>Until</th></tr></thead>
              <tbody>
                {visible.map((c) => (
                  <tr key={c.id}>
                    <td>{c.promoCode}</td>
                    <td>{c.title}</td>
                    <td title={c.batchId ?? undefined}>{c.batchId ? <button onClick={() => setBatchId(c.batchId!)}>{c.batchId.slice(0, 8)}</button> : '—'}</td>
                    <td><span className="pill" data-tone={statusTone(c.status)}>{c.status}</span></td>
                    <td>{c.redeemedCount}{c.redemptionLimit != null ? ` / ${c.redemptionLimit}` : ''}</td>
                    <td>{c.usages.length ? c.usages.map((u) => u.orderId).join(', ') : '—'}</td>
                    <td>{new Date(c.startAt).toLocaleString()}</td>
                    <td>{new Date(c.endAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>}</PaginatedList>
            {next ? <button onClick={() => void loadMore()}>Load more</button> : null}
          </>
        )}
      </AsyncState>
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'coupons', label: 'Coupons', order: 60, render: (c) => <CouponsPanel {...c} /> }];
export default tabs;
