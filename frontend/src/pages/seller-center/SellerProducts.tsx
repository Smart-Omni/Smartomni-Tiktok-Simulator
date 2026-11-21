import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, ImageIcon, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { humanize, Loaded, NativeSelect, SellerCard } from '@/components/seller/SellerUi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

function SkuRow({ sku, warehouses, disabled, onPatch }: { sku: CatalogSku; warehouses: Catalog['warehouses']; disabled: boolean; onPatch: (body: Record<string, unknown>, done: string) => void }) {
  const [price, setPrice] = useState(String(sku.priceVnd));
  const [stock, setStock] = useState<Record<string, string>>(Object.fromEntries(sku.stock.map((s) => [s.warehouseId, String(s.quantity)])));
  const priceValid = isWholeVnd(price);
  const stockValid = !Object.values(stock).some((v) => !/^\d+$/.test(v));
  const normal = sku.status === 'NORMAL';
  return (
    <TableRow aria-label={`SKU ${sku.sellerSku}`} className="align-top">
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
        <div className="flex items-center gap-1.5">
          <Input aria-label={`Price of ${sku.sellerSku}`} inputMode="numeric" value={price} disabled={disabled} onChange={(e) => setPrice(e.target.value)} className="h-8 w-28" />
          <Button size="sm" variant="outline" disabled={disabled || !priceValid || Number(price) === sku.priceVnd} onClick={() => onPatch({ priceVnd: Number(price) }, 'Price updated')}>
            Set
          </Button>
        </div>
        <span className={cn('text-xs', priceValid ? 'text-muted-foreground' : 'text-destructive')}>{priceValid ? shopPrice(Number(price)) : 'Enter a whole VND amount'}</span>
      </TableCell>
      <TableCell className="py-3">
        <div className="flex flex-wrap items-end gap-1.5">
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
            size="sm"
            variant="outline"
            disabled={disabled || !stockValid}
            onClick={() => onPatch({ stock: Object.fromEntries(Object.entries(stock).map(([k, v]) => [k, Number(v)])) }, 'Stock updated')}
          >
            Set
          </Button>
        </div>
      </TableCell>
      <TableCell className="py-3 text-right">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onPatch({ status: normal ? 'DEACTIVATED' : 'NORMAL' }, normal ? 'Variant deactivated' : 'Variant activated')}>
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
    <SellerCard label={`Product ${p.externalId}`} className="seller-product-card p-4">
      <div className="seller-product-summary">
        {p.images?.[0] ? (
          <img src={p.images[0].url} alt={`Main image of ${p.title}`} className="size-12 rounded-md object-cover ring-1 ring-line-soft" />
        ) : (
          <div aria-label="No image" className="flex size-12 items-center justify-center rounded-md bg-surface text-muted-foreground">
            <ImageIcon className="size-5" />
          </div>
        )}
        <div className="seller-product-identity">
          <h2 className="text-base font-bold">{p.title}</h2>
          {p.categoryPath?.length ? <span className="text-xs text-muted-foreground">{p.categoryPath.map((c) => c.name).join(' > ')}</span> : null}
          <span className="font-mono text-xs text-muted-foreground">#{p.externalId}</span>
        </div>
        <div className="seller-product-numbers">
          <strong>{minPrice === null ? 'No variants' : minPrice === maxPrice ? shopPrice(minPrice) : `${shopPrice(minPrice)} – ${shopPrice(maxPrice!)}`}</strong>
          <span>{p.skus.length} variants · {p.skus.reduce((sum, s) => sum + s.totalStock, 0)} in stock</span>
        </div>
        <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', statusTone(p.status))}>{humanize(p.status)}</span>
        <Button variant="outline" size="sm" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse' : 'Manage'} <ChevronDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>
      <div id={detailsId} hidden={!expanded}>
      {!deleted ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input aria-label={`Title of ${p.externalId}`} value={title} onChange={(e) => setTitle(e.target.value)} className="h-8 w-64" />
          <Button size="sm" variant="outline" disabled={!title.trim() || title === p.title} onClick={() => run(() => patchProduct(seller, p.id, { title }), 'Product renamed')}>
            Rename
          </Button>
          <NativeSelect aria-label={`Status of ${p.externalId}`} value={known ? p.status : ''} onChange={(e) => run(() => patchProduct(seller, p.id, { status: e.target.value }), 'Status updated')}>
            {known ? null : <option value="">{humanize(p.status)}</option>}
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </NativeSelect>
          <Button asChild size="sm" variant="outline" className="ml-auto">
            <Link to={`/seller-center/products/${encodeURIComponent(p.id)}/edit`}>
              <Pencil /> Edit details
            </Link>
          </Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      ) : null}
      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Seller SKU</TableHead>
              <TableHead>Variant</TableHead>
              <TableHead>Price</TableHead>
              <TableHead>Stock per warehouse</TableHead>
              <TableHead />
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
        <form onSubmit={addVariant} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3" aria-label={`Add variant to ${p.externalId}`}>
          <Input aria-label="New seller SKU" placeholder="Seller SKU" required value={variant.sellerSku} onChange={(e) => setVariant({ ...variant, sellerSku: e.target.value })} className="h-8 w-36" />
          <Input aria-label="New variant name" placeholder="Variant" required value={variant.name} onChange={(e) => setVariant({ ...variant, name: e.target.value })} className="h-8 w-36" />
          <Input aria-label="New variant price" placeholder="Price VND" inputMode="numeric" required value={variant.priceVnd} onChange={(e) => setVariant({ ...variant, priceVnd: e.target.value })} className="h-8 w-32" />
          <Button type="submit" size="sm" variant="outline" disabled={!isWholeVnd(variant.priceVnd)}>
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

