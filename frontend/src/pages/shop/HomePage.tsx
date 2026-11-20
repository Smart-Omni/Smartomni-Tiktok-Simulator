import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Gift, Package, Ticket, MessageCircle, Wallet, CreditCard, MapPin, RotateCcw, Store, CircleHelp, FileText, Truck, Radio, BadgeCheck, Crown, Sparkles, Egg, TrendingUp, Heart, Shirt, ArrowRight } from 'lucide-react';
import { CategoryRow } from '@/components/shop/CategoryRow';
import { ProductCard, ProductCardSkeleton, ProductImage } from '@/components/shop/ProductCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { productPath } from '@/lib/links';
import { shopPrice } from '@/lib/format';
import { listMarketplaceProducts } from '@/lib/endpoints';
import { useAsync, type AsyncResult } from '@/lib/useAsync';
import { useHorizontalScroll } from '@/lib/useHorizontalScroll';
import { categoryBySlug, enrichProduct, mockCatalog, normalizeTitle, type EnrichedProduct } from '@/mocks';

const GRID = 'grid grid-cols-2 gap-x-3 gap-y-5 md:grid-cols-3 lg:grid-cols-5';
const BEST_SELLERS_PAGE = 10;

/** Products with a 4★+ rating and a discount, biggest discount first. */
export const deals = (items: EnrichedProduct[]) => items.filter((p) => p.rating >= 4 && p.discountPct > 0).sort((a, b) => b.discountPct - a.discountPct);
export const bestSellers = (items: EnrichedProduct[]) => [...items].sort((a, b) => b.sold - a.sold);
/** Client-side search (the API has none): case- and diacritic-insensitive match on the title. */
export const search = (items: EnrichedProduct[], q: string) => {
  const term = normalizeTitle(q);
  return items.filter((p) => normalizeTitle(p.title).includes(term));
};

function Section({ id, title, action, hideTitle = false, children }: { id: string; title: ReactNode; action?: ReactNode; hideTitle?: boolean; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8 first:mt-2">
      <div className={hideTitle && !action ? 'sr-only' : 'mb-3 flex flex-wrap items-center gap-3'}>
        <h2 id={id} className={hideTitle ? 'sr-only' : 'text-xl font-bold tracking-tight text-ink'}>
          {title}
        </h2>
        {action ? <div className="ml-auto flex items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function ArrowButton({ dir, disabled, onClick }: { dir: 'prev' | 'next'; disabled: boolean; onClick: () => void }) {
  const Icon = dir === 'prev' ? ChevronLeft : ChevronRight;
  return (
    <Button variant="outline" size="icon" aria-label={dir === 'prev' ? 'Previous deals' : 'Next deals'} disabled={disabled} onClick={onClick} className="size-9 bg-white">
      <Icon />
    </Button>
  );
}

/** One row of cards scrolled a page at a time with the arrow buttons. */
function DealsRow({ items }: { items: EnrichedProduct[] }) {
  const { ref, edges, update, page } = useHorizontalScroll<HTMLDivElement>([items]);

  return (
    <Section
      id="deals"
      title="Deals on 4★+ products for you"
      hideTitle
      action={
        <>
          <ArrowButton dir="prev" disabled={edges.start} onClick={() => page(-1)} />
          <ArrowButton dir="next" disabled={edges.end} onClick={() => page(1)} />
        </>
      }
    >
      <div ref={ref} onScroll={update} className="-mx-1.5 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((p) => (
          <ProductCard
            key={productPath(p)}
            product={p}
            className="shrink-0 basis-[calc((100%-0.75rem)/2)] snap-start md:basis-[calc((100%-1.5rem)/3)] lg:basis-[calc((100%-3rem)/5)]"
          />
        ))}
      </div>
    </Section>
  );
}

