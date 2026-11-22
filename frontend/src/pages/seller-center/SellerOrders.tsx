import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search } from 'lucide-react';
import { OrderActions } from '@/components/seller/OrderActions';
import { OrderStatusBadge } from '@/components/seller/OrderStatusBadge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { getFulfillment, listOrders } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import { countByTab, hasPackage, sellerOrderTabs, sellerTabOf, type SellerOrderTab } from '@/lib/sellerOrders';
import type { DemoSession, Order } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { normalizeTitle } from '@/mocks';

const POLL_MS = 10_000;

/** Order ID or buyer name, case- and diacritic-insensitive. */
export const matchesOrder = (o: Order, q: string) => {
  const term = normalizeTitle(q);
  return !term || o.id.toLowerCase().includes(term) || normalizeTitle(o.buyer.name).includes(term);
};

function OrderRow({ seller, order, onChanged }: { seller: DemoSession; order: Order; onChanged: () => void }) {
  const withPackage = hasPackage(order.status);
  const f = useAsync(() => (withPackage ? getFulfillment(seller, order.id) : Promise.resolve(null)), [seller.sessionToken, order.id, order.status]);
  const pkg = f.data?.package ?? null;
  const [first, ...rest] = order.items;
  return (
    <TableRow aria-label={`Order ${order.id}`} className="align-top">
      <TableCell className="max-w-[320px] whitespace-normal py-3 pl-4">
        <div className="flex flex-col gap-1">
          <span className="line-clamp-1 font-medium">
            {first ? `${first.productName} · ${first.skuName} × ${first.quantity}` : '—'}
            {rest.length ? <span className="text-muted-foreground"> +{rest.length} more</span> : null}
          </span>
          <Link to={`/seller-center/orders/${encodeURIComponent(order.id)}`} className="w-fit font-mono text-xs text-teal hover:underline">
            {order.id}
          </Link>
          <span className="text-xs text-muted-foreground">
            {order.buyer.name} · {new Date(order.createdAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}
          </span>
        </div>
      </TableCell>
      <TableCell className="py-3 font-semibold">{shopPrice(order.amounts.totalVnd)}</TableCell>
      <TableCell className="py-3">
        <OrderStatusBadge status={order.status} />
      </TableCell>
      <TableCell className="py-3 text-xs">
        {!withPackage ? (
          <span className="text-muted-2">—</span>
        ) : f.loading && !f.data ? (
          <Skeleton className="h-4 w-24" />
        ) : pkg ? (
          <div className="flex flex-col gap-0.5">
            <span>{pkg.status.charAt(0) + pkg.status.slice(1).toLowerCase().replace(/_/g, ' ')}</span>
            {pkg.trackingNumber ? <span className="font-mono text-muted-foreground">{pkg.trackingNumber}</span> : null}
          </div>
        ) : (
          <span className="text-muted-2">—</span>
        )}
      </TableCell>
      <TableCell className="py-3">
        <OrderActions
          seller={seller}
          orderId={order.id}
          status={order.status}
          releaseAt={order.releaseAt}
          hasTracking={Boolean(pkg?.trackingNumber)}
          onChanged={() => {
            onChanged();
            f.reload();
          }}
        />
      </TableCell>
    </TableRow>
  );
}

function Orders({ seller }: { seller: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const tab = (sellerOrderTabs.find((t) => t.key === params.get('tab'))?.key ?? 'all') as SellerOrderTab;
  const [q, setQ] = useState('');
  const orders = useAsync(() => listOrders(seller), [seller.sessionToken, seller.shopId], POLL_MS);

  const all = [...(orders.data?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counts = countByTab(all);
  const shown = all.filter((o) => (tab === 'all' || sellerTabOf(o.status) === tab) && matchesOrder(o, q));

  return (
    <div className="flex flex-col gap-4">

      <div className="rounded-card bg-white shadow-xs ring-1 ring-line-soft">
        <Tabs value={tab} onValueChange={(v) => setParams(v === 'all' ? {} : { tab: v }, { replace: true })}>
          <TabsList variant="line" className="h-12 w-full justify-start gap-2 overflow-x-auto overflow-y-hidden rounded-none border-b border-line-soft px-4 [scrollbar-width:none]">
            {sellerOrderTabs.map((t) => (
              <TabsTrigger key={t.key} value={t.key} className="flex-none px-3 after:bg-teal data-[state=active]:font-semibold data-[state=active]:text-teal">
                {t.label} ({counts[t.key]})
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="p-4">
          <label className="flex h-10 max-w-sm items-center gap-2 rounded-full border border-line px-4 focus-within:ring-2 focus-within:ring-ring/40">
            <Search className="size-4 text-muted-foreground" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Order ID / Buyer name"
              aria-label="Filter by order ID or buyer name"
              className="h-full w-full bg-transparent text-sm outline-none placeholder:text-muted-2"
            />
          </label>
        </div>

        {orders.loading && !orders.data ? (
          <div className="flex flex-col gap-2 p-4 pt-0" role="status" aria-label="Loading orders">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}
          </div>
        ) : orders.error && !orders.data ? (
          <div className="p-4 pt-0">
            <Alert variant="destructive">
              <AlertDescription>
                <p>Could not load orders: {orders.error.message}</p>
                <Button variant="outline" size="sm" className="mt-1" onClick={orders.reload}>
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-4 pb-10 pt-6 text-center text-sm text-muted-foreground">{q ? `No orders match “${q}”.` : 'No orders in this tab.'}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-surface-2 hover:bg-surface-2">
                <TableHead className="pl-4">Product</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Package</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((o) => (
                <OrderRow key={o.id} seller={seller} order={o} onChanged={orders.reload} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

export function SellerOrders() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Orders key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
