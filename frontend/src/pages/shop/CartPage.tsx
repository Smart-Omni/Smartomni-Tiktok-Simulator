import { ShopFooter } from '@/components/shop/ShopFooter';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingCart, Store, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ProductImage } from '@/components/shop/ProductCard';
import { QuantityStepper } from '@/components/shop/QuantityStepper';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { MAX_PER_LINE, type CheckoutState } from '@/lib/checkout';
import { getMarketplaceCart, inShop, listMarketplaceProducts, setCartItem } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import { productPath } from '@/lib/links';
import type { CartItem, CartShopGroup, DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';
import { enrichProduct, imageBackgrounds, originalPrice, type EnrichedProduct } from '@/mocks';

const lineTotal = (l: CartItem) => l.unitPriceVnd * l.quantity;
/** A SKU id is only unique within its shop. */
const lineKey = (shopId: string, skuId: string) => `${shopId}:${skuId}`;

/** Put `line` back where it was (or drop the sku when `line` is undefined), keeping other lines as they are now. */
function restore(lines: CartItem[], skuId: string, line: CartItem | undefined, index: number): CartItem[] {
  const rest = lines.filter((l) => l.skuId !== skuId);
  if (!line) return rest;
  return [...rest.slice(0, index), line, ...rest.slice(index)];
}

function CartLine({
  shopId,
  line,
  product,
  stock,
  selected,
  pending,
  onSelect,
  onQuantity,
}: {
  shopId: string;
  line: CartItem;
  product: EnrichedProduct | undefined;
  stock: number | undefined;
  selected: boolean;
  pending: boolean;
  onSelect: (on: boolean) => void;
  onQuantity: (n: number) => void;
}) {
  const name = `${line.productTitle} (${line.skuName})`;
  const image = product ?? ({ imageUrl: '', imageBg: imageBackgrounds[0] } as EnrichedProduct);
  const was = product && product.discountPct > 0 ? originalPrice(line.unitPriceVnd, product.discountPct) : null;
  return (
    <li className="flex gap-3 py-4" aria-label={name}>
      <div className="flex w-5 shrink-0 items-center">
        {line.available ? <Checkbox checked={selected} onCheckedChange={(v) => onSelect(v === true)} aria-label={`Select ${name}`} /> : null}
      </div>
      <Link to={productPath({ id: line.productId, shop: { id: shopId } })} className={cn('w-20 shrink-0', !line.available && 'opacity-50')}>
        <ProductImage product={image} />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className={cn('flex flex-col gap-1.5', !line.available && 'opacity-50')}>
          <Link to={productPath({ id: line.productId, shop: { id: shopId } })} className="line-clamp-2 text-sm font-medium text-ink hover:underline">
            {line.productTitle}
          </Link>
          <span className="w-fit rounded bg-surface px-2 py-0.5 text-xs text-muted-foreground">{line.skuName}</span>
        </div>
        {line.available ? (
          <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-baseline gap-1.5">
              <span className="font-semibold text-ink">{shopPrice(line.unitPriceVnd)}</span>
              {was ? <span className="text-xs text-muted-2 line-through">{shopPrice(was)}</span> : null}
            </div>
            <div className="ml-auto flex items-center gap-2">
              <QuantityStepper size="sm" className="transaction-quantity !rounded-md" value={line.quantity} max={Math.min(MAX_PER_LINE, stock ?? MAX_PER_LINE)} onChange={onQuantity} disabled={pending} label={`Quantity of ${name}`} />
              <Button variant="ghost" size="icon" aria-label={`Remove ${name}`} disabled={pending} onClick={() => onQuantity(0)} className="text-muted-foreground hover:text-buyer">
                <Trash2 />
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-auto flex items-center gap-3">
            <span className="rounded bg-surface px-2 py-0.5 text-xs font-semibold text-muted-foreground">No longer available</span>
            <Button variant="outline" size="sm" className="ml-auto" disabled={pending} onClick={() => onQuantity(0)}>
              Remove
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function EmptyCart() {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 rounded-card border border-dashed border-line p-12 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-buyer-soft">
        <ShoppingCart className="size-7 text-buyer" />
      </span>
      <p className="text-lg font-semibold">Your cart is empty</p>
      <p className="text-sm text-muted-foreground">Find something you like and add it here.</p>
      <Button asChild className="h-10 bg-buyer px-6 text-white hover:bg-buyer/90">
        <Link to="/">Continue shopping</Link>
      </Button>
    </div>
  );
}

function Cart({ buyer }: { buyer: DemoSession }) {
  const navigate = useNavigate();
  const data = useAsync(async () => {
    const [cart, products] = await Promise.all([getMarketplaceCart(buyer), listMarketplaceProducts().catch(() => null)]);
    return { cart, products: (products ?? []).map(enrichProduct) };
  }, [buyer.sessionToken]);

  const [groups, setGroups] = useState<CartShopGroup[] | null>(null);
  // lines start selected; this holds the keys (shopId:skuId) the buyer unticked
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (data.data) setGroups(data.data.cart.shops);
  }, [data.data]);

  if (data.loading && !data.data) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading cart">
        <Skeleton className="h-8 w-40" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-card" />)}
      </div>
    );
  }
  if (data.error && !data.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>Could not load your cart: {data.error.message}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={data.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!data.data || !groups) return null;

  const { products } = data.data;
  const productByKey = new Map(products.flatMap((p) => (p.shop ? [[`${p.shop.id}:${p.id}`, p] as const] : [])));
  const stockByKey = new Map(products.flatMap((p) => (p.shop ? p.skus.map((s) => [lineKey(p.shop!.id, s.id), s.stock] as const) : [])));

  const all = groups.flatMap((g) => g.items.map((l) => ({ shopId: g.shop.id, line: l, key: lineKey(g.shop.id, l.skuId) })));
  const selectable = all.filter((x) => x.line.available);
  const selected = selectable.filter((x) => !unticked.has(x.key));
  const stateOf = (list: { key: string }[], chosen: { key: string }[]) => (list.length > 0 && chosen.length === list.length ? true : chosen.length === 0 ? false : 'indeterminate');
  const allChecked = stateOf(selectable, selected);
  const itemCount = selected.reduce((n, x) => n + x.line.quantity, 0);
  const total = selected.reduce((n, x) => n + lineTotal(x.line), 0);

  const tick = (key: string, on: boolean) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });
  const tickMany = (keys: string[], on: boolean) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (on) next.delete(k);
        else next.add(k);
      }
      return next;
    });

  /** Optimistic: show the new quantity now, take the server cart of that shop on success, put the line back on failure. */
  const changeQuantity = async (shopId: string, skuId: string, quantity: number) => {
    const key = lineKey(shopId, skuId);
    const group = groups.find((g) => g.shop.id === shopId);
    const index = group?.items.findIndex((l) => l.skuId === skuId) ?? -1;
    const before = group?.items[index];
    if (!group || !before) return;
    setGroups((cur) =>
      (cur ?? [])
        .map((g) =>
          g.shop.id !== shopId
            ? g
            : { ...g, items: g.items.flatMap((l) => (l.skuId !== skuId ? [l] : quantity === 0 ? [] : [{ ...l, quantity, lineTotalVnd: l.unitPriceVnd * quantity }])) },
        )
        .filter((g) => g.items.length > 0),
    );
    setPending((p) => new Set(p).add(key));
    try {
      const cart = await setCartItem(inShop(buyer, shopId), skuId, quantity);
      setGroups((cur) => {
        const list = cur ?? [];
        const at = list.findIndex((g) => g.shop.id === shopId);
        const rest = list.filter((g) => g.shop.id !== shopId);
        if (!cart.items.length) return rest;
        const next = { shop: group.shop, items: cart.items, shopTotalVnd: cart.totalVnd };
        // keep the shop where it was in the list
        return at < 0 ? [...rest, next] : [...rest.slice(0, at), next, ...rest.slice(at)];
      });
    } catch (e) {
      setGroups((cur) => {
        const list = cur ?? [];
        const restored = restore(list.find((g) => g.shop.id === shopId)?.items ?? [], skuId, before, index);
        return list.some((g) => g.shop.id === shopId) ? list.map((g) => (g.shop.id === shopId ? { ...g, items: restored } : g)) : [...list, { ...group, items: restored }];
      });
      toast.error((e as Error).message);
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(key);
        return next;
      });
    }
  };

  if (all.length === 0) {
    return (
      <>
        <h1 className="text-2xl font-bold">Cart (0)</h1>
        <EmptyCart />
      </>
    );
  }

  return (
    <div>
      <h1 className="mb-5 text-2xl font-bold">Cart ({all.length})</h1>
      <div className="transaction-grid">
        <div className="flex min-w-0 flex-col gap-4">
          <label className="flex items-center gap-3 rounded-card bg-white px-4 py-3 text-sm font-semibold shadow-xs ring-1 ring-line-soft">
            <Checkbox checked={allChecked} onCheckedChange={(v) => tickMany(selectable.map((x) => x.key), v === true)} disabled={!selectable.length} />
            Select all ({selectable.length})
          </label>
          {groups.map((g) => {
            const own = g.items.filter((l) => l.available).map((l) => ({ key: lineKey(g.shop.id, l.skuId) }));
            const ownSelected = own.filter((x) => !unticked.has(x.key));
            return (
              <section key={g.shop.id} aria-label={g.shop.name} className="rounded-card bg-white px-4 shadow-xs ring-1 ring-line-soft">
                <div className="flex items-center gap-3 border-b border-line-soft py-3">
                  <Checkbox
                    checked={stateOf(own, ownSelected)}
                    onCheckedChange={(v) => tickMany(own.map((x) => x.key), v === true)}
                    disabled={!own.length}
                    aria-label={`Select all from ${g.shop.name}`}
                  />
                  <Store className="size-4" aria-hidden />
                  <span className="text-sm font-semibold">{g.shop.name}</span>
                </div>
                <ul className="divide-y divide-line-soft">
                  {g.items.map((l) => {
                    const key = lineKey(g.shop.id, l.skuId);
                    return (
                      <CartLine
                        key={key}
                        shopId={g.shop.id}
                        line={l}
                        product={productByKey.get(`${g.shop.id}:${l.productId}`)}
                        stock={stockByKey.get(key)}
                        selected={l.available && !unticked.has(key)}
                        pending={pending.has(key)}
                        onSelect={(on) => tick(key, on)}
                        onQuantity={(n) => changeQuantity(g.shop.id, l.skuId, n)}
                      />
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>

        <aside className="self-start lg:sticky lg:top-20">
          <section aria-labelledby="summary" className="flex flex-col gap-3 rounded-card bg-white p-5 shadow-xs ring-1 ring-line-soft">
            <h2 id="summary" className="text-lg font-bold">
              Order summary
            </h2>
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Items ({itemCount})</dt>
                <dd>{shopPrice(total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Shipping · vouchers · tax</dt>
                <dd className="text-muted-foreground">At checkout</dd>
              </div>
              <div className="mt-1 flex items-baseline justify-between border-t border-line-soft pt-3">
                <dt className="font-semibold">Total</dt>
                <dd className="text-xl font-semibold text-ink" data-testid="total">
                  {shopPrice(total)}
                </dd>
              </div>
            </dl>
            {new Set(selected.map((x) => x.shopId)).size > 1 ? <p className="text-xs text-muted-foreground">Items from different shops are placed as separate orders.</p> : null}
            <Button
              size="lg"
              className="mt-1 h-12 !bg-[#171717] text-sm text-white hover:!bg-[#333333] !rounded-lg"
              disabled={!selected.length || pending.size > 0}
              onClick={() => navigate('/checkout', { state: { items: selected.map((x) => ({ shopId: x.shopId, skuId: x.line.skuId, quantity: x.line.quantity })) } satisfies CheckoutState })}
            >
              Check out ({selected.length})
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function CartPage() {
  const { buyer } = useAuth();
  // the route is guarded by RequireRole BUYER
  return buyer ? <div className="buyer-transaction-page"><nav className="transaction-breadcrumb" aria-label="Breadcrumb"><Link to="/">Home</Link><span>/</span><span aria-current="page">Cart</span></nav><div className="transaction-content"><Cart key={buyer.sessionToken} buyer={buyer} /></div><ShopFooter /></div> : null;
}
