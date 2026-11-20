import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Stars({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('inline-flex gap-0.5', className)} aria-label={`${value} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star key={i} className={cn('size-3.5', i <= Math.round(value) ? 'fill-star text-star' : 'text-line')} aria-hidden />
      ))}
    </span>
  );
}

