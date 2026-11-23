import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import { OrderActions } from '@/components/seller/OrderActions';
import { OrderStatusBadge } from '@/components/seller/OrderStatusBadge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getFulfillment, getOrder } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import type { DemoSession, Order, OrderHistoryEntry } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

const POLL_MS = 10_000;

// reachedBy holds raw history statuses: ON_HOLD only appears in history written before it was removed (DECISIONS H12)
const STEPS: { label: string; reachedBy: string[] }[] = [
  { label: 'Placed', reachedBy: ['UNPAID'] },
  { label: 'Paid', reachedBy: ['AWAITING_SHIPMENT', 'ON_HOLD'] },
  { label: 'Shipment arranged', reachedBy: ['AWAITING_COLLECTION'] },
  { label: 'In transit', reachedBy: ['PARTIALLY_SHIPPING', 'IN_TRANSIT'] },
  { label: 'Delivered', reachedBy: ['DELIVERED', 'COMPLETED'] },
];
const stepOf = (s: string) => STEPS.findIndex((step) => step.reachedBy.includes(s));

export interface Progress {
  /** Index of the last step reached. */
  current: number;
  cancelled: boolean;
  /** When each step was first reached, if known. */
  at: (string | null)[];
}

/** Where the order is on Placed > Paid > Shipment arranged > In transit > Delivered, from its status and history. */
export function orderProgress(order: Order, history: OrderHistoryEntry[]): Progress {
  const at = STEPS.map((step, i) => {
    if (i === 0) return order.createdAt;
    if (i === 1 && order.paidAt) return order.paidAt;
    return history.find((h) => step.reachedBy.includes(h.to))?.at ?? null;
  });
  if (order.status !== 'CANCELLED') return { current: stepOf(order.status), cancelled: false, at };
  const reached = history.map((h) => stepOf(h.to)).filter((i) => i >= 0);
  return { current: reached.length ? Math.max(...reached) : 0, cancelled: true, at };
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '');
const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

