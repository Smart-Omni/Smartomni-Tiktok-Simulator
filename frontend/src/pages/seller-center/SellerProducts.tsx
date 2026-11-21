import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, History, ImageIcon, Package, Pencil, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { humanize, Loaded, NativeSelect, SellerCard } from '@/components/seller/SellerUi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/lib/auth';
import { addSku, deleteProduct, getCatalog, getInventoryHistory, patchProduct, patchSku } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import type { Catalog, CatalogProduct, CatalogSku, DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

/** Rules from the former /seller catalog (SellerCatalog). */
const STATUSES = ['DRAFT', 'ACTIVATE', 'SELLER_DEACTIVATED'];
export const isWholeVnd = (v: string): boolean => /^\d+$/.test(v) && Number(v) >= 1;
const LOW_STOCK = 5;
export const isLowStock = (p: CatalogProduct) => p.skus.some((s) => s.status === 'NORMAL' && s.totalStock <= LOW_STOCK);

type Run = (fn: () => Promise<unknown>, done: string) => Promise<boolean>;

const statusTone = (s: string) => (s === 'ACTIVATE' ? 'bg-teal-soft text-teal' : s === 'DELETED' ? 'bg-buyer-soft text-buyer-ink' : 'bg-[#FFF4E0] text-[#9A5B00]');
const productStatus = (status: string) => ({ ACTIVATE: 'Active', SELLER_DEACTIVATED: 'Inactive', DRAFT: 'Draft', DELETED: 'Deleted' })[status] ?? humanize(status);

function SkuRow({ sku, warehouses, disabled, onPatch }: { sku: CatalogSku; warehouses: Catalog['warehouses']; disabled: boolean; onPatch: (body: Record<string, unknown>, done: string) => void }) {
  const [price, setPrice] = useState(String(sku.priceVnd));
  const [stock, setStock] = useState<Record<string, string>>(Object.fromEntries(sku.stock.map((s) => [s.warehouseId, String(s.quantity)])));
  const priceValid = isWholeVnd(price);
  const stockValid = !Object.values(stock).some((v) => !/^\d+$/.test(v));
  const normal = sku.status === 'NORMAL';
  return (
    <TableRow aria-label={`SKU ${sku.sellerSku}`} className="seller-sku-row">
      <TableCell className="py-3">
        <div className="flex flex-col">
          <span className="font-medium">{sku.sellerSku}</span>
          <span className="font-mono text-xs text-muted-foreground">{sku.externalId}</span>
        </div>
      </TableCell>
      <TableCell className="py-3">
        {sku.name}
        {normal ? null : <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-muted-foreground">{humanize(sku.status)}</span>}
      </TableCell>
      <TableCell className="py-3">
        <div className="seller-sku-price">
          <span>₫</span>
          <Input aria-label={`Price of ${sku.sellerSku}`} inputMode="numeric" value={price} disabled={disabled} onChange={(e) => setPrice(e.target.value)} className="h-8 w-28" />
          <Button size="icon" variant="ghost" aria-label="Set" title="Save price" disabled={disabled || !priceValid || Number(price) === sku.priceVnd} onClick={() => onPatch({ priceVnd: Number(price) }, 'Price updated')}>
            <Check size={14} />
          </Button>
        </div>
        {!priceValid && <span className="text-xs text-destructive">Enter a whole VND amount</span>}
      </TableCell>
      <TableCell className="py-3">
        <div className="seller-sku-stock">
          {warehouses.map((w) => (
            <label key={w.externalId} className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              {w.name}
              <Input
                aria-label={`Stock of ${sku.sellerSku} in ${w.name}`}
                inputMode="numeric"
                value={stock[w.externalId] ?? '0'}
                disabled={disabled}
                onChange={(e) => setStock({ ...stock, [w.externalId]: e.target.value })}
                className="h-8 w-16"
              />
            </label>
          ))}
          <Button
            size="icon"
            variant="outline"
            aria-label="Set"
            title="Save stock"
            disabled={disabled || !stockValid}
            onClick={() => onPatch({ stock: Object.fromEntries(Object.entries(stock).map(([k, v]) => [k, Number(v)])) }, 'Stock updated')}
          >
            <Check size={14} />
          </Button>
        </div>
      </TableCell>
      <TableCell className="py-3 text-right">
        <Button size="sm" variant="outline" className={cn('seller-sku-toggle', normal && 'is-active')} disabled={disabled} onClick={() => onPatch({ status: normal ? 'DEACTIVATED' : 'NORMAL' }, normal ? 'Variant deactivated' : 'Variant activated')}>
          {normal ? 'Deactivate' : 'Activate'}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function ProductCard({ seller, product: p, warehouses, run }: { seller: DemoSession; product: CatalogProduct; warehouses: Catalog['warehouses']; run: Run }) {
  const deleted = p.status === 'DELETED';
  const known = STATUSES.includes(p.status);
  const [title, setTitle] = useState(p.title);
  const [variant, setVariant] = useState({ sellerSku: '', name: '', priceVnd: '' });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const prices = p.skus.map((s) => s.priceVnd);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;

  const addVariant = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => addSku(seller, p.id, { sellerSku: variant.sellerSku, name: variant.name, priceVnd: Number(variant.priceVnd) }), 'Variant added')) {
      setVariant({ sellerSku: '', name: '', priceVnd: '' });
    }
  };

  return (
    <SellerCard label={`Product ${p.externalId}`} className={cn('seller-product-card', expanded && 'is-expanded')}>
      <div className="seller-product-summary">
        <div className="seller-product-info">
        {p.images?.[0] ? (
          <img src={p.images[0].url} alt={`Main image of ${p.title}`} className="size-12 rounded-md object-cover ring-1 ring-line-soft" />
        ) : (
          <div aria-label="No image" className="flex size-12 items-center justify-center rounded-md bg-surface text-muted-foreground">
            <ImageIcon className="size-5" />
          </div>
        )}
        <div className="seller-product-identity">
          <h2 className="text-base font-bold">{p.title}</h2>
          {p.categoryPath?.length ? <span title={p.categoryPath.map((c) => c.name).join(' / ')}>{p.categoryPath.at(-1)?.name}</span> : null}
          <span className="font-mono text-xs text-muted-foreground">#{p.externalId}</span>
        </div>
        </div>
        <div className="seller-product-numbers">
          <strong>{minPrice === null ? 'No variants' : minPrice === maxPrice ? shopPrice(minPrice) : `${shopPrice(minPrice)} – ${shopPrice(maxPrice!)}`}</strong>
          <span>{p.skus.length} variants</span>
        </div>
        <div className="seller-product-stock"><strong>{p.skus.reduce((sum, s) => sum + s.totalStock, 0).toLocaleString()}</strong><span className={cn(isLowStock(p) && 'is-low')}>{isLowStock(p) ? 'Low stock' : 'Units available'}</span></div>
        <div><span className={cn('seller-product-status', statusTone(p.status))}><i />{productStatus(p.status)}</span></div>
        <Button variant="outline" size="sm" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse' : 'Manage'} <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>
      <div id={detailsId} hidden={!expanded} className="seller-product-editor">
      {!deleted ? (
        <div className="seller-product-settings">
          <label className="seller-product-title-field"><span>Name</span><div>
          <Input aria-label={`Title of ${p.externalId}`} value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 w-64" />
          <Button size="sm" variant="outline" disabled={!title.trim() || title === p.title} onClick={() => run(() => patchProduct(seller, p.id, { title }), 'Product renamed')}>
            Rename
          </Button>
          </div></label>
          <label className="seller-product-status-field"><span>Status</span>
          <NativeSelect aria-label={`Status of ${p.externalId}`} value={known ? p.status : ''} onChange={(e) => run(() => patchProduct(seller, p.id, { status: e.target.value }), 'Status updated')}>
            {known ? null : <option value="">{humanize(p.status)}</option>}
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {productStatus(s)}
              </option>
            ))}
          </NativeSelect>
          </label>
          <div className="seller-product-settings-actions"><Button asChild size="sm" variant="outline">
            <Link to={`/seller-center/products/${encodeURIComponent(p.id)}/edit`}>
              <Pencil /> Edit details
            </Link>
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} /> Delete
          </Button>
          </div>
        </div>
      ) : null}
      <div className="seller-product-editor-heading"><Package size={15} /><strong>Variants & inventory</strong><span className="seller-sku-count">{p.skus.length}</span></div>
      <div className="seller-sku-table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Seller SKU</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Stock per warehouse</TableHead>
              <TableHead className="text-right">Availability</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {p.skus.map((s) => (
              // re-key on the stored values so the inputs reset after a save, as in SellerCatalog
              <SkuRow key={`${s.id}:${s.priceVnd}:${s.totalStock}`} sku={s} warehouses={warehouses} disabled={deleted} onPatch={(body, done) => run(() => patchSku(seller, s.id, body), done)} />
            ))}
          </TableBody>
        </Table>
      </div>
      {!deleted ? (
        <form onSubmit={addVariant} className="seller-add-variant" aria-label={`Add variant to ${p.externalId}`}>
          <label><span>Seller SKU</span>
          <Input aria-label="New seller SKU" placeholder="Seller SKU" required value={variant.sellerSku} onChange={(e) => setVariant({ ...variant, sellerSku: e.target.value })} className="h-8 w-36" />
          </label><label><span>Variant</span>
          <Input aria-label="New variant name" placeholder="Variant" required value={variant.name} onChange={(e) => setVariant({ ...variant, name: e.target.value })} className="h-8 w-36" />
          </label><label><span>Price (VND)</span>
          <Input aria-label="New variant price" placeholder="Price VND" inputMode="numeric" required value={variant.priceVnd} onChange={(e) => setVariant({ ...variant, priceVnd: e.target.value })} className="h-8 w-32" />
          </label><Button type="submit" size="sm" disabled={!isWholeVnd(variant.priceVnd)}>
            <Plus /> Add variant
          </Button>
        </form>
      ) : null}
      </div>
      {confirmDelete ? (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(false)}>
          <DialogContent className="theme-seller font-sans sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Delete product?</DialogTitle>
              <DialogDescription>“{p.title}” is removed from sale. This cannot be undone.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(false)}>
                Keep product
              </Button>
              <Button
                variant="destructive"
                onClick={async () => {
                  setConfirmDelete(false);
                  await run(() => deleteProduct(seller, p.id), 'Product deleted');
                }}
              >
                Delete product
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </SellerCard>
  );
}

