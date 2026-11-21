import { ShopFooter } from '@/components/shop/ShopFooter';
import { BuyerAftersaleRequests } from '@/components/shop/BuyerAftersaleRequests';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PackageSearch, Store, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { QuantityStepper } from '@/components/shop/QuantityStepper';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { cancelOrder, getFulfillment, inShop, listAftersale, listBuyerOrders, payOrder, requestCancellation, requestReturn } from '@/lib/endpoints';
import { holdTime, shopPrice } from '@/lib/format';
import type { Aftersale, AftersaleList, DemoSession, Order, OrderStatus, ReturnRequest } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

const POLL_MS = 10_000;

/** The session pointed at the shop that sold `order`: shop-scoped calls (pay, cancel, tracking, returns) use it. */
const inOrderShop = (buyer: DemoSession, order: Order | undefined): DemoSession => inShop(buyer, order?.shopId ?? order?.shop?.id ?? buyer.shopId);

/** Aftersale requests of every shop the buyer ordered from, as one list. */
type BuyerAftersaleList = Omit<AftersaleList, 'items'> & { items: (Aftersale & { shopId: string })[]; unavailableShopIds: string[] };
async function listAftersaleOfShops(buyer: DemoSession, orders: Order[]): Promise<BuyerAftersaleList> {
  const shopIds = [...new Set(orders.map((o) => o.shopId ?? o.shop?.id ?? buyer.shopId))];
  const results = await Promise.all(shopIds.map(async (id) => ({ shopId: id, data: await listAftersale(inShop(buyer, id)).catch(() => null) })));
  const lists = results.flatMap((r) => r.data ? [{ ...r.data, items: r.data.items.map((item) => ({ ...item, shopId: r.shopId })) }] : []);
  return { items: lists.flatMap((l) => l.items), requestReasons: lists[0]?.requestReasons ?? [], rejectReasons: lists[0]?.rejectReasons ?? [], unavailableShopIds: results.filter((r) => !r.data).map((r) => r.shopId) };
}

export type OrderTab = 'all' | 'to-pay' | 'to-ship' | 'shipping' | 'delivered' | 'cancelled';

