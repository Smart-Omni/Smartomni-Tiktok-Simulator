import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, MessageCircle, Search, ShoppingBag, SlidersHorizontal, Store } from 'lucide-react';
import { ShopFooter } from '@/components/shop/ShopFooter';
import { AsyncState } from '@/components/AsyncState';
import { loginUrl } from '@/components/RequireRole';
import { useAuth } from '@/lib/auth';
import { listMarketplaceProducts } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import { productPath } from '@/lib/links';
import { useAsync } from '@/lib/useAsync';

const normalized = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
const PAGE_SIZE = 18;

function ShopCatalog({ shopId }: { shopId: string }) {
  const { buyer } = useAuth();
  const location = useLocation();
  const products = useAsync(() => listMarketplaceProducts(shopId), [shopId]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('default');
  const [inStock, setInStock] = useState(false);
  const [minDraft, setMinDraft] = useState('');
  const [maxDraft, setMaxDraft] = useState('');
  const [price, setPrice] = useState<{ min?: number; max?: number }>({});
  const [requestedPage, setPage] = useState(1);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const shopItems = (products.data ?? []).filter((p) => p.shop?.id === shopId);
  const name = shopItems[0]?.shop?.name ?? (typeof location.state?.shopName === 'string' ? location.state.shopName : 'Shop');
  const validPrice = [minDraft, maxDraft].every((n) => n === '' || (Number.isSafeInteger(Number(n)) && Number(n) >= 0)) && (minDraft === '' || maxDraft === '' || Number(minDraft) <= Number(maxDraft));
  const filtered = !!query || inStock || price.min !== undefined || price.max !== undefined;
  function clearFilters() { setQuery(''); setInStock(false); setMinDraft(''); setMaxDraft(''); setPrice({}); setPage(1); }
  const items = shopItems.filter((p) => normalized(`${p.title} ${p.description}`).includes(normalized(query)) && (!inStock || p.skus.some((sku) => sku.available && sku.stock > 0)) && (price.min === undefined || p.maxPriceVnd >= price.min) && (price.max === undefined || p.minPriceVnd <= price.max));
  if (sort === 'price-asc') items.sort((a, b) => a.minPriceVnd - b.minPriceVnd);
  if (sort === 'price-desc') items.sort((a, b) => b.minPriceVnd - a.minPriceVnd);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  const firstPage = Math.max(1, Math.min(page - 1, pages - 2));
  const pageNumbers = Array.from({ length: Math.min(3, pages) }, (_, i) => firstPage + i);
  return <div className="buyer-shop-page">
    <nav aria-label="Breadcrumb" className="detail-breadcrumb"><Link to="/">Home</Link><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">{name}</span></nav>
    <section className="buyer-shop-profile" aria-label="Shop"><span className="buyer-shop-mark"><Store size={22} /></span><div><h1>{name}</h1>{products.data && <p>{shopItems.length} {shopItems.length === 1 ? 'product' : 'products'}</p>}</div><Link className="buyer-shop-chat" to={buyer ? `/account/messages?shop=${encodeURIComponent(shopId)}` : loginUrl(`/account/messages?shop=${encodeURIComponent(shopId)}`)}><MessageCircle size={15} />Chat with shop</Link></section>
    <div className="buyer-shop-layout">
    <aside className="buyer-shop-filters" aria-label="Shop filters">
      <div className="buyer-shop-filter-heading"><h2><SlidersHorizontal size={15} />Filters</h2><button onClick={clearFilters} disabled={!filtered && !minDraft && !maxDraft}>Reset</button></div>
      <div className="buyer-shop-filter-section"><label className="buyer-shop-filter-label" htmlFor="shop-search">Search</label><div className="buyer-shop-filter-search"><Search size={14} /><input id="shop-search" aria-label="Search in this shop" placeholder="Find a product" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></div></div>
      <form className="buyer-shop-filter-section" aria-label="Price filter" onSubmit={(event) => { event.preventDefault(); if (validPrice) { setPrice({ min: minDraft === '' ? undefined : Number(minDraft), max: maxDraft === '' ? undefined : Number(maxDraft) }); setPage(1); } }}>
        <h3>Price range <span>VND</span></h3><div className="buyer-shop-price-inputs"><label>Min<input aria-label="Minimum price" type="number" min={0} step={1} placeholder="From" value={minDraft} onChange={(e) => setMinDraft(e.target.value)} /></label><span aria-hidden="true">–</span><label>Max<input aria-label="Maximum price" type="number" min={0} step={1} placeholder="To" value={maxDraft} onChange={(e) => setMaxDraft(e.target.value)} /></label></div>
        {!validPrice && <p className="buyer-shop-filter-error" role="alert">Enter valid prices with Min no greater than Max.</p>}<button className="buyer-shop-apply" disabled={!validPrice}>Apply</button>
      </form>
      <div className="buyer-shop-filter-section"><h3>Availability</h3><label className="buyer-shop-stock-check"><input type="checkbox" checked={inStock} onChange={(e) => { setInStock(e.target.checked); setPage(1); }} />In stock only</label></div>
    </aside>
    <section className="buyer-shop-catalog" aria-label="Shop products">
      <div className="buyer-shop-toolbar"><select aria-label="Sort shop products" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="default">Default order</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></div>
      {products.error && products.data && <div role="alert" className="state state-error">Could not refresh products: {products.error.message}<button onClick={products.reload}>Retry</button></div>}
      <AsyncState {...products} onRetry={products.reload}>{() => items.length ? <>
        <div className="buyer-product-grid buyer-product-grid-6 buyer-shop-grid">{items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((p) => <Link key={p.id} to={productPath(p)} className="buyer-product-card"><div className="buyer-product-photo"><div className="buyer-shop-photo">{p.imageUrl && !failedImages.includes(p.imageUrl) ? <img src={p.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImages((old) => [...old, p.imageUrl])} /> : <ShoppingBag size={32} aria-hidden="true" />}</div></div><div className="buyer-product-info"><h3>{p.title}</h3><strong>{shopPrice(p.minPriceVnd)}</strong>{p.maxPriceVnd > p.minPriceVnd && <span className="buyer-shop-price-range">– {shopPrice(p.maxPriceVnd)}</span>}</div></Link>)}</div>
        {pages > 1 && <nav className="buyer-pagination" aria-label="Shop products pagination"><button type="button" aria-label="Previous page" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button>{pageNumbers.map((number) => <button type="button" key={number} aria-label={`Page ${number}`} aria-current={page === number ? 'page' : undefined} onClick={() => setPage(number)}>{number}</button>)}<button type="button" aria-label="Next page" disabled={page === pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></nav>}
      </> : <div className="buyer-shop-empty"><ShoppingBag size={30} /><p>{filtered ? 'No products match your filters.' : 'No products available in this shop.'}</p>{filtered && <button onClick={clearFilters}>Clear filters</button>}</div>}</AsyncState>
    </section>
    </div>
    <ShopFooter />
  </div>;
}

export function ShopPage() {
  const { shopId = '' } = useParams();
  return <ShopCatalog key={shopId} shopId={shopId} />;
}
