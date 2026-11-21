import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Store } from 'lucide-react';
import { OrderStatusBadge } from '@/components/seller/OrderStatusBadge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { getCatalog, getCoupons, getShop, listAftersale, listConversations, listCouponBatches, listOrders } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import { countByTab, OPEN_AFTERSALE } from '@/lib/sellerOrders';
import type { Aftersale, Conversation, DemoSession, Order } from '@/lib/types';
import { useAsync, type AsyncResult } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

const POLL_MS = 30_000;
const LOW_STOCK = 5;

export function greeting(now: Date): string {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export interface SellerTodo {
  toPay: number;
  onHold: number;
  toShip: number;
  inTransit: number;
  returns: number;
  unread: number;
}

/** To-do counts from real orders, aftersale requests and conversations; null when that source is not loaded. */
export function sellerTodo(orders?: Order[], aftersale?: Aftersale[], conversations?: Conversation[]): { [K in keyof SellerTodo]: number | null } {
  const tabs = orders ? countByTab(orders) : null;
  return {
    toPay: tabs?.unpaid ?? null,
    // part of To ship, shown on its own because these orders cannot be shipped yet
    onHold: orders ? orders.filter((o) => o.status === 'ON_HOLD').length : null,
    toShip: tabs?.['to-ship'] ?? null,
    inTransit: tabs?.shipped ?? null,
    returns: aftersale ? aftersale.filter((r) => OPEN_AFTERSALE.includes(r.status)).length : null,
    unread: conversations ? conversations.reduce((n, c) => n + c.unread, 0) : null,
  };
}

function Panel({ title, action, children, className, label }: { title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={cn('seller-card rounded-card bg-white p-5 shadow-xs ring-1 ring-line-soft', className)}>
      <div className="mb-4 flex items-center gap-2">
        <h2 className="text-base font-bold">{title}</h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function LoadError({ result, what }: { result: AsyncResult<unknown>; what: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>
        <p>
          Could not load {what}: {result.error?.message}
        </p>
        <button type="button" onClick={result.reload} className="cursor-pointer text-sm font-semibold underline">
          Try again
        </button>
      </AlertDescription>
    </Alert>
  );
}

function TodoTile({ label, count, to, loading }: { label: string; count: number | null; to: string; loading: boolean }) {
  return (
    <Link to={to} className="group flex flex-col gap-1 rounded-xl bg-surface-2 px-4 py-3 transition-colors hover:bg-teal-soft">
      {loading ? <Skeleton className="h-8 w-10" /> : <span className="text-2xl font-bold text-ink group-hover:text-teal">{count ?? '—'}</span>}
      <span className="text-sm text-muted-foreground">{label}</span>
    </Link>
  );
}

function BusinessOverview({ orders }: { orders: AsyncResult<{ items: Order[] }> }) {
  const rows = orders.data?.items ?? [];
  const metrics = [
    { label: 'Total orders', value: rows.length.toLocaleString() },
    { label: 'Paid order value', value: shopPrice(rows.filter((o) => o.paidAt && o.status !== 'CANCELLED').reduce((sum, o) => sum + o.amounts.totalVnd, 0)) },
    { label: 'Delivered orders', value: rows.filter((o) => o.status === 'DELIVERED').length.toLocaleString() },
    { label: 'Completed orders', value: rows.filter((o) => o.status === 'COMPLETED').length.toLocaleString() },
  ];
  return <Panel title="Business overview" label="Business overview" action={<span className="seller-metric-scope">All shop orders</span>}>
    {orders.error && !orders.data ? <LoadError result={orders} what="business metrics" /> : <div className="seller-business-metrics">{metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span>{orders.loading && !orders.data ? <Skeleton className="h-8 w-20" /> : <strong>{orders.data ? metric.value : '—'}</strong>}</div>)}</div>}
  </Panel>;
}

function ShopCard({ seller }: { seller: DemoSession }) {
  const shop = useAsync(() => getShop(seller), [seller.sessionToken, seller.shopId]);
  const catalog = useAsync(() => getCatalog(seller), [seller.sessionToken, seller.shopId]);
  const coupons = useAsync(() => getCoupons(seller), [seller.sessionToken, seller.shopId]);
  const batches = useAsync(() => listCouponBatches(seller), [seller.sessionToken, seller.shopId]);
  const lowStock = catalog.data?.items.flatMap((p) => p.skus).filter((s) => s.status === 'NORMAL' && s.totalStock <= LOW_STOCK).length;
  const value = (r: AsyncResult<unknown>, v: ReactNode) => (r.loading && !r.data ? <Skeleton className="h-4 w-8" /> : r.error && !r.data ? '—' : v);
  return (
    <Panel title="Shop" label="Shop" action={<Store className="size-4 text-muted-foreground" aria-hidden />}>
      {shop.error && !shop.data ? (
        <LoadError result={shop} what="the shop" />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-1">
            {shop.data ? <span className="text-lg font-semibold">{shop.data.name}</span> : <Skeleton className="h-6 w-40" />}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              {shop.data ? (
                <>
                  <span>Region {shop.data.region}</span>
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', shop.data.status === 'ACTIVE' ? 'bg-teal-soft text-teal' : 'bg-surface text-muted-foreground')}>
                    {shop.data.status.charAt(0) + shop.data.status.slice(1).toLowerCase()}
                  </span>
                </>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              ['Products', value(catalog, catalog.data?.items.length), '/seller-center/products'],
              ['Active vouchers', value(coupons, coupons.data?.items.filter((c) => c.status === 'ONGOING').length), '/seller-center/vouchers'],
              [`Low stock (≤${LOW_STOCK})`, value(catalog, lowStock), '/seller-center/products?filter=low-stock'],
            ].map(([k, v, to]) => (
              <Link key={String(k)} to={String(to)} className="flex flex-col items-center gap-1 rounded-xl bg-surface-2 px-2 py-3 hover:bg-teal-soft">
                <span className="text-xl font-bold">{v}</span>
                <span className="text-xs text-muted-foreground">{k}</span>
              </Link>
            ))}
          </div>
          <Link to="/seller-center/vouchers?tab=batches" className="mt-3 flex items-center gap-1 text-sm text-muted-foreground hover:text-teal">
            Code batches: {value(batches, batches.data?.items.filter((b) => b.status === 'ONGOING').length)} active
          </Link>
        </>
      )}
    </Panel>
  );
}

function LatestOrders({ orders }: { orders: AsyncResult<{ items: Order[] }> }) {
  const latest = [...(orders.data?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  return (
    <Panel
      title="Latest orders"
      label="Latest orders"
      action={
        <Link to="/seller-center/orders" className="flex items-center text-sm font-semibold text-teal hover:underline">
          View all <ChevronRight className="size-4" />
        </Link>
      }
    >
      {orders.loading && !orders.data ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}
        </div>
      ) : orders.error && !orders.data ? (
        <LoadError result={orders} what="orders" />
      ) : latest.length === 0 ? (
        <p className="text-sm text-muted-foreground">No orders yet.</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {latest.map((o) => (
            <li key={o.id}>
              <Link to={`/seller-center/orders/${encodeURIComponent(o.id)}`} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-3 hover:bg-surface-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-mono text-sm">{o.id}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {o.buyer.name} · {o.items.map((i) => `${i.quantity}× ${i.productName}`).join(', ')}
                  </span>
                </div>
                <span className="hidden text-xs text-muted-2 sm:inline">{new Date(o.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</span>
                <OrderStatusBadge status={o.status} />
                <span className="w-28 text-right text-sm font-semibold">{shopPrice(o.amounts.totalVnd)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Home({ seller }: { seller: DemoSession }) {
  const deps = [seller.sessionToken, seller.shopId];
  const orders = useAsync(() => listOrders(seller), deps, POLL_MS);
  const aftersale = useAsync(() => listAftersale(seller), deps, POLL_MS);
  const chats = useAsync(() => listConversations(seller), deps, POLL_MS);
  const todo = sellerTodo(orders.data?.items, aftersale.data?.items, chats.data?.items);
  const tiles: { label: string; count: number | null; to: string; source: AsyncResult<unknown> }[] = [
    { label: 'To pay', count: todo.toPay, to: '/seller-center/orders?tab=unpaid', source: orders },
    { label: 'On hold', count: todo.onHold, to: '/seller-center/orders?tab=to-ship', source: orders },
    { label: 'To ship', count: todo.toShip, to: '/seller-center/orders?tab=to-ship', source: orders },
    { label: 'In transit', count: todo.inTransit, to: '/seller-center/orders?tab=shipped', source: orders },
    { label: 'Returns', count: todo.returns, to: '/seller-center/returns?status=open', source: aftersale },
    { label: 'Unread messages', count: todo.unread, to: '/seller-center/messages?filter=unread', source: chats },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Panel title="To-do list" label="To-do list">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {tiles.map((t) => (
                <TodoTile key={t.label} label={t.label} count={t.count} to={t.to} loading={t.source.loading && !t.source.data} />
              ))}
            </div>
          </Panel>
          <BusinessOverview orders={orders} />
          <LatestOrders orders={orders} />
        </div>
        <div className="flex flex-col gap-5">
          <ShopCard seller={seller} />
        </div>
      </div>
    </div>
  );
}

export function SellerHome() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Home key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
