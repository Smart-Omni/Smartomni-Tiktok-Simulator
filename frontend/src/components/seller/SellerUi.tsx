import type { ComponentProps, ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { AsyncResult } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

/** White 12px card on the #F4F4F5 Seller Center background (board SellerOrders). */
export function SellerCard({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <section aria-label={label} className={cn('seller-card rounded-card bg-white shadow-xs ring-1 ring-line-soft', className)}>
      {children}
    </section>
  );
}

/** Loading skeleton / error with retry for the first load of a Seller Center list; renders children once data is there. */
export function Loaded<T>({ result, what, children }: { result: AsyncResult<T>; what: string; children: (data: T) => ReactNode }) {
  if (result.loading && result.data === undefined) {
    return (
      <div className="flex flex-col gap-2 p-4" role="status" aria-label={`Loading ${what}`}>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}
      </div>
    );
  }
  if (result.error && result.data === undefined) {
    return (
      <div className="p-4">
        <Alert variant="destructive">
          <AlertDescription>
            <p>
              Could not load {what}: {result.error.message}
            </p>
            <Button variant="outline" size="sm" className="mt-1" onClick={result.reload}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return result.data === undefined ? null : <>{children(result.data)}</>;
}

/** Native select styled like the shadcn inputs (easy to use with a keyboard and in tests). */
export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn('h-8 rounded-md border border-input bg-white px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40', className)} {...props} />;
}

export const humanize = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