const PRODUCTS_PER_PAGE = 10;

function ProductList({ seller, catalog, lowOnly, run, onHistory }: { seller: DemoSession; catalog: Catalog; lowOnly: boolean; run: Run; onHistory: () => void }) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [sort, setSort] = useState('default');
  const source = lowOnly ? catalog.items.filter(isLowStock) : catalog.items;
  const term = query.trim().toLocaleLowerCase();
  const items = source.filter((p) => (status === 'ALL' || p.status === status) && (!term || [p.title, p.externalId, ...p.skus.map((s) => s.sellerSku)].some((v) => v.toLocaleLowerCase().includes(term))));
  if (sort === 'name') items.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'stock') items.sort((a, b) => a.skus.reduce((sum, s) => sum + s.totalStock, 0) - b.skus.reduce((sum, s) => sum + s.totalStock, 0));
  const pages = Math.max(1, Math.ceil(items.length / PRODUCTS_PER_PAGE));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * PRODUCTS_PER_PAGE;
  return (
    <div className="seller-catalog">
      <div className="seller-catalog-statuses" aria-label="Product status filters">
        {[{ value: 'ALL', label: 'All' }, ...STATUSES.map((value) => ({ value, label: productStatus(value) })), { value: 'DELETED', label: 'Deleted' }].map((option) => <button key={option.value} type="button" aria-pressed={status === option.value} onClick={() => { setStatus(option.value); setPage(1); }}>
          {option.label}<span>{source.filter((p) => option.value === 'ALL' || p.status === option.value).length}</span>
        </button>)}
      </div>
      <div className="seller-catalog-toolbar">
        <label className="seller-catalog-search"><Search size={16} /><Input aria-label="Search products" placeholder="Search product name, ID or SKU…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} />{query && <button type="button" aria-label="Clear product search" onClick={() => { setQuery(''); setPage(1); }}><X size={14} /></button>}</label>
        <label className="seller-catalog-sort"><ArrowUpDown size={14} /><NativeSelect aria-label="Sort products" value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }}><option value="default">Default order</option><option value="name">Name: A to Z</option><option value="stock">Stock: low to high</option></NativeSelect></label>
        <div className="seller-catalog-actions"><Button variant="outline" size="icon" className="seller-catalog-history" aria-label="Stock history" title="Stock history" onClick={onHistory}><History size={14} /></Button><Button asChild><Link to="/seller-center/products/new"><Plus size={14} /> New product</Link></Button></div>
      </div>
      <div className="seller-catalog-columns" aria-hidden="true"><span>Product information</span><span>Price / Variants</span><span>Inventory</span><span>Status</span><span>Actions</span></div>
      <div className="seller-product-list">
        {items.slice(offset, offset + PRODUCTS_PER_PAGE).map((p) => <ProductCard key={`${p.id}:${p.title}`} seller={seller} product={p} warehouses={catalog.warehouses} run={run} />)}
        {!items.length && <div className="seller-catalog-empty"><Package size={30} /><h2>{query || status !== 'ALL' ? 'No matching products' : 'No products to display'}</h2>{(query || status !== 'ALL') && <Button variant="outline" onClick={() => { setQuery(''); setStatus('ALL'); setPage(1); }}>Clear filters</Button>}</div>}
      </div>
      <nav aria-label="Product pagination" className="seller-product-pagination">
        <span>Showing {items.length ? offset + 1 : 0}–{Math.min(offset + PRODUCTS_PER_PAGE, items.length)} of {items.length} products</span>
        <div>
          <Button variant="outline" size="sm" aria-label="Previous product page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="size-3.5" /></Button>
          <span>Page {currentPage} of {pages}</span>
          <Button variant="outline" size="sm" aria-label="Next product page" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight className="size-3.5" /></Button>
        </div>
      </nav>
    </div>
  );
}

