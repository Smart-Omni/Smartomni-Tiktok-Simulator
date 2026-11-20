import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { CategoryRow } from '@/components/shop/CategoryRow';
import { ProductCard, ProductCardSkeleton } from '@/components/shop/ProductCard';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { MockBadge } from '@/components/ui/mock-badge';
import { useAuth } from '@/lib/auth';
import { productPath } from '@/lib/links';
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

function Section({ id, title, mock, action, children }: { id: string; title: ReactNode; mock: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-8 first:mt-2">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 id={id} className="text-xl font-bold tracking-tight text-ink">
          {title}
        </h2>
        {mock && import.meta.env.DEV ? <MockBadge /> : null}
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

/** One row of cards (5 / 3 / 2 visible) scrolled a page at a time with the arrow buttons. */
function DealsRow({ items, mock }: { items: EnrichedProduct[]; mock: boolean }) {
  const { ref, edges, update, page } = useHorizontalScroll<HTMLDivElement>([items]);

  return (
    <Section
      id="deals"
      title="Deals on 4★+ products for you"
      mock={mock}
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

function BestSellers({ items, mock }: { items: EnrichedProduct[]; mock: boolean }) {
  const [shown, setShown] = useState(BEST_SELLERS_PAGE);
  return (
    <Section id="best-sellers" title="Best sellers" mock={mock}>
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
function Results({ items, q, category, mock }: { items: EnrichedProduct[]; q: string; category: string | null; mock: boolean }) {
  const cat = categoryBySlug(category);
  const inCategory = cat ? items.filter((p) => p.category === cat.slug) : items;
  const found = q ? search(inCategory, q) : inCategory;
  const title = q ? `Results for “${q}”${cat ? ` in ${cat.name}` : ''} (${found.length})` : `${cat?.name ?? 'All products'} (${found.length})`;
  return (
    <Section
      id="results"
      title={title}
      mock={mock}
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

export function HomePage() {
  const { buyer } = useAuth();
  const [params] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  const category = categoryBySlug(params.get('category')) ? params.get('category') : null;
  const products = useAsync<EnrichedProduct[]>(
    () => (buyer ? listMarketplaceProducts().then((items) => items.map(enrichProduct)) : Promise.resolve(mockCatalog)),
    [buyer?.sessionToken],
  );
  const mock = !buyer;

  return (
    <>
      <CategoryRow />
      <Products state={products} q={q} category={category} mock={mock} />
    </>
  );
}

function Products({ state, q, category, mock }: { state: AsyncResult<EnrichedProduct[]>; q: string; category: string | null; mock: boolean }) {
  if (state.loading && !state.data) {
    return (
      <Section id="loading" title="Deals on 4★+ products for you" mock={false}>
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
  if (q || category) return <Results items={items} q={q} category={category} mock={mock} />;
  const dealItems = deals(items);
  return (
    <>
      {dealItems.length ? <DealsRow items={dealItems} mock={mock} /> : null}
      <BestSellers items={bestSellers(items)} mock={mock} />
    </>
  );
}
