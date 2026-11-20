import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingBag, Star } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { compactCount, shopPrice } from '@/lib/format';
import { productPath } from '@/lib/links';
import { cn } from '@/lib/utils';
import type { EnrichedProduct } from '@/mocks';

export function ProductImage({ product, className }: { product: EnrichedProduct; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === product.imageUrl;
  return (
    <div className={cn('relative aspect-square overflow-hidden rounded-lg', className)} style={{ backgroundColor: product.imageBg }}>
      {product.imageUrl && !failed ? (
        <img src={product.imageUrl} alt={product.title ?? ''} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedUrl(product.imageUrl)} className="size-full object-cover" />
      ) : (
        <div className="flex size-full items-center justify-center">
          <ShoppingBag className="size-1/3 text-ink/25" strokeWidth={1.25} />
        </div>
      )}
    </div>
  );
}

export function ProductCard({ product, className, compact = false }: { product: EnrichedProduct; className?: string; compact?: boolean }) {
  if (compact) return <Link to={productPath(product)} className="buyer-product-card">
    <div className="buyer-product-photo"><ProductImage product={product} className="aspect-[4/5] rounded-none" /></div>
    <div className="buyer-product-info"><h3>{product.title}</h3><strong>{shopPrice(product.minPriceVnd)}</strong>
    </div>
  </Link>;
  return (
    <Link to={productPath(product)} className={cn('group flex flex-col gap-2 rounded-xl p-1.5 transition-colors hover:bg-surface-2', className)}>
      <ProductImage product={product} />
      <div className="flex flex-col gap-1 px-0.5">
        <h3 className="line-clamp-2 min-h-[2.6em] text-sm leading-[1.3] text-ink">{product.title}</h3>
        <div className="flex items-center gap-1.5">
          <span className="text-base font-bold text-buyer">{shopPrice(product.minPriceVnd)}</span>
          {product.discountPct > 0 ? (
            <span className="rounded bg-buyer-soft px-1 text-xs font-semibold text-buyer">-{product.discountPct}%</span>
          ) : null}
        </div>
        {product.shop ? <p className="truncate text-xs text-muted-foreground">{product.shop.name}</p> : null}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Star className="size-3.5 fill-star text-star" aria-hidden />
          <span className="font-semibold text-ink">{product.rating.toFixed(1)}</span>
          <span aria-hidden>·</span>
          <span>{compactCount(product.sold)} sold</span>
        </div>
      </div>
    </Link>
  );
}

export function ProductCardSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-1.5" aria-hidden>
      <Skeleton className="aspect-square rounded-lg" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