function BestSellers({ items }: { items: EnrichedProduct[] }) {
  const [shown, setShown] = useState(BEST_SELLERS_PAGE);
  return (
    <Section id="best-sellers" title="Best sellers" hideTitle>
      <div className={GRID}>
        {items.slice(0, shown).map((p) => <ProductCard key={productPath(p)} product={p} />)}
      </div>
      {shown < items.length ? (
        <div className="mt-6 flex justify-center">
          <Button variant="outline" className="h-10 min-w-40 bg-white" onClick={() => setShown((n) => n + BEST_SELLERS_PAGE)}>
            See more
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

/** Search (?q=) and/or category (?category=) results, filtered client-side. */
function Results({ items, q, category }: { items: EnrichedProduct[]; q: string; category: string | null }) {
  const cat = categoryBySlug(category);
  const inCategory = cat ? items.filter((p) => p.category === cat.slug) : items;
  const found = q ? search(inCategory, q) : inCategory;
  const title = q ? `Results for “${q}”${cat ? ` in ${cat.name}` : ''} (${found.length})` : `${cat?.name ?? 'All products'} (${found.length})`;
  return (
    <Section
      id="results"
      title={title}
      action={
        cat ? (
          <Button asChild variant="outline" size="sm" className="bg-white">
            <Link to={q ? `/?q=${encodeURIComponent(q)}` : '/'}>All categories</Link>
          </Button>
        ) : null
      }
    >
      {found.length ? (
        <div className={GRID}>{found.map((p) => <ProductCard key={productPath(p)} product={p} />)}</div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line py-12 text-center">
          <p className="text-muted-foreground">{q ? `No products match “${q}”.` : 'No products in this category yet.'}</p>
          <Button asChild variant="outline" className="bg-white">
            <Link to="/">{q ? 'Clear search' : 'Back to all products'}</Link>
          </Button>
        </div>
      )}
    </Section>
  );
}

const actions = [
  { label: 'Bonus', icon: Gift }, { label: 'Order', icon: Package, to: '/account/orders' },
  { label: 'Vouchers', icon: Ticket }, { label: 'Messages', icon: MessageCircle, to: '/account/messages' },
  { label: 'Pay Later', icon: Wallet }, { label: 'TikTok Pay', icon: CreditCard },
  { label: 'Buy Local', icon: MapPin }, { label: 'Returns', icon: RotateCcw, to: '/account/orders' },
  { label: 'Start selling', icon: Store, to: '/seller-center' }, { label: 'Address', icon: MapPin },
  { label: 'Help', icon: CircleHelp }, { label: 'Policies', icon: FileText },
];
const collections = [
  { label: 'Shipping Vouchers', icon: Truck }, { label: 'LIVE Shopping', icon: Radio },
  { label: 'TikTok Shop Mall', icon: BadgeCheck }, { label: 'TikTok Shop VIP', icon: Crown },
  { label: 'Buy More Get More', icon: Sparkles }, { label: 'Crack the Egg', icon: Egg },
  { label: 'Trending', icon: TrendingUp }, { label: 'Following (Shop)', icon: Heart },
  { label: 'Fashion Trends', icon: Shirt },
];
function HomeNavigation({ signedIn }: { signedIn: boolean }) {
  return <><section className="buyer-home-section" aria-label="Quick actions">
    <div className="buyer-actions-row">{actions.map(({ label, icon: Icon, to }) => signedIn && to ? <Link key={label} to={to} className="buyer-action-tile"><span className="buyer-tile-circle"><Icon size={19} /></span><span className="buyer-tile-label">{label}</span></Link> : <div key={label} className="buyer-action-tile buyer-unavailable" aria-disabled="true"><span className="buyer-tile-circle"><Icon size={19} /></span><span className="buyer-tile-label">{label}</span></div>)}</div>
  </section><section className="buyer-home-section" aria-label="Explore"><div className="buyer-collections-row">{collections.map(({ label, icon: Icon }) => <div key={label} className="buyer-collection-tile" aria-disabled="true"><span className="buyer-tile-circle"><Icon size={22} /></span><strong>{label}</strong></div>)}</div></section></>;
}
function FlashSaleBanner({ items }: { items: EnrichedProduct[] }) {
  const featured = deals(items).slice(0, 3);
  return <section className="buyer-flash-banner" aria-label="Flash sale"><div className="buyer-flash-intro"><span className="buyer-flash-kicker">FLASH SALE</span><h2>Everyday finds.<br />Better prices.</h2><a href="#deals">Shop deals <ArrowRight size={15} /></a></div><div className="buyer-flash-preview">{featured.map((p) => <Link key={productPath(p)} to={productPath(p)}><div className="buyer-flash-image"><ProductImage product={p} /><span>-{p.discountPct}%</span></div><strong>{p.title}</strong><b>{shopPrice(p.minPriceVnd)}</b></Link>)}</div></section>;
}

export function HomePage() {
  const { buyer } = useAuth();
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const category = categoryBySlug(params.get('category')) ? params.get('category') : null;
  const products = useAsync<EnrichedProduct[]>(
    () => (buyer ? listMarketplaceProducts().then((items) => items.map(enrichProduct)) : Promise.resolve(mockCatalog)),
    [buyer?.sessionToken],
  );

  return (
    <>
      <FlashSaleBanner items={products.data ?? []} />
      <HomeNavigation signedIn={!!buyer} />
      <div className="buyer-products-area buyer-catalog-layout"><CategoryRow />
        <div className="buyer-catalog-results"><Products state={products} q={q} category={category} /></div>
      </div>
      <footer className="buyer-home-footer"><strong>TikTok SHOP SIMULATOR</strong><Link to="/console">Test console</Link></footer>
    </>
  );
}

function Products({ state, q, category }: { state: AsyncResult<EnrichedProduct[]>; q: string; category: string | null }) {
  if (state.loading && !state.data) {
    return (
      <Section id="loading" title="Deals on 4★+ products for you">
        <div className={GRID} role="status" aria-label="Loading products">
          {Array.from({ length: 10 }, (_, i) => <ProductCardSkeleton key={i} />)}
        </div>
      </Section>
    );
  }
  if (state.error && !state.data) {
    return (
      <Alert variant="destructive" className="mt-6">
        <AlertDescription>
          <p>Could not load products: {state.error.message}</p>
          <Button variant="outline" size="sm" className="mt-1" onClick={state.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const items = state.data ?? [];
  if (!items.length) {
    return <p className="mt-10 text-center text-muted-foreground">No products are for sale yet.</p>;
  }
  if (q || category) return <Results items={items} q={q} category={category} />;
  const dealItems = deals(items);
  return (
    <>
      {dealItems.length ? <DealsRow items={dealItems} /> : null}
      <BestSellers items={bestSellers(items)} />
    </>
  );
}
