import { AsyncState } from '../components/AsyncState';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';
import { statusTone } from '../components/console/statusTone';

interface AdminCoupon {
  id: string;
  title: string;
  promoCode: string;
  status: string;
  redeemedCount: number;
  redemptionLimit: number | null;
  startAt: string;
  endAt: string;
}

/** Read-only overview. Coupon status is derived from the BUSINESS clock: move it on the Clock tab to cross a start/expiry boundary. */
export function CouponsPanel({ shopId }: { shopId: string }) {
  const list = useAsync(() => api<{ items: AdminCoupon[] }>(`/test-admin/coupons?shopId=${encodeURIComponent(shopId)}`), [shopId], 5000);
  return (
    <div>
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No coupons for this shop.">
        {(d) => (
          <table>
            <thead><tr><th>Code</th><th>Title</th><th>Status</th><th>Used</th><th>From</th><th>Until</th></tr></thead>
            <tbody>
              {d.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.promoCode}</td>
                  <td>{c.title}</td>
                  <td><span className="pill" data-tone={statusTone(c.status)}>{c.status}</span></td>
                  <td>{c.redeemedCount}{c.redemptionLimit != null ? ` / ${c.redemptionLimit}` : ''}</td>
                  <td>{new Date(c.startAt).toLocaleString()}</td>
                  <td>{new Date(c.endAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncState>
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'coupons', label: 'Coupons', order: 60, render: (c) => <CouponsPanel {...c} /> }];
export default tabs;
