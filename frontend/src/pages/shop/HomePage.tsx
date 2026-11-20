import { useState } from 'react';
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
import { categoryBySlug, enrichProduct, mockCatalog, normalizeTitle, type EnrichedProduct } from '@/mocks';

const GRID = 'grid grid-cols-2 gap-x-3 gap-y-5 md:grid-cols-3 lg:grid-cols-5';

/** Products with a 4★+ rating and a discount, biggest discount first. */
export const deals = (items: EnrichedProduct[]) => items.filter((p) => p.rating >= 4 && p.discountPct > 0).sort((a, b) => b.discountPct - a.discountPct);
export const bestSellers = (items: EnrichedProduct[]) => [...items].sort((a, b) => b.sold - a.sold);
/** Client-side search (the API has none): case- and diacritic-insensitive match on the title. */
export const search = (items: EnrichedProduct[], q: string) => {
  const term = normalizeTitle(q);
  return items.filter((p) => normalizeTitle(p.title).includes(term));
};

function Catalog({ items, q, category }: { items: EnrichedProduct[]; q: string; category: string | null }) {
  const [sort, setSort] = useState('recommended');
  const [page, setPage] = useState(1);
  const [columns, setColumns] = useState<4 | 6>(4);
  const pageSize = columns === 6 ? 18 : 16;
  const cat = categoryBySlug(category);
  const matching = cat ? items.filter((p) => p.category === cat.slug) : items;
  const found = q ? search(matching, q) : matching;
  const sorted = [...found].sort((a, b) => sort === 'price-low' ? a.minPriceVnd - b.minPriceVnd : sort === 'price-high' ? b.minPriceVnd - a.minPriceVnd : sort === 'discount' ? b.discountPct - a.discountPct : b.sold - a.sold);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pages);
  const start = (currentPage - 1) * pageSize;
  const visible = sorted.slice(start, start + pageSize);
  return <section id="catalog" aria-label="Products" className="buyer-catalog">
    <div className="buyer-catalog-toolbar">
      <div className="buyer-catalog-view"><div className="buyer-layout-toggle" role="group" aria-label="Product layout">{([4, 6] as const).map((count) => <button key={count} type="button" aria-label={`${count} products per row`} title={`${count} products per row`} aria-pressed={columns === count} onClick={() => { setColumns(count); setPage(1); }}><span className={`buyer-layout-icon buyer-layout-icon-${count}`} aria-hidden="true">{Array.from({ length: count }, (_, i) => <i key={i} />)}</span></button>)}</div><span role="status">{found.length ? `${start + 1}–${Math.min(start + pageSize, found.length)} of ${found.length} products` : '0 products'}</span></div>
      <label>Sort by<select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} aria-label="Sort products">
        <option value="recommended">Recommended</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="discount">Biggest discount</option>
      </select></label>
    </div>
    {visible.length ? <div className={`buyer-product-grid buyer-product-grid-${columns}`}>{visible.map((product) => <ProductCard key={productPath(product)} product={product} compact />)}</div> : <div className="buyer-catalog-empty"><p>{q ? `No products match “${q}”.` : 'No products in this category yet.'}</p><Link to="/">{q ? 'Clear search' : 'Back to all products'}</Link></div>}
    {pages > 1 && <nav className="buyer-pagination" aria-label="Product pages">
      <button type="button" aria-label="Previous page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={16} /></button>
      <span>Page {currentPage} of {pages}</span>
      <button type="button" aria-label="Next page" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={16} /></button>
    </nav>}
  </section>;
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
  const maxDiscount = featured[0]?.discountPct;
  return <div className="buyer-sale-area"><section className="buyer-flash-banner" aria-label="Flash sale">
    <div className="buyer-flash-intro">
      <span className="buyer-flash-kicker"><Sparkles size={13} /> SELECTED DEALS</span>
      <h2>Flash<span>Sale.</span></h2>
      {maxDiscount ? <div className="buyer-flash-offer">UP TO <strong>{maxDiscount}%</strong> OFF</div> : null}
      <a href="#catalog">Shop deals <ArrowRight size={16} /></a>
    </div>
  </section>
    {featured.length > 0 && <section className="buyer-sale-products" aria-label="Sale products"><div className="buyer-sale-products-heading"><h2>Sale picks</h2></div><div className="buyer-flash-preview">{featured.map((p) => <Link key={productPath(p)} to={productPath(p)}>
      <div className="buyer-flash-image"><ProductImage product={p} className="rounded-none" /><span>-{p.discountPct}%</span></div>
      <div className="buyer-flash-product-info"><strong>{p.title}</strong><div className="buyer-flash-prices"><b>{shopPrice(p.minPriceVnd)}</b><del>{shopPrice(p.originalPriceVnd)}</del></div></div>
    </Link>)}</div><div className="buyer-sale-products-action"><a href="#catalog">View products</a></div></section>}
  </div>;
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
      <footer className="buyer-home-footer">
        <div className="buyer-footer-main">
          <Link to="/" className="buyer-footer-brand"><strong>TikTok</strong><span>SHOP SIMULATOR</span></Link>
          <nav aria-label="Shopping"><h2>Shop</h2><Link to="/">All products</Link><Link to="/cart">Cart</Link><Link to="/account/orders">Orders</Link></nav>
          <nav aria-label="Customer account"><h2>Account</h2><Link to="/login">Sign in</Link><Link to="/account/messages">Messages</Link></nav>
          <nav aria-label="Simulator tools"><h2>Workspace</h2><Link to="/seller-center">Seller Center</Link><Link to="/console">Test Console</Link></nav>
        </div>
        <div className="buyer-footer-bottom"><span>© {new Date().getFullYear()} TikTok SHOP SIMULATOR</span></div>
      </footer>
    </>
  );
}

function Products({ state, q, category }: { state: AsyncResult<EnrichedProduct[]>; q: string; category: string | null }) {
  if (state.loading && !state.data) {
    return (
      <section aria-label="Products">
        <div className={GRID} role="status" aria-label="Loading products">
          {Array.from({ length: 10 }, (_, i) => <ProductCardSkeleton key={i} />)}
        </div>
      </section>
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

  return <Catalog key={`${q}:${category ?? ''}`} items={state.data ?? []} q={q} category={category} />;
}
