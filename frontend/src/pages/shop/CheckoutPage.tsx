import { ShopFooter } from '@/components/shop/ShopFooter';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { CheckCircle2, MapPin, ShieldCheck, Store, Ticket, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { ProductImage } from '@/components/shop/ProductCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { CheckoutState } from '@/lib/checkout';
import { checkout, getBuyerCoupons, getMarketplaceCart, getMe, inShop, listMarketplaceProducts, payOrder, setCartItem } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import type { CartItem, DemoSession, Order, OrderAmounts, Recipient, ShopRef } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';
import { enrichProduct, imageBackgrounds, type EnrichedProduct } from '@/mocks';

const MESSAGE_MAX = 500;
const ITEM_ERRORS = ['insufficient_stock', 'not_for_sale', 'unknown_sku', 'invalid_quantity', 'too_many_units', 'empty_order'];

/** Idempotency key for POST checkout (8-100 chars), one per checkout attempt. */
export function newCheckoutKey(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `web-${random}`;
}

/** Limits from the checkout `recipient` schema in docs/openapi.json. */
const recipientFields: { key: keyof Recipient; label: string; min: number; max: number; autoComplete: string }[] = [
  { key: 'name', label: 'Full name', min: 1, max: 200, autoComplete: 'name' },
  { key: 'phone', label: 'Phone', min: 5, max: 30, autoComplete: 'tel' },
  { key: 'addressLine', label: 'Address line', min: 1, max: 300, autoComplete: 'street-address' },
  { key: 'district', label: 'District', min: 1, max: 100, autoComplete: 'address-level3' },
  { key: 'city', label: 'City', min: 1, max: 100, autoComplete: 'address-level2' },
  { key: 'postalCode', label: 'Postal code (optional)', min: 0, max: 20, autoComplete: 'postal-code' },
];

export function validateRecipient(r: Partial<Record<keyof Recipient, string>>): Partial<Record<keyof Recipient, string>> {
  const errors: Partial<Record<keyof Recipient, string>> = {};
  for (const f of recipientFields) {
    const v = (r[f.key] ?? '').trim();
    if (v.length < f.min) errors[f.key] = f.min === 1 ? 'Required.' : `At least ${f.min} characters.`;
    else if (v.length > f.max) errors[f.key] = `At most ${f.max} characters.`;
  }
  return errors;
}

function AddressDialog({ open, initial, onOpenChange, onSave }: { open: boolean; initial: Recipient | null; onOpenChange: (o: boolean) => void; onSave: (r: Recipient) => void }) {
  const [draft, setDraft] = useState<Partial<Record<keyof Recipient, string>>>(() => ({ ...initial, postalCode: initial?.postalCode ?? '' }));
  const [errors, setErrors] = useState<Partial<Record<keyof Recipient, string>>>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const found = validateRecipient(draft);
    setErrors(found);
    if (Object.keys(found).length) return;
    const t = (k: keyof Recipient) => (draft[k] ?? '').trim();
    onSave({ name: t('name'), phone: t('phone'), addressLine: t('addressLine'), district: t('district'), city: t('city'), postalCode: t('postalCode') || null });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="font-sans sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Shipping address</DialogTitle>
          <DialogDescription>Used for this order only.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2">
          {recipientFields.map((f) => (
            <div key={f.key} className={f.key === 'addressLine' || f.key === 'name' ? 'flex flex-col gap-1.5 sm:col-span-2' : 'flex flex-col gap-1.5'}>
              <Label htmlFor={`recipient-${f.key}`}>{f.label}</Label>
              <Input
                id={`recipient-${f.key}`}
                value={draft[f.key] ?? ''}
                maxLength={f.max}
                autoComplete={f.autoComplete}
                aria-invalid={errors[f.key] ? true : undefined}
                aria-describedby={errors[f.key] ? `recipient-${f.key}-error` : undefined}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              />
              {errors[f.key] ? (
                <span id={`recipient-${f.key}-error`} className="text-xs text-destructive">
                  {errors[f.key]}
                </span>
              ) : null}
            </div>
          ))}
          <DialogFooter className="mt-2 sm:col-span-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="bg-buyer text-white hover:bg-buyer/90">
              Save address
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Card({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-card bg-white p-5 shadow-xs ring-1 ring-line-soft">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h2 className="text-base font-bold">{title}</h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} role="alert" className="mt-2 text-sm text-destructive">
      {children}
    </p>
  );
}

function PaymentDetails({ productTotal, amounts }: { productTotal: number; amounts: OrderAmounts | null }) {
  const later = <span className="text-muted-foreground">Calculated at order</span>;
  const rows: [string, ReactNode][] = [
    ['Product total', shopPrice(amounts?.productTotalVnd ?? productTotal)],
    ['Seller discount', amounts ? `-${shopPrice(amounts.sellerDiscountVnd)}` : later],
    ['Platform discount', amounts ? `-${shopPrice(amounts.platformDiscountVnd)}` : later],
    ['Shipping fee', amounts ? shopPrice(amounts.shippingFeeVnd) : later],
    ['Tax', amounts ? shopPrice(amounts.taxVnd) : later],
  ];
  return (
    <dl className="flex flex-col gap-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
      <div className="mt-1 flex items-baseline justify-between border-t border-line-soft pt-3">
        <dt className="font-semibold">{amounts ? 'Total' : 'Estimated total'}</dt>
        <dd className="text-xl font-semibold text-ink" data-testid="total">
          {shopPrice(amounts?.totalVnd ?? productTotal)}
        </dd>
      </div>
    </dl>
  );
}

interface Line extends CartItem {
  shopId: string;
  product: EnrichedProduct | undefined;
}

interface ShopLines {
  shop: ShopRef;
  lines: Line[];
}

type ShopErrors = { coupon?: string; items?: string; general?: string };

/** Adds the amounts of several orders (one per shop) into one payment summary. */
export function sumAmounts(list: OrderAmounts[]): OrderAmounts {
  const zero: OrderAmounts = { currency: list[0]?.currency ?? 'VND', productTotalVnd: 0, sellerDiscountVnd: 0, platformDiscountVnd: 0, subTotalVnd: 0, shippingFeeVnd: 0, taxVnd: 0, totalVnd: 0 };
  return list.reduce<OrderAmounts>(
    (a, b) => ({
      currency: a.currency,
      productTotalVnd: a.productTotalVnd + b.productTotalVnd,
      sellerDiscountVnd: a.sellerDiscountVnd + b.sellerDiscountVnd,
      platformDiscountVnd: a.platformDiscountVnd + b.platformDiscountVnd,
      subTotalVnd: a.subTotalVnd + b.subTotalVnd,
      shippingFeeVnd: a.shippingFeeVnd + b.shippingFeeVnd,
      taxVnd: a.taxVnd + b.taxVnd,
      totalVnd: a.totalVnd + b.totalVnd,
    }),
    zero,
  );
}

/** Vouchers the buyer can type for one shop (the former /buyer/coupons list). */
function VoucherPicker({ buyer, shopId, value, disabled, error, onChange }: { buyer: DemoSession; shopId: string; value: string; disabled: boolean; error?: string; onChange: (v: string) => void }) {
  const vouchers = useAsync(() => getBuyerCoupons(inShop(buyer, shopId)).catch(() => null), [buyer.sessionToken, shopId]);
  const usable = vouchers.data?.items ?? [];
  const inputId = `coupon-${shopId}`;
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-sm font-semibold">
        <Ticket className="size-4 text-buyer" aria-hidden /> Voucher
      </span>
      <Label htmlFor={inputId} className="sr-only">
        Voucher code
      </Label>
      <Input
        id={inputId}
        value={value}
        maxLength={20}
        disabled={disabled}
        placeholder="Enter a voucher code"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        className="max-w-xs"
      />
      {error ? <FieldError id={`${inputId}-error`}>{error}</FieldError> : null}
      {!disabled && usable.length ? (
        <div className="mt-1 flex flex-col gap-2">
          <span className="text-xs font-semibold text-muted-foreground">Available vouchers</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Available vouchers">
            {usable.map((v) => (
              <button
                key={v.id}
                type="button"
                aria-pressed={value === v.promoCode}
                title={v.minSpendVnd != null ? `Min spend ${shopPrice(v.minSpendVnd)}` : undefined}
                onClick={() => onChange(value === v.promoCode ? '' : (v.promoCode ?? ''))}
                className={cn('flex cursor-pointer flex-col items-start rounded-lg border border-dashed px-3 py-1.5 text-left', value === v.promoCode ? 'border-buyer bg-buyer-soft' : 'border-line hover:bg-surface-2')}
              >
                <span className="font-mono text-xs font-bold">{v.promoCode}</span>
                <span className="text-[11px] text-muted-foreground">{v.discountText}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ShopCard({
  buyer,
  group,
  placed,
  message,
  coupon,
  errors,
  onMessage,
  onCoupon,
}: {
  buyer: DemoSession;
  group: ShopLines;
  placed: Order | undefined;
  message: string;
  coupon: string;
  errors: ShopErrors;
  onMessage: (v: string) => void;
  onCoupon: (v: string) => void;
}) {
  const messageId = `buyer-message-${group.shop.id}`;
  return (
    <Card title={group.shop.name} icon={<Store className="size-5" aria-hidden />}>
      <ul className="divide-y divide-line-soft" aria-label={`Items from ${group.shop.name}`}>
        {group.lines.map((l) => (
          <li key={l.skuId} className="flex items-center gap-3 py-3">
            <ProductImage product={l.product ?? ({ imageUrl: '', imageBg: imageBackgrounds[0] } as EnrichedProduct)} className="w-16 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="line-clamp-1 text-sm font-medium">{l.productTitle}</span>
              <span className="w-fit rounded bg-surface px-2 py-0.5 text-xs text-muted-foreground">{l.skuName}</span>
            </div>
            <span className="text-sm text-muted-foreground">
              {shopPrice(l.unitPriceVnd)} × {l.quantity}
            </span>
            <span className="w-28 text-right text-sm font-semibold">{shopPrice(l.lineTotalVnd)}</span>
          </li>
        ))}
      </ul>
      {errors.items ? <FieldError id={`items-error-${group.shop.id}`}>{errors.items}</FieldError> : null}
      {errors.general ? <FieldError id={`general-error-${group.shop.id}`}>{errors.general}</FieldError> : null}
      {placed ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-free-ship" role="status">
          <CheckCircle2 className="size-4" aria-hidden /> Placed as <span className="font-mono">{placed.id}</span> · {placed.status}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-1.5">
        <Label htmlFor={messageId}>Message to seller</Label>
        <Textarea
          id={messageId}
          value={message}
          maxLength={MESSAGE_MAX}
          disabled={placed !== undefined}
          placeholder="Optional"
          onChange={(e) => onMessage(e.target.value.slice(0, MESSAGE_MAX))}
          className="min-h-16"
        />
        <span className="self-end text-xs text-muted-2">
          {message.length}/{MESSAGE_MAX}
        </span>
      </div>

      <VoucherPicker buyer={buyer} shopId={group.shop.id} value={coupon} disabled={placed !== undefined} error={errors.coupon} onChange={onCoupon} />

      <div className="mt-4 flex items-center gap-3 rounded-lg bg-surface-2 px-4 py-3 text-sm">
        <Truck className="size-5 text-free-ship" aria-hidden />
        <div className="flex flex-col">
          <span className="font-semibold">Shipping · Simulator Express</span>
          <span className="text-xs text-muted-foreground">Fake carrier. The fee is calculated when the order is placed.</span>
        </div>
      </div>
    </Card>
  );
}

function Checkout({ buyer }: { buyer: DemoSession }) {
  const navigate = useNavigate();
  const wanted = (useLocation().state as CheckoutState | null)?.items;
  const data = useAsync(async () => {
    const [cart, products, me] = await Promise.all([getMarketplaceCart(buyer), listMarketplaceProducts().catch(() => null), getMe(buyer).catch(() => null)]);
    return { cart, products: (products ?? []).map(enrichProduct), me };
  }, [buyer.sessionToken]);

  // one idempotency key per shop and attempt
  const [keys] = useState(() => new Map<string, string>());
  const keyFor = (shopId: string) => {
    let k = keys.get(shopId);
    if (!k) {
      k = newCheckoutKey();
      keys.set(shopId, k);
    }
    return k;
  };
  const [address, setAddress] = useState<Recipient | null>(null);
  const [editing, setEditing] = useState(false);
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [coupons, setCoupons] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<{ general?: string; shops: Record<string, ShopErrors> }>({ shops: {} });
  const [placing, setPlacing] = useState(false);
  const [orders, setOrders] = useState<Record<string, Order>>({});
  const [paying, setPaying] = useState(false);

  if (data.loading && !data.data) {
    return (
      <div className="transaction-grid" role="status" aria-label="Loading checkout">
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-32 rounded-card" />)}
        </div>
        <Skeleton className="h-72 rounded-card" />
      </div>
    );
  }
  if (data.error && !data.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>Could not load checkout: {data.error.message}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={data.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!data.data) return null;

  const { cart, products, me } = data.data;
  const productByKey = new Map(products.flatMap((p) => (p.shop ? [[`${p.shop.id}:${p.id}`, p] as const] : [])));
  const cartItem = new Map(cart.shops.flatMap((g) => g.items.map((l) => [`${g.shop.id}:${l.skuId}`, l] as const)));
  const shopOf = new Map(cart.shops.map((g) => [g.shop.id, g.shop] as const));
  const wantedLines = wanted ?? cart.shops.flatMap((g) => g.items.filter((l) => l.available).map((l) => ({ shopId: g.shop.id, skuId: l.skuId, quantity: l.quantity })));
  const shops: ShopLines[] = [];
  for (const w of wantedLines) {
    const l = cartItem.get(`${w.shopId}:${w.skuId}`);
    const shop = shopOf.get(w.shopId);
    if (!l || !shop) continue;
    let group = shops.find((g) => g.shop.id === shop.id);
    if (!group) {
      group = { shop, lines: [] };
      shops.push(group);
    }
    group.lines.push({ ...l, shopId: shop.id, quantity: w.quantity, lineTotalVnd: l.unitPriceVnd * w.quantity, product: productByKey.get(`${shop.id}:${l.productId}`) });
  }
  const productTotal = shops.reduce((n, g) => n + g.lines.reduce((m, l) => m + l.lineTotalVnd, 0), 0);
  const placedOrders = shops.flatMap((g) => (orders[g.shop.id] ? [orders[g.shop.id]] : []));
  const placedAll = shops.length > 0 && placedOrders.length === shops.length;
  const anyPlaced = placedOrders.length > 0;

  if (!shops.length && !anyPlaced) {
    return (
      <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 rounded-card border border-dashed border-line p-12 text-center">
        <p className="text-lg font-semibold">Nothing to check out</p>
        <Button asChild variant="outline">
          <Link to="/cart">Back to cart</Link>
        </Button>
      </div>
    );
  }

  const place = async () => {
    setPlacing(true);
    setErrors({ shops: {} });
    const failed: Record<string, ShopErrors> = {};
    for (const g of shops) {
      if (orders[g.shop.id]) continue;
      const shopSession = inShop(buyer, g.shop.id);
      const message = (messages[g.shop.id] ?? '').trim();
      const coupon = (coupons[g.shop.id] ?? '').trim();
      try {
        const r = await checkout(shopSession, {
          checkoutKey: keyFor(g.shop.id),
          items: g.lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity })),
          ...(address ? { recipient: address } : {}),
          ...(message ? { buyerMessage: message } : {}),
          ...(coupon ? { couponCode: coupon } : {}),
        });
        setOrders((prev) => ({ ...prev, [g.shop.id]: r.order }));
        if (!r.replayed) {
          // `items` was sent, so the API keeps the cart: take the bought quantities out of it
          for (const l of g.lines) {
            const inCart = cartItem.get(`${g.shop.id}:${l.skuId}`)?.quantity ?? 0;
            await setCartItem(shopSession, l.skuId, Math.max(0, inCart - l.quantity)).catch(() => undefined);
          }
        }
      } catch (e) {
        const code = e instanceof ApiError ? e.code : undefined;
        const text = (e as Error).message;
        if (code?.startsWith('coupon_')) failed[g.shop.id] = { coupon: text };
        else if (code && ITEM_ERRORS.includes(code)) failed[g.shop.id] = { items: text };
        else failed[g.shop.id] = { general: text };
      }
    }
    window.dispatchEvent(new Event('shop-cart-updated'));
    setErrors({ shops: failed });
    setPlacing(false);
  };

  const pay = async () => {
    setPaying(true);
    try {
      for (const o of placedOrders) await payOrder(inShop(buyer, o.shopId ?? o.shop?.id ?? buyer.shopId), o.id);
      toast.success(placedOrders.length > 1 ? 'Payments successful (simulated)' : 'Payment successful (simulated)');
      navigate('/account/orders');
    } catch (e) {
      setErrors({ general: (e as Error).message, shops: {} });
      setPaying(false);
    }
  };

  const recipient = placedOrders[0]?.recipient ?? address;
  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">Checkout</h1>
      {anyPlaced ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-card bg-teal-soft px-5 py-4 text-ink" role="status">
          <CheckCircle2 className="size-6 text-free-ship" aria-hidden />
          <div className="flex flex-col">
            <span className="font-bold">
              {placedOrders.length > 1 ? `${placedOrders.length} orders placed` : `Order placed · ${placedOrders[0].status}`}
              {placedAll ? '' : ` (${shops.length - placedOrders.length} still to place)`}
            </span>
            <span className="text-sm text-muted-foreground">
              {placedOrders.length > 1 ? (
                <>
                  Orders <span className="font-mono">{placedOrders.map((o) => o.id).join(', ')}</span>.
                </>
              ) : (
                <>
                  Order <span className="font-mono">{placedOrders[0].id}</span>.
                </>
              )}{' '}
              {placedAll ? 'Pay now to send them to the sellers.' : 'Place the rest to continue.'}
            </span>
          </div>
        </div>
      ) : null}

      <div className="transaction-grid">
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="Shipping address"
            icon={<MapPin className="size-5 text-buyer" aria-hidden />}
            action={
              anyPlaced ? null : (
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  Change
                </Button>
              )
            }
          >
            {recipient ? (
              <div className="text-sm" data-testid="address">
                <p className="font-semibold">
                  {recipient.name} <span className="font-normal text-muted-foreground">· {recipient.phone}</span>
                </p>
                <p className="text-muted-foreground">{[recipient.addressLine, recipient.district, recipient.city, recipient.postalCode].filter(Boolean).join(', ')}</p>
              </div>
            ) : (
              <div className="text-sm" data-testid="address">
                <p className="font-semibold">{me?.buyer?.name ?? 'Your account'}</p>
                <p className="text-muted-foreground">
                  {me?.buyer?.city ? `${me.buyer.city} · ` : ''}Saved address of your account
                </p>
              </div>
            )}
          </Card>

          {shops.map((g) => (
            <ShopCard
              key={g.shop.id}
              buyer={buyer}
              group={g}
              placed={orders[g.shop.id]}
              message={messages[g.shop.id] ?? ''}
              coupon={coupons[g.shop.id] ?? ''}
              errors={errors.shops[g.shop.id] ?? {}}
              onMessage={(v) => setMessages((m) => ({ ...m, [g.shop.id]: v }))}
              onCoupon={(v) => setCoupons((c) => ({ ...c, [g.shop.id]: v }))}
            />
          ))}
        </div>

        <aside className="self-start lg:sticky lg:top-20">
          <section aria-labelledby="payment-details" className="flex flex-col gap-3 rounded-card bg-white p-5 shadow-xs ring-1 ring-line-soft">
            <div className="flex items-center gap-2">
              <h2 id="payment-details" className="text-lg font-bold">
                Payment details
              </h2>
              <Badge variant="outline" className="ml-auto gap-1 rounded-full border-free-ship/40 text-free-ship">
                <ShieldCheck /> Simulated payment
              </Badge>
            </div>
            {shops.length > 1 ? <p className="text-xs text-muted-foreground">{shops.length} shops: each one gets its own order.</p> : null}
            <PaymentDetails productTotal={productTotal} amounts={placedAll ? sumAmounts(placedOrders.map((o) => o.amounts)) : null} />
            {errors.general ? (
              <Alert variant="destructive">
                <AlertDescription>{errors.general}</AlertDescription>
              </Alert>
            ) : null}
            {placedAll ? (
              <>
                <Button size="lg" className="h-12 !bg-[#171717] text-sm text-white hover:!bg-[#333333] !rounded-lg" disabled={paying} onClick={pay}>
                  {paying ? 'Paying...' : 'Pay now (simulated)'}
                </Button>
                <Button asChild variant="ghost" className="text-muted-foreground">
                  <Link to="/account/orders">Pay later</Link>
                </Button>
              </>
            ) : (
              <Button size="lg" className="h-12 !bg-[#171717] text-sm text-white hover:!bg-[#333333] !rounded-lg" disabled={placing} onClick={place}>
                {placing ? 'Placing order...' : anyPlaced ? 'Place remaining orders' : 'Place order'}
              </Button>
            )}
            <p className="text-xs text-muted-2">No real money is charged. Payment is simulated.</p>
          </section>
        </aside>
      </div>

      {editing ? (
        <AddressDialog
          open
          initial={address ?? (me?.buyer ? { name: me.buyer.name, phone: '', addressLine: '', district: '', city: me.buyer.city } : null)}
          onOpenChange={setEditing}
          onSave={(r) => {
            setAddress(r);
            setEditing(false);
          }}
        />
      ) : null}
    </div>
  );
}

export function CheckoutPage() {
  const { buyer } = useAuth();
  // the route is guarded by RequireRole BUYER
  return buyer ? <div className="buyer-transaction-page"><nav className="transaction-breadcrumb" aria-label="Breadcrumb"><Link to="/">Home</Link><span>/</span><Link to="/cart">Cart</Link><span>/</span><span aria-current="page">Checkout</span></nav><div className="transaction-content"><Checkout key={buyer.sessionToken} buyer={buyer} /></div><ShopFooter /></div> : null;
}