function StepBar({ progress, cancelReason }: { progress: Progress; cancelReason: string | null }) {
  return (
    <section aria-label="Order progress" className="rounded-card bg-white p-5 shadow-xs ring-1 ring-line-soft">
      <ol className="grid grid-cols-5 gap-2">
        {STEPS.map((s, i) => {
          const done = i <= progress.current;
          const current = i === progress.current && !progress.cancelled;
          return (
            <li key={s.label} aria-current={current ? 'step' : undefined} className="flex flex-col items-center gap-1.5 text-center">
              <div className="flex w-full items-center">
                <span className={cn('h-0.5 flex-1', i === 0 ? 'invisible' : done ? (progress.cancelled ? 'bg-muted-2' : 'bg-teal') : 'bg-line')} />
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold',
                    done ? (progress.cancelled ? 'border-muted-2 bg-muted-2 text-white' : 'border-teal bg-teal text-white') : 'border-line bg-white text-muted-2',
                  )}
                >
                  {done ? <Check className="size-4" /> : i + 1}
                </span>
                <span className={cn('h-0.5 flex-1', i === STEPS.length - 1 ? 'invisible' : i < progress.current ? (progress.cancelled ? 'bg-muted-2' : 'bg-teal') : 'bg-line')} />
              </div>
              <span className={cn('text-xs font-semibold', done ? 'text-ink' : 'text-muted-2')}>{s.label}</span>
              <span className="text-[11px] text-muted-2">{done ? when(progress.at[i]) : ''}</span>
            </li>
          );
        })}
      </ol>
      {progress.cancelled ? <p className="mt-3 text-center text-sm font-semibold text-muted-foreground">Cancelled{cancelReason ? `: ${cancelReason}` : ''}</p> : null}
    </section>
  );
}

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('rounded-card bg-white p-5 shadow-xs ring-1 ring-line-soft', className)}>
      <h2 className="mb-3 text-base font-bold">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Detail({ seller, id }: { seller: DemoSession; id: string }) {
  const detail = useAsync(() => getOrder(seller, id), [seller.sessionToken, id], POLL_MS);
  const f = useAsync(() => getFulfillment(seller, id).catch(() => null), [seller.sessionToken, id, detail.data?.order.status], POLL_MS);
  const back = (
    <Link to="/seller-center/orders" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-ink">
      <ArrowLeft className="size-4" /> Back to orders
    </Link>
  );

  if (detail.loading && !detail.data) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label="Loading order">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-56 rounded-card" />
      </div>
    );
  }
  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <p className="rounded-card bg-white p-10 text-center text-muted-foreground ring-1 ring-line-soft">Order not found.</p>
      </div>
    );
  }
  if (detail.error && !detail.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>Could not load the order: {detail.error.message}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={detail.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!detail.data) return null;

  const { order, history } = detail.data;
  const pkg = f.data?.package ?? null;
  const a = order.amounts;
  const refresh = () => {
    detail.reload();
    f.reload();
  };

  return (
    <div className="flex flex-col gap-4">
      {back}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">
          Order <span className="font-mono">{order.id}</span>
        </h1>
        <OrderStatusBadge status={order.status} />
        <OrderActions seller={seller} orderId={order.id} status={order.status} hasTracking={Boolean(pkg?.trackingNumber)} onChanged={refresh} className="ml-auto" />
      </div>

      <StepBar progress={orderProgress(order, history)} cancelReason={order.cancelReason} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Items">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>Seller SKU</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Subtotal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.items.map((i) => (
                  <TableRow key={i.skuId}>
                    <TableCell className="whitespace-normal">
                      {i.productName} <span className="text-muted-foreground">· {i.skuName}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{i.sellerSku}</TableCell>
                    <TableCell className="text-right">{shopPrice(i.unitPriceVnd)}</TableCell>
                    <TableCell className="text-right">{i.quantity}</TableCell>
                    <TableCell className="text-right">{shopPrice(i.unitPriceVnd * i.quantity)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="ml-auto mt-3 max-w-xs" aria-label="Amounts">
              <Rows
                rows={[
                  ['Product total', shopPrice(a.productTotalVnd)],
                  ['Seller discount', `-${shopPrice(a.sellerDiscountVnd)}`],
                  ['Platform discount', `-${shopPrice(a.platformDiscountVnd)}`],
                  ['Shipping fee', shopPrice(a.shippingFeeVnd)],
                  ['Tax', shopPrice(a.taxVnd)],
                  ['Total', <span key="t" className="font-bold text-teal">{shopPrice(a.totalVnd)}</span>],
                ]}
              />
            </div>
          </Card>

          <Card title="Status history">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>From → To</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h, i) => (
                  <TableRow key={`${h.at}-${i}`}>
                    <TableCell className="text-xs">{when(h.at)}</TableCell>
                    <TableCell className="text-xs">
                      {h.from ? humanize(h.from) : 'New'} → {humanize(h.to)}
                    </TableCell>
                    <TableCell className="text-xs">{humanize(h.actor)}</TableCell>
                    <TableCell className="whitespace-normal text-xs text-muted-foreground">{h.note || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Recipient">
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-semibold">
                {order.recipient.name} <span className="font-normal text-muted-foreground">· {order.recipient.phone}</span>
              </span>
              <span className="text-muted-foreground">{[order.recipient.addressLine, order.recipient.district, order.recipient.city].join(', ')}</span>
              <span className="mt-2 text-xs font-semibold">Buyer message</span>
              {/* the /demo order view does not include buyerMessage */}
              <span className="text-xs text-muted-2">Not provided by the demo API.</span>
            </div>
          </Card>
          <Card title="Package">
            {pkg ? (
              <Rows
                rows={[
                  ['Package ID', <span key="i" className="font-mono">{pkg.id}</span>],
                  ['Status', humanize(pkg.status)],
                  ['Carrier', pkg.provider],
                  ['Tracking', <span key="t" className="font-mono">{pkg.trackingNumber ?? '—'}</span>],
                ]}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {f.data?.blockedReason === 'order_unpaid' ? 'Waiting for payment.' : 'No package yet.'}
              </p>
            )}
          </Card>
          <Card title="Payment">
            <Rows
              rows={[
                ['Method', 'Simulated payment'],
                ['Paid at', order.paidAt ? when(order.paidAt) : 'Not paid'],
                ['Total', shopPrice(a.totalVnd)],
              ]}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

export function SellerOrderDetail() {
  const { seller } = useAuth();
  const { id = '' } = useParams();
  // the route is guarded by RequireRole SELLER
  return seller ? <Detail key={`${seller.sessionToken}:${id}`} seller={seller} id={id} /> : null;
}