export const orderTabs: { key: OrderTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'to-pay', label: 'To pay' },
  { key: 'to-ship', label: 'To ship' },
  { key: 'shipping', label: 'Shipping' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

/** Which tab (other than All) a backend order status belongs to. */
export function tabOf(status: OrderStatus): Exclude<OrderTab, 'all'> {
  switch (status) {
    case 'UNPAID':
      return 'to-pay';
    case 'ON_HOLD':
    case 'AWAITING_SHIPMENT':
    case 'AWAITING_COLLECTION':
      return 'to-ship';
    case 'PARTIALLY_SHIPPING':
    case 'IN_TRANSIT':
      return 'shipping';
    case 'DELIVERED':
    case 'COMPLETED':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
  }
}

export type OrderAction = 'pay' | 'cancel' | 'request-cancel' | 'track' | 'return';

/**
 * Buyer actions per status (same rules as the former /buyer Orders and Returns tabs):
 * UNPAID/ON_HOLD cancel at once; AWAITING_SHIPMENT asks the seller (aftersale cancellation) unless already asked;
 * shipped orders can be tracked; DELIVERED/COMPLETED can request a return.
 */
export function actionsFor(order: Pick<Order, 'status' | 'buyerRequestedCancel'>): OrderAction[] {
  switch (order.status) {
    case 'UNPAID':
      return ['cancel', 'pay'];
    case 'ON_HOLD':
      return ['cancel'];
    case 'AWAITING_SHIPMENT':
      return order.buyerRequestedCancel ? [] : ['request-cancel'];
    case 'AWAITING_COLLECTION':
    case 'PARTIALLY_SHIPPING':
    case 'IN_TRANSIT':
      return ['track'];
    case 'DELIVERED':
    case 'COMPLETED':
      return ['track', 'return'];
    case 'CANCELLED':
      return [];
  }
}

const statusStyle: Record<Exclude<OrderTab, 'all'>, string> = {
  'to-pay': 'bg-buyer-soft text-buyer-ink',
  'to-ship': 'bg-[#FFF4E0] text-[#9A5B00]',
  shipping: 'bg-teal-soft text-teal',
  delivered: 'bg-free-ship/10 text-free-ship',
  cancelled: 'bg-surface text-muted-foreground',
};

const statusLabel: Record<OrderStatus, string> = {
  UNPAID: 'To pay',
  ON_HOLD: 'Confirming',
  AWAITING_SHIPMENT: 'To ship',
  AWAITING_COLLECTION: 'Packed',
  PARTIALLY_SHIPPING: 'Partly shipped',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** One-line status explanation on the order card. */
export function hint(o: Order): string {
  switch (o.status) {
    case 'UNPAID':
      return 'Pay to send your order to the seller.';
    case 'ON_HOLD':
      return o.releaseAt ? `Confirming payment · ready to ship after ${holdTime(o.releaseAt)}` : 'Payment received. The order is being confirmed.';
    case 'AWAITING_SHIPMENT':
      return o.buyerRequestedCancel ? 'Cancellation requested, waiting for the seller.' : 'The seller is preparing your order.';
    case 'AWAITING_COLLECTION':
      return 'Packed and waiting for the carrier.';
    case 'PARTIALLY_SHIPPING':
    case 'IN_TRANSIT':
      return 'Your order is on the way.';
    case 'DELIVERED':
      return 'Delivered. Something wrong? Request a return.';
    case 'COMPLETED':
      return 'Order completed.';
    case 'CANCELLED':
      return o.cancelReason ? `Cancelled: ${o.cancelReason}` : 'Cancelled.';
  }
}

/** DAMAGED_ITEM -> "Damaged item". */
export const humanize = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

const CANCEL_REASONS = ['CHANGED_MIND', 'ORDERED_BY_MISTAKE', 'WRONG_ADDRESS', 'OTHER'];
const FALLBACK_RETURN_REASONS = ['CHANGED_MIND', 'DAMAGED_ITEM', 'NOT_AS_DESCRIBED', 'WRONG_ITEM', 'OTHER'];

function StatusBadge({ status }: { status: OrderStatus }) {
  return <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', statusStyle[tabOf(status)])}>{statusLabel[status]}</span>;
}

function ReasonList({ id, reasons, value, onChange }: { id: string; reasons: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <RadioGroup value={value} onValueChange={onChange} aria-labelledby={id} className="gap-2">
      {reasons.map((r) => (
        <Label key={r} className="flex cursor-pointer items-center gap-2.5 font-normal">
          <RadioGroupItem value={r} />
          {humanize(r)}
        </Label>
      ))}
    </RadioGroup>
  );
}

function CancelDialog({ order, onClose, onConfirm }: { order: Order; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState(CANCEL_REASONS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const asks = order.status === 'AWAITING_SHIPMENT';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="font-sans sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{asks ? 'Request cancellation' : 'Cancel this order?'}</DialogTitle>
          <DialogDescription>{asks ? 'The seller has to approve the cancellation.' : 'The order is cancelled right away.'}</DialogDescription>
        </DialogHeader>
        <span id="cancel-reason" className="text-sm font-semibold">
          Reason
        </span>
        <ReasonList id="cancel-reason" reasons={CANCEL_REASONS} value={reason} onChange={setReason} />
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep order
          </Button>
          <Button
            className="!bg-[#171717] text-white hover:!bg-[#333333] !rounded-lg"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onConfirm(reason);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            {asks ? 'Send request' : 'Cancel order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReturnDialog({ order, reasons, onClose, onSubmit }: { order: Order; reasons: string[]; onClose: () => void; onSubmit: (body: ReturnRequest) => Promise<void> }) {
  const [type, setType] = useState<ReturnRequest['returnType']>('REFUND');
  const [reason, setReason] = useState(reasons[0] ?? 'OTHER');
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const items = Object.entries(picked).map(([skuId, quantity]) => ({ skuId, quantity }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="font-sans sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request return</DialogTitle>
          <DialogDescription>
            Order <span className="font-mono">{order.id}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <span id="return-type" className="text-sm font-semibold">
            Type
          </span>
          <RadioGroup value={type} onValueChange={(v) => setType(v as ReturnRequest['returnType'])} aria-labelledby="return-type" className="flex gap-5">
            <Label className="flex cursor-pointer items-center gap-2 font-normal">
              <RadioGroupItem value="REFUND" /> Refund only
            </Label>
            <Label className="flex cursor-pointer items-center gap-2 font-normal">
              <RadioGroupItem value="RETURN_AND_REFUND" /> Return and refund
            </Label>
          </RadioGroup>
        </div>
        <div className="flex flex-col gap-2">
          <span id="return-reason" className="text-sm font-semibold">
            Reason
          </span>
          <ReasonList id="return-reason" reasons={reasons} value={reason} onChange={setReason} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Items</span>
          <ul className="flex flex-col gap-2">
            {order.items.map((i) => {
              const name = `${i.productName} (${i.skuName})`;
              const on = i.skuId in picked;
              return (
                <li key={i.skuId} className="flex items-center gap-3 rounded-lg border border-line-soft px-3 py-2">
                  <Checkbox
                    checked={on}
                    aria-label={`Return ${name}`}
                    onCheckedChange={(v) =>
                      setPicked((p) => {
                        const next = { ...p };
                        if (v === true) next[i.skuId] = 1;
                        else delete next[i.skuId];
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                  <QuantityStepper
                    size="sm"
                    value={picked[i.skuId] ?? 1}
                    max={i.quantity}
                    disabled={!on}
                    label={`Units of ${name} to return`}
                    onChange={(n) => setPicked((p) => ({ ...p, [i.skuId]: n }))}
                  />
                </li>
              );
            })}
          </ul>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            className="!bg-[#171717] text-white hover:!bg-[#333333] !rounded-lg"
            disabled={busy || items.length === 0}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onSubmit({ orderId: order.id, items, returnType: type, reason });
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrackingPanel({ buyer, order }: { buyer: DemoSession; order: Order | undefined }) {
  const f = useAsync(() => (order ? getFulfillment(inOrderShop(buyer, order), order.id) : Promise.resolve(null)), [buyer.sessionToken, order?.id, order?.status], POLL_MS);
  return (
    <section aria-labelledby="tracking" className="flex flex-col gap-4 rounded-card bg-white p-5 shadow-xs ring-1 ring-line-soft">
      <div className="flex items-center gap-2">
        <Truck className="size-5 text-teal" aria-hidden />
        <h2 id="tracking" className="text-lg font-bold">
          Tracking
        </h2>
      </div>
      {!order ? (
        <p className="text-sm text-muted-foreground">Choose Track on an order to follow its delivery.</p>
      ) : f.loading && !f.data ? (
        <Skeleton className="h-32" />
      ) : f.error && !f.data ? (
        <Alert variant="destructive">
          <AlertDescription>{f.error.message}</AlertDescription>
        </Alert>
      ) : f.data ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Order</dt>
            <dd className="font-mono">{order.id}</dd>
            <dt className="text-muted-foreground">Carrier</dt>
            <dd>{f.data.package?.provider ?? '—'}</dd>
            <dt className="text-muted-foreground">Tracking no.</dt>
            <dd className="font-mono">{f.data.package?.trackingNumber ?? '—'}</dd>
            <dt className="text-muted-foreground">Package</dt>
            <dd>{f.data.package?.status ? humanize(f.data.package.status) : '—'}</dd>
          </dl>
          {f.data.tracking.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {f.data.blockedReason === 'order_on_hold' ? 'Your order is being confirmed. The seller can ship it shortly.' : 'The seller has not shipped this order yet.'}
            </p>
          ) : (
            <ol className="flex flex-col" aria-label="Tracking timeline">
              {[...f.data.tracking].reverse().map((e, i) => (
                <li key={`${e.at}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
                  <span className={cn('mt-1 size-2.5 shrink-0 rounded-full', i === 0 ? 'bg-teal ring-4 ring-teal-soft' : 'bg-line')} aria-hidden />
                  <div className="flex flex-col">
                    <span className={cn('text-sm', i === 0 ? 'font-semibold' : 'text-muted-foreground')}>{e.description}</span>
                    <span className="text-xs text-muted-2">{new Date(e.at).toLocaleString('en-GB')}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      ) : null}
    </section>
  );
}

function OrderCard({
  order,
  shopName,
  request,
  requests,
  buyer,
  onReturnChanged,
  tracked,
  onAction,
}: {
  order: Order;
  shopName: string;
  request: Aftersale | undefined;
  requests: Aftersale[];
  buyer: DemoSession;
  onReturnChanged: () => void;
  tracked: boolean;
  onAction: (a: OrderAction) => void;
}) {
  const actions = actionsFor(order);
  const button = (a: OrderAction): ReactNode => {
    switch (a) {
      case 'pay':
        return (
          <Button key={a} size="sm" className="!bg-[#171717] px-4 text-white hover:!bg-[#333333] !rounded-lg" onClick={() => onAction(a)}>
            Pay now
          </Button>
        );
      case 'cancel':
      case 'request-cancel':
        return (
          <Button key={a} size="sm" variant="outline" onClick={() => onAction(a)}>
            Cancel
          </Button>
        );
      case 'track':
        return (
          <Button key={a} size="sm" variant="outline" aria-pressed={tracked} className={cn(tracked && 'border-teal text-teal')} onClick={() => onAction(a)}>
            Track
          </Button>
        );
      case 'return':
        return (
          <Button key={a} size="sm" variant="outline" onClick={() => onAction(a)}>
            Request return
          </Button>
        );
    }
  };
  return (
    <article aria-label={`Order ${order.id}`} className={cn('rounded-card bg-white p-5 shadow-xs ring-1', tracked ? 'ring-teal' : 'ring-line-soft')}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft pb-3">
        <Store className="size-4" aria-hidden />
        <span className="text-sm font-semibold">{shopName}</span>
        <span className="font-mono text-xs text-muted-foreground">#{order.id}</span>
        <span className="ml-auto">
          <StatusBadge status={order.status} />
        </span>
      </header>
      <ul className="divide-y divide-line-soft">
        {order.items.map((i) => (
          <li key={i.skuId} className="flex items-center gap-3 py-3 text-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="truncate font-medium">{i.productName}</span>
              <span className="w-fit rounded bg-surface px-2 py-0.5 text-xs text-muted-foreground">{i.skuName}</span>
            </div>
            <span className="text-muted-foreground">
              {shopPrice(i.unitPriceVnd)} × {i.quantity}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2 border-t border-line-soft pt-3 text-sm">
        <span className="text-muted-foreground">Total</span>
        <span className="orders-total">{shopPrice(order.amounts.totalVnd)}</span>
      </div>
      <footer className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col text-sm">
          <span className="text-muted-foreground">{hint(order)}</span>
          {request ? (
            <span className="text-xs text-muted-2">
              {request.kind === 'RETURN' ? 'Return request' : 'Cancellation request'}: {humanize(request.status)}
            </span>
          ) : null}
        </div>
        <div className="flex gap-2">{actions.map(button)}</div>
      </footer>
      <BuyerAftersaleRequests session={inOrderShop(buyer, order)} requests={requests} onChanged={onReturnChanged} />
    </article>
  );
}

function Orders({ buyer }: { buyer: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const tab = (orderTabs.find((t) => t.key === params.get('tab'))?.key ?? 'all') as OrderTab;
  const both = useAsync(
    async () => {
      const list = await listBuyerOrders(buyer);
      return { orders: list, aftersale: await listAftersaleOfShops(buyer, list.items) };
    },
    [buyer.sessionToken],
    POLL_MS,
  );
  const orders = { loading: both.loading, error: both.error, data: both.data?.orders, reload: both.reload };
  const aftersale = { data: both.data?.aftersale, reload: both.reload };
  const [trackId, setTrackId] = useState<string>();
  const [dialog, setDialog] = useState<{ kind: 'cancel' | 'return'; order: Order } | null>(null);

  if (orders.loading && !orders.data) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label="Loading orders">
        <Skeleton className="h-10 w-96 rounded-full" />
        {[0, 1].map((i) => <Skeleton key={i} className="h-44 rounded-card" />)}
      </div>
    );
  }
  if (orders.error && !orders.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>Could not load your orders: {orders.error.message}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={orders.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const all = [...(orders.data?.items ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const count = (t: OrderTab) => (t === 'all' ? all.length : all.filter((o) => tabOf(o.status) === t).length);
  const shown = tab === 'all' ? all : all.filter((o) => tabOf(o.status) === tab);
  const requestsForOrder = (order: Order) => (aftersale.data?.items ?? []).filter((r) => r.orderId === order.id && r.shopId === inOrderShop(buyer, order).shopId);
  const tracked = all.find((o) => o.id === trackId) ?? all.find((o) => tabOf(o.status) === 'shipping');

  const refresh = both.reload;
  const onAction = async (order: Order, a: OrderAction) => {
    if (a === 'track') return setTrackId(order.id);
    if (a === 'cancel' || a === 'request-cancel') return setDialog({ kind: 'cancel', order });
    if (a === 'return') return setDialog({ kind: 'return', order });
    try {
      await payOrder(inOrderShop(buyer, order), order.id);
      toast.success('Payment successful (simulated)');
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">My orders</h1>
      {!!aftersale.data?.unavailableShopIds.length && <Alert variant="destructive" className="mb-4"><AlertDescription>Could not load return requests for some shops. Your orders are still available.<Button variant="outline" size="sm" className="ml-3" onClick={refresh}>Retry returns</Button></AlertDescription></Alert>}
      <div className="orders-workspace">
      <Tabs orientation="vertical" className="orders-status-sidebar !flex !flex-col !gap-0" value={tab} onValueChange={(v) => setParams(v === 'all' ? {} : { tab: v }, { replace: true })}>
        <h2>Order status</h2>
        <TabsList aria-label="Order status" className="orders-status-tabs !flex !h-auto !w-full !flex-col !items-stretch !justify-start !rounded-none !bg-transparent !p-0">
          {orderTabs.map((t) => (
            <TabsTrigger
              key={t.key}
              value={t.key}
              className="orders-status-tab !h-auto !w-full !flex-none !justify-start !rounded-md !bg-transparent !shadow-none data-[state=active]:!bg-[#171717] data-[state=active]:!text-white"
            >
              {t.label} ({count(t.key)})
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="transaction-grid">
        <div className="flex min-w-0 flex-col gap-4">
          {shown.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line py-14 text-center">
              <PackageSearch className="size-8 text-muted-2" aria-hidden />
              <p className="text-muted-foreground">No orders here yet.</p>
              <Button asChild variant="outline" className="bg-white">
                <Link to="/">Continue shopping</Link>
              </Button>
            </div>
          ) : (
            shown.map((o) => (
              <OrderCard key={`${o.shopId}:${o.id}`} order={o} shopName={o.shop?.name ?? 'Shop'} requests={requestsForOrder(o)} buyer={buyer} onReturnChanged={refresh} request={[...requestsForOrder(o)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]} tracked={tracked?.id === o.id} onAction={(a) => void onAction(o, a)} />
            ))
          )}
        </div>
        <aside className="self-start lg:sticky lg:top-20">
          <TrackingPanel buyer={buyer} order={tracked} />
        </aside>
      </div>
      </div>

      {dialog?.kind === 'cancel' ? (
        <CancelDialog
          order={dialog.order}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            if (dialog.order.status === 'AWAITING_SHIPMENT') {
              await requestCancellation(inOrderShop(buyer, dialog.order), dialog.order.id, reason);
              toast.success('Cancellation requested');
            } else {
              await cancelOrder(inOrderShop(buyer, dialog.order), dialog.order.id, humanize(reason));
              toast.success('Order cancelled');
            }
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
      {dialog?.kind === 'return' ? (
        <ReturnDialog
          order={dialog.order}
          reasons={aftersale.data?.requestReasons.length ? aftersale.data.requestReasons : FALLBACK_RETURN_REASONS}
          onClose={() => setDialog(null)}
          onSubmit={async (body) => {
            await requestReturn(inOrderShop(buyer, dialog.order), body);
            toast.success('Return requested');
            setDialog(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

export function OrdersPage() {
  const { buyer } = useAuth();
  // the route is guarded by RequireRole BUYER
  return buyer ? <div className="buyer-transaction-page buyer-orders-page"><nav className="transaction-breadcrumb" aria-label="Breadcrumb"><Link to="/">Home</Link><span>/</span><span aria-current="page">My orders</span></nav><div className="transaction-content"><Orders key={buyer.sessionToken} buyer={buyer} /></div><ShopFooter /></div> : null;
}
