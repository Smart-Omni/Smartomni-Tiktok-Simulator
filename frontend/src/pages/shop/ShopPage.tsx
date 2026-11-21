import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, MessageCircle, Search, ShoppingBag, Store } from 'lucide-react';
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
  const [requestedPage, setPage] = useState(1);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const shopItems = (products.data ?? []).filter((p) => p.shop?.id === shopId);
  const name = shopItems[0]?.shop?.name ?? (typeof location.state?.shopName === 'string' ? location.state.shopName : 'Shop');
  const items = shopItems.filter((p) => normalized(`${p.title} ${p.description}`).includes(normalized(query)));
  if (sort === 'price-asc') items.sort((a, b) => a.minPriceVnd - b.minPriceVnd);
  if (sort === 'price-desc') items.sort((a, b) => b.minPriceVnd - a.minPriceVnd);
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages);
  return <div className="buyer-shop-page">
    <nav aria-label="Breadcrumb" className="detail-breadcrumb"><Link to="/">Home</Link><ChevronRight size={14} aria-hidden="true" /><span aria-current="page">{name}</span></nav>
    <section className="buyer-shop-profile" aria-label="Shop"><span className="buyer-shop-mark"><Store size={22} /></span><div><h1>{name}</h1>{products.data && <p>{shopItems.length} {shopItems.length === 1 ? 'product' : 'products'}</p>}</div><Link className="buyer-shop-chat" to={buyer ? `/account/messages?shop=${encodeURIComponent(shopId)}` : loginUrl(`/account/messages?shop=${encodeURIComponent(shopId)}`)}><MessageCircle size={15} />Chat with shop</Link></section>
    <section className="buyer-shop-catalog" aria-label="Shop products">
      <div className="buyer-shop-toolbar"><label><Search size={16} /><input aria-label="Search in this shop" placeholder="Search in this shop" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></label><select aria-label="Sort shop products" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="default">Default order</option><option value="price-asc">Price: low to high</option><option value="price-desc">Price: high to low</option></select></div>
      {products.error && products.data && <div role="alert" className="state state-error">Could not refresh products: {products.error.message}<button onClick={products.reload}>Retry</button></div>}
      <AsyncState {...products} onRetry={products.reload}>{() => items.length ? <>
        <div className="buyer-product-grid buyer-product-grid-6 buyer-shop-grid">{items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((p) => <Link key={p.id} to={productPath(p)} className="buyer-product-card"><div className="buyer-product-photo"><div className="buyer-shop-photo">{p.imageUrl && !failedImages.includes(p.imageUrl) ? <img src={p.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedImages((old) => [...old, p.imageUrl])} /> : <ShoppingBag size={32} aria-hidden="true" />}</div></div><div className="buyer-product-info"><h3>{p.title}</h3><strong>{shopPrice(p.minPriceVnd)}</strong>{p.maxPriceVnd > p.minPriceVnd && <span className="buyer-shop-price-range">– {shopPrice(p.maxPriceVnd)}</span>}</div></Link>)}</div>
        <nav className="buyer-shop-pagination" aria-label="Shop products pagination"><span>{(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, items.length)} of {items.length}</span><div><button aria-label="Previous page" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {pages}</span><button aria-label="Next page" disabled={page === pages} onClick={() => setPage(page + 1)}><ChevronRight size={16} /></button></div></nav>
      </> : <div className="buyer-shop-empty"><ShoppingBag size={30} /><p>{query ? 'No products match your search.' : 'No products available in this shop.'}</p>{query && <button onClick={() => { setQuery(''); setPage(1); }}>Clear search</button>}</div>}</AsyncState>
    </section>
    <ShopFooter />
  </div>;
}

export function ShopPage() {
  const { shopId = '' } = useParams();
  return <ShopCatalog key={shopId} shopId={shopId} />;
}
