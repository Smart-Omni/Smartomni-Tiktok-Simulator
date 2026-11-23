import { Link, useSearchParams } from 'react-router-dom';
import { mockCategories } from '@/mocks';

/** Catalog filters are presentation-only; categories without products show an empty result. */
export function CategoryRow() {
  const [params] = useSearchParams();
  const active = params.get('category');
  const linkFor = (slug: string) => {
    const next = new URLSearchParams(params);
    if (active === slug) next.delete('category'); else next.set('category', slug);
    return next.size ? `/?${next}` : '/';
  };
  return <section className="buyer-category-section" aria-label="Categories">
    <h2>Categories</h2>
    <div className="buyer-category-list">
      <Link to={params.get('q') ? `/?q=${encodeURIComponent(params.get('q')!)}` : '/'} aria-current={!active ? 'true' : undefined}>All</Link>
      {mockCategories.map((category) => <Link key={category.slug} to={linkFor(category.slug)} aria-current={active === category.slug ? 'true' : undefined}>{category.name}</Link>)}
    </div>
  </section>;
}
