import { ProductPurchase } from '@/components/shop/ProductPurchase';
import { Stars } from '@/components/shop/ProductStars';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { loginUrl } from '@/components/RequireRole';
import { ProductImage } from '@/components/shop/ProductCard';
import { ShopFooter } from '@/components/shop/ShopFooter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getMarketplaceProduct, listMarketplaceProducts } from '@/lib/endpoints';
import { compactCount, shopPrice } from '@/lib/format';
import { productPath } from '@/lib/links';
import type { ShopRef } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';
import { defaultMockShop, enrichProduct, imageBackgrounds, mockCatalog, mockReviewSummary, normalizeTitle, type EnrichedProduct, type MockReview } from '@/mocks';



function Breadcrumb({ shopName, title }: { shopName?: string; title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="detail-breadcrumb">
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
  // Use available product images, falling back to the primary image.
  const urls = product.images?.length ? product.images : [product.imageUrl];
  const real = urls.map((imageUrl) => ({ ...product, imageUrl }));
  const images = real;
  const [index, setIndex] = useState(0);
  return (
    <div className="detail-gallery">
      <ProductImage product={images[index]} className="rounded-xl" />
      <div className="flex gap-2" role="group" aria-label="Product images">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Image ${i + 1}`}
            aria-pressed={i === index}
            onClick={() => setIndex(i)}
            className="detail-thumbnail"
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
    <div className="product-detail">
      <Breadcrumb shopName={shop?.name} title={product.title} />
      <div className="detail-main">
        <Gallery key={product.id} product={product} />
        <aside><ProductPurchase key={product.id} product={product} shop={shop} /></aside>
      </div>
      <DetailInformation key={product.id} product={product} />
      <ShopFooter />
    </div>
  );
}

function DetailInformation({ product }: { product: EnrichedProduct }) {
  const [tab, setTab] = useState<'info' | 'reviews'>('info');
  return <section className="detail-information">
    <div role="tablist" aria-label="Product information" className="detail-tabs" onKeyDown={(event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'info' : event.key === 'End' ? 'reviews' : tab === 'info' ? 'reviews' : 'info';
      setTab(next);
      event.currentTarget.querySelector<HTMLButtonElement>(`#detail-${next}-tab`)?.focus();
    }}>
      <button id="detail-info-tab" type="button" role="tab" tabIndex={tab === 'info' ? 0 : -1} aria-selected={tab === 'info'} aria-controls="detail-info-panel" onClick={() => setTab('info')}>Product information</button>
      <button id="detail-reviews-tab" type="button" role="tab" tabIndex={tab === 'reviews' ? 0 : -1} aria-selected={tab === 'reviews'} aria-controls="detail-reviews-panel" onClick={() => setTab('reviews')}>Ratings & reviews</button>
    </div>
    {tab === 'info' ? <div id="detail-info-panel" role="tabpanel" aria-labelledby="detail-info-tab" className="detail-tab-panel">
      <h2>Product details</h2><p>{product.description || 'No product description available.'}</p>
      <dl><div><dt>Variants</dt><dd>{product.skus.length}</dd></div><div><dt>Price range</dt><dd>{shopPrice(product.minPriceVnd)}{product.maxPriceVnd !== product.minPriceVnd ? ` – ${shopPrice(product.maxPriceVnd)}` : ''}</dd></div></dl>
    </div> : <div id="detail-reviews-panel" role="tabpanel" aria-labelledby="detail-reviews-tab" className="detail-tab-panel"><span className="detail-demo-label">Demo reviews</span><Reviews /></div>}
  </section>;
}
