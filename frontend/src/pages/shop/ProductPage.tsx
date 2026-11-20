import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight, Star } from 'lucide-react';
import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { toast } from 'sonner';
import { loginUrl } from '@/components/RequireRole';
import { ProductImage } from '@/components/shop/ProductCard';
import { QuantityStepper } from '@/components/shop/QuantityStepper';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DevMock } from '@/components/ui/mock-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { MAX_PER_LINE, type CheckoutState } from '@/lib/checkout';
import { getCart, getMarketplaceProduct, inShop, listMarketplaceProducts, setCartItem } from '@/lib/endpoints';
import { compactCount, shopPrice } from '@/lib/format';
import { productPath } from '@/lib/links';
import type { ShopRef, Sku } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';
import { defaultMockShop, enrichProduct, imageBackgrounds, mockCatalog, mockReviewSummary, normalizeTitle, originalPrice, type EnrichedProduct, type MockReview } from '@/mocks';

const soldOut = (s: Sku) => !s.available || s.stock <= 0;

function Breadcrumb({ shopName, title }: { shopName?: string; title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-5 inline-flex h-9 max-w-full items-center gap-1.5 rounded-full bg-surface px-4 text-sm text-muted-foreground">
      <Link to="/" className="hover:text-ink">
        Home
      </Link>
      {shopName ? (
        <>
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{shopName}</span>
        </>
      ) : null}
      <ChevronRight className="size-3.5 shrink-0" aria-hidden />
      <span aria-current="page" className="truncate font-medium text-ink">
        {title}
      </span>
    </nav>
  );
}

function Gallery({ product }: { product: EnrichedProduct }) {
  // real images from the backend; fall back to the single imageUrl, padded with mock color tiles only when there is just one
  const urls = product.images?.length ? product.images : [product.imageUrl];
  const real = urls.map((imageUrl) => ({ ...product, imageUrl }));
  const tiles = real.length > 1 ? [] : [1, 2, 3].map((i) => ({ ...product, imageUrl: '', imageBg: imageBackgrounds[(imageBackgrounds.indexOf(product.imageBg) + i) % imageBackgrounds.length] }));
  const images = [...real, ...tiles];
  const [index, setIndex] = useState(0);
  return (
    <div className="flex flex-col gap-3">
      <ProductImage product={images[index]} className="rounded-card" />
      <div className="flex gap-2" role="group" aria-label="Product images">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Image ${i + 1}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            className={cn('w-[72px] cursor-pointer rounded-lg border-2 p-0.5', i === index ? 'border-buyer' : 'border-transparent hover:border-line')}
          >
            <ProductImage product={img} className="rounded-md" />
          </button>
        ))}
      </div>
    </div>
  );
}

type ReviewFilter = 'all' | '5' | '4' | 'photos';
const reviewFilters: { key: ReviewFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: '5', label: '5★' },
  { key: '4', label: '4★' },
  { key: 'photos', label: 'With photos' },
];
const matches = (r: MockReview, f: ReviewFilter) => (f === 'all' ? true : f === 'photos' ? r.photos > 0 : r.rating === Number(f));

function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex gap-0.5', className)} aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn('size-3.5', i <= Math.round(value) ? 'fill-star text-star' : 'text-line')} aria-hidden />
      ))}
    </span>
  );
}