function ProductList({ seller, catalog, lowOnly, run }: { seller: DemoSession; catalog: Catalog; lowOnly: boolean; run: Run }) {
  const [page, setPage] = useState(1);
  const items = lowOnly ? catalog.items.filter(isLowStock) : catalog.items;
  const pages = Math.max(1, Math.ceil(items.length / PRODUCTS_PER_PAGE));
  const currentPage = Math.min(page, pages);
  const offset = (currentPage - 1) * PRODUCTS_PER_PAGE;
  if (!items.length) {
    return <SellerCard className="py-12 text-center text-sm text-muted-foreground">{lowOnly ? 'No product is low on stock.' : 'No products yet. Create one with New product.'}</SellerCard>;
  }
  return (
    <>
      <div className="seller-product-list">
        {items.slice(offset, offset + PRODUCTS_PER_PAGE).map((p) => <ProductCard key={`${p.id}:${p.title}`} seller={seller} product={p} warehouses={catalog.warehouses} run={run} />)}
      </div>
      <nav aria-label="Product pagination" className="seller-product-pagination">
        <span>{offset + 1}–{Math.min(offset + PRODUCTS_PER_PAGE, items.length)} of {items.length} products</span>
        <div>
          <Button variant="outline" size="sm" aria-label="Previous product page" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft className="size-3.5" /></Button>
          <span>Page {currentPage} of {pages}</span>
          <Button variant="outline" size="sm" aria-label="Next product page" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)}><ChevronRight className="size-3.5" /></Button>
        </div>
      </nav>
    </>
  );
}

function StockHistory({ seller }: { seller: DemoSession }) {
  const history = useAsync(() => getInventoryHistory(seller), [seller.sessionToken, seller.shopId], 5000);
  const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
  return (
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
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Products</h1>
        <Button asChild className="ml-auto">
          <Link to="/seller-center/products/new">
            <Plus /> New product
          </Link>
        </Button>
      </div>
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList variant="line" className="h-10 max-w-full justify-start gap-2 overflow-x-auto overflow-y-hidden border-b border-line-soft [scrollbar-width:none]">
          <TabsTrigger value="products" className="flex-none px-3 after:bg-teal data-[state=active]:font-semibold data-[state=active]:text-teal">
            Products
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-none px-3 after:bg-teal data-[state=active]:font-semibold data-[state=active]:text-teal">
            Stock history
          </TabsTrigger>
        </TabsList>
        <TabsContent value="products" className="flex flex-col gap-4">
          {lowOnly ? (
            <div className="flex w-fit items-center gap-2 rounded-full bg-teal-soft px-3 py-1 text-sm text-teal">
              Low stock (≤{LOW_STOCK}) only
              <button type="button" aria-label="Show all products" className="cursor-pointer" onClick={() => setParams({}, { replace: true })}>
                <X className="size-4" />
              </button>
            </div>
          ) : null}
          <Loaded result={catalog} what="products">
            {(d) => <ProductList key={String(lowOnly)} seller={seller} catalog={d} lowOnly={lowOnly} run={run} />}
          </Loaded>
        </TabsContent>
        <TabsContent value="history">
          <StockHistory seller={seller} />
        </TabsContent>
      </Tabs>

    </div>
  );
}

export function SellerProducts() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Products key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