function StockHistory({ seller, onBack }: { seller: DemoSession; onBack: () => void }) {
  const history = useAsync(() => getInventoryHistory(seller), [seller.sessionToken, seller.shopId], 5000);
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
  return (
    <>
    <nav className="seller-stock-breadcrumb" aria-label="Stock history navigation"><button type="button" aria-label="Back to products" onClick={onBack}>Products</button><ChevronRight size={12} aria-hidden="true" /><span aria-current="page">Stock history</span></nav>
    <Loaded result={history} what="stock history">
      {(d) => (
        <div className="flex flex-col gap-4">
          <SellerCard label="Stock changes" className="p-5">
            <h2 className="mb-3 text-base font-bold">Stock changes (before / after)</h2>
            {d.changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No stock changes yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead className="text-right">Before</TableHead>
                    <TableHead className="text-right">After</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Request / note</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.changes.map((c) => (
                    <TableRow key={c.seq}>
                      <TableCell>{c.seq}</TableCell>
                      <TableCell>
                        {c.sellerSku}
                        <div className="font-mono text-xs text-muted-foreground">{c.sku}</div>
                      </TableCell>
                      <TableCell>{c.warehouseName}</TableCell>
                      <TableCell className="text-right">{c.before}</TableCell>
                      <TableCell className="text-right">{c.after}</TableCell>
                      <TableCell>
                        <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', c.source === 'API' ? 'bg-teal-soft text-teal' : 'bg-surface')}>{c.source}</span>
                        {c.noop ? (
                          <span className="ml-1 rounded-full bg-[#FFF4E0] px-2 py-0.5 text-xs text-[#9A5B00]" title="The value was already stored, so a retry changed nothing">
                            no-op retry
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{c.requestId ?? c.note}</TableCell>
                      <TableCell className="text-xs">{when(c.at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SellerCard>
          <SellerCard label="Update Inventory API calls" className="p-5">
            <h2 className="mb-3 text-base font-bold">Update Inventory API calls</h2>
            {d.attempts.length === 0 ? (
              <p className="text-sm text-muted-foreground">SmartOmni has not called Update Inventory yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead className="text-right">SKUs</TableHead>
                    <TableHead>Request</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.attempts.map((a) => (
                    <TableRow key={a.seq}>
                      <TableCell>{a.seq}</TableCell>
                      <TableCell className="font-mono text-xs">{a.product}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-semibold',
                            a.outcome === 'APPLIED' ? 'bg-teal-soft text-teal' : a.outcome === 'PARTIAL' ? 'bg-[#FFF4E0] text-[#9A5B00]' : 'bg-buyer-soft text-buyer-ink',
                          )}
                        >
                          {a.outcome}
                        </span>
                      </TableCell>
                      <TableCell className="text-right text-xs">
                        {a.itemsApplied} ok / {a.itemsFailed} failed of {a.itemsTotal}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.requestId}</TableCell>
                      <TableCell className="text-xs">{when(a.at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SellerCard>
        </div>
      )}
    </Loaded>
    </>
  );
}

function Products({ seller }: { seller: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const lowOnly = params.get('filter') === 'low-stock';
  const [tab, setTab] = useState('products');
  const catalog = useAsync(() => getCatalog(seller), [seller.sessionToken, seller.shopId]);

  const run: Run = async (fn, done) => {
    try {
      await fn();
      toast.success(done);
      catalog.reload();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };

  return (
    <div className="seller-products-page flex flex-col gap-4">
      <div className={cn('flex-col gap-4', tab === 'products' ? 'flex' : 'hidden')}>
          {lowOnly ? (
            <div className="flex w-fit items-center gap-2 rounded-full bg-teal-soft px-3 py-1 text-sm text-teal">
              <SlidersHorizontal size={13} /> Low stock (≤{LOW_STOCK}) only
              <button type="button" aria-label="Show all products" className="cursor-pointer" onClick={() => setParams({}, { replace: true })}>
                <X className="size-4" />
              </button>
            </div>
          ) : null}
          <Loaded result={catalog} what="products">
            {(d) => <ProductList key={String(lowOnly)} seller={seller} catalog={d} lowOnly={lowOnly} run={run} onHistory={() => setTab('history')} />}
          </Loaded>
        </div>
      {tab === 'history' && <StockHistory seller={seller} onBack={() => setTab('products')} />}

    </div>
  );
}

export function SellerProducts() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Products key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