function Reviews() {
  const { score, total, distribution, reviews } = mockReviewSummary;
  const [filter, setFilter] = useState<ReviewFilter>('all');
  const photoTiles = reviews.flatMap((r) => Array.from({ length: r.photos }, (_, i) => `${r.id}-${i}`));
  return (
    <section aria-labelledby="reviews" className="flex flex-col gap-5">
      <h2 id="reviews" className="text-lg font-bold">
        Ratings & reviews
      </h2>
      <div className="flex flex-wrap items-center gap-8">
        <div className="flex flex-col items-start">
          <span className="text-4xl font-bold">
            {score.toFixed(1)}
            <span className="text-lg text-muted-foreground">/5</span>
          </span>
          <Stars value={score} />
          <span className="mt-1 text-xs text-muted-foreground">{compactCount(total)} ratings</span>
        </div>
        <ul className="flex min-w-[220px] flex-1 flex-col gap-1.5" aria-label="Rating distribution">
          {distribution.map((count, i) => (
            <li key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-6">{5 - i}★</span>
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface">
                <span className="block h-full rounded-full bg-star" style={{ width: `${(count / total) * 100}%` }} />
              </span>
              <span className="w-10 text-right">{compactCount(count)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2 overflow-x-auto" aria-label="Review photos">
        {photoTiles.map((key, i) => (
          <span key={key} className="size-20 shrink-0 rounded-lg" style={{ backgroundColor: imageBackgrounds[i % imageBackgrounds.length] }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter reviews">
        {reviewFilters.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              'h-8 cursor-pointer rounded-full border px-3.5 text-sm',
              filter === f.key ? 'border-buyer bg-buyer-soft font-semibold text-buyer-ink' : 'border-line text-ink hover:bg-surface-2',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ul className="flex flex-col divide-y divide-line-soft">
        {reviews.filter((r) => matches(r, filter)).map((r) => (
          <li key={r.id} className="flex flex-col gap-1 py-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-semibold">{r.author}</span>
              <Stars value={r.rating} />
            </div>
            <span className="text-xs text-muted-foreground">
              {r.date} · Variant: {r.variant}
            </span>
            <p className="text-sm">{r.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VariantTiles({ label, skus, value, onChange }: { label: string; skus: Sku[]; value: string | undefined; onChange: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold">{label}</span>
      <RadioGroupPrimitive.Root value={value} onValueChange={onChange} aria-label={label} className="flex flex-wrap gap-2">
        {skus.map((s) => (
          <RadioGroupPrimitive.Item
            key={s.id}
            value={s.id}
            disabled={soldOut(s)}
            className={cn(
              'h-9 cursor-pointer rounded-lg border border-line bg-white px-3.5 text-sm text-ink',
              'hover:border-ink data-[state=checked]:border-buyer data-[state=checked]:bg-buyer-soft data-[state=checked]:font-semibold data-[state=checked]:text-buyer-ink',
              'disabled:cursor-not-allowed disabled:border-line-soft disabled:bg-surface-2 disabled:text-muted-2 disabled:line-through',
            )}
          >
            {s.name}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

function BuyBox({ product, shop }: { product: EnrichedProduct; shop?: ShopRef }) {
  const { buyer } = useAuth();
  const navigate = useNavigate();
  const [skuId, setSkuId] = useState(() => product.skus.find((s) => !soldOut(s))?.id);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const sku = product.skus.find((s) => s.id === skuId);
  const price = sku?.priceVnd ?? product.minPriceVnd;
  const max = sku ? Math.min(sku.stock, MAX_PER_LINE) : 0;

  const pick = (id: string) => {
    setSkuId(id);
    const next = product.skus.find((s) => s.id === id);
    if (next) setQty((q) => Math.max(1, Math.min(q, next.stock, MAX_PER_LINE)));
  };

  /** Adds `qty` on top of what is already in the cart (PUT cart/items sets the quantity). */
  const addToCart = async (): Promise<boolean> => {
    if (!buyer) {
      navigate(loginUrl(productPath({ id: product.id, shop })));
      return false;
    }
    if (!sku || !shop) return false;
    setBusy(true);
    try {
      const seller = inShop(buyer, shop.id);
      const cart = await getCart(seller);
      const inCart = cart.items.find((i) => i.skuId === sku.id)?.quantity ?? 0;
      await setCartItem(seller, sku.id, Math.min(MAX_PER_LINE, inCart + qty));
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline gap-2">
        {product.discountPct > 0 ? <span className="rounded bg-buyer-soft px-1.5 text-sm font-bold text-buyer">-{product.discountPct}%</span> : null}
        <span className="text-3xl font-bold text-buyer" data-testid="price">
          {shopPrice(price)}
        </span>
        {product.discountPct > 0 ? <span className="text-sm text-muted-2 line-through">{shopPrice(originalPrice(price, product.discountPct))}</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {product.trending ? <Badge className="rounded bg-ink text-white">Trending</Badge> : null}
      </div>
      <h1 className="text-xl font-semibold leading-snug">{product.title}</h1>
      {shop ? (
        <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
          <span>
            Sold by <span className="font-semibold text-ink">{shop.name}</span>
          </span>
          {buyer ? (
            <Link to={`/account/messages?shop=${encodeURIComponent(shop.id)}`} className="text-buyer hover:underline">
              Chat with shop
            </Link>
          ) : null}
        </p>
      ) : null}
      <p className="flex items-center gap-2 text-sm">
        <Star className="size-4 fill-star text-star" aria-hidden />
        <span className="font-semibold">{product.rating.toFixed(1)}</span>
        <span className="h-3.5 w-px bg-line" aria-hidden />
        <span className="text-muted-foreground">{compactCount(product.sold)} sold</span>
      </p>

      <VariantTiles label={product.skus[0]?.attributeName || 'Variant'} skus={product.skus} value={skuId} onChange={pick} />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-semibold">Quantity</span>
        <div className="flex items-center gap-3">
          <QuantityStepper value={qty} max={max} onChange={setQty} />
          <span className="text-sm text-muted-foreground">{sku ? `${sku.stock} available` : 'Out of stock'}</span>
        </div>
      </div>

      <div className="mt-2 flex flex-col gap-2.5">
        <Button
          size="lg"
          className="h-12 bg-buyer text-base text-white hover:bg-buyer/90"
          disabled={!sku || busy}
          onClick={async () => {
            if (sku && shop && (await addToCart())) navigate('/checkout', { state: { items: [{ shopId: shop.id, skuId: sku.id, quantity: qty }] } satisfies CheckoutState });
          }}
        >
          Buy now
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="h-12 border-ink text-base"
          disabled={!sku || busy}
          onClick={async () => {
            if (await addToCart()) toast.success('Added to cart', { action: { label: 'View cart', onClick: () => navigate('/cart') } });
          }}
        >
          Add to cart
        </Button>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px]" role="status" aria-label="Loading product">
      <Skeleton className="aspect-square rounded-card" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-1/2" />
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-12 w-full rounded-full" />
      </div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 rounded-card border border-dashed border-line p-10 text-center">{children}</div>;
}

type Detail =
  | { product: EnrichedProduct; shop?: ShopRef }
  /** A link without a shop (an old link, or a mock product opened while signed in): the real product page to go to, if any. */
  | { redirectTo: string | null }
  | null;

/** Finds the marketplace product behind a link that has no shop: the same id, or the seeded product a mock stands for. */
async function resolveLegacy(id: string): Promise<string | null> {
  const list = await listMarketplaceProducts();
  const mock = mockCatalog.find((p) => p.id === id);
  if (mock) {
    const wantedTitle = mock.seedTitle ? normalizeTitle(mock.seedTitle) : null;
    const wantedShop = normalizeTitle(mock.seedShop ?? defaultMockShop);
    const sameTitle = wantedTitle ? list.filter((p) => normalizeTitle(p.title) === wantedTitle) : [];
    const hit = sameTitle.find((p) => p.shop && normalizeTitle(p.shop.name) === wantedShop) ?? sameTitle[0];
    return hit ? productPath(hit) : null;
  }
  const hit = list.find((p) => p.id === id);
  return hit ? productPath(hit) : null;
}

export function ProductPage() {
  const { shopId, id = '' } = useParams();
  const { buyer } = useAuth();
  const navigate = useNavigate();
  const detail = useAsync<Detail>(async () => {
    if (!buyer) {
      const mock = mockCatalog.find((p) => p.id === id);
      return mock ? { product: mock, shop: { id: '', name: mock.shopName ?? '' } } : null;
    }
    if (!shopId) return { redirectTo: await resolveLegacy(id) };
    const r = await getMarketplaceProduct(shopId, id);
    return { product: enrichProduct({ ...r.product, shop: r.shop }), shop: r.shop };
  }, [buyer?.sessionToken, shopId, id]);

  const redirectTo = detail.data && 'redirectTo' in detail.data ? detail.data.redirectTo : null;
  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true });
  }, [redirectTo, navigate]);

  if ((detail.loading && !detail.data) || redirectTo) return <PageSkeleton />;
  if (detail.data && 'redirectTo' in detail.data) {
    return (
      <Notice>
        <p className="text-muted-foreground">This item is not available.</p>
        <Button asChild variant="outline">
          <Link to="/">Back to shopping</Link>
        </Button>
      </Notice>
    );
  }
  if (detail.error instanceof ApiError && detail.error.status === 404) {
    return (
      <Notice>
        <p className="text-muted-foreground">This product is not available.</p>
        <Button asChild variant="outline">
          <Link to="/">Back to shopping</Link>
        </Button>
      </Notice>
    );
  }
  if (detail.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p>Could not load the product: {detail.error.message}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={detail.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!detail.data) {
    return (
      <Notice>
        <p className="text-muted-foreground">Sign in to view this product.</p>
        <Button asChild className="bg-buyer text-white hover:bg-buyer/90">
          <Link to={loginUrl(shopId ? `/product/${encodeURIComponent(shopId)}/${encodeURIComponent(id)}` : `/product/${encodeURIComponent(id)}`)}>Sign in</Link>
        </Button>
      </Notice>
    );
  }

  const { product, shop } = detail.data;
  return (
    <div>
      <Breadcrumb shopName={shop?.name} title={product.title} />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-10">
          <Gallery key={product.id} product={product} />
          <DevMock className="p-4">
            <Reviews />
          </DevMock>
          {product.description ? (
            <section aria-labelledby="description" className="flex flex-col gap-2">
              <h2 id="description" className="text-lg font-bold">
                Description
              </h2>
              <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{product.description}</p>
            </section>
          ) : null}
        </div>
        {/* below the 64px sticky header */}
        <aside className="self-start lg:sticky lg:top-20">
          <BuyBox key={product.id} product={product} shop={shop} />
        </aside>
      </div>
    </div>
  );
}
