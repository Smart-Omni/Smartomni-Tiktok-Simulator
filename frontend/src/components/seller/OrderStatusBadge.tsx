import type { OrderStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

const tone: Record<OrderStatus, string> = {
  UNPAID: 'bg-buyer-soft text-buyer-ink',
  AWAITING_SHIPMENT: 'bg-[#FFF4E0] text-[#9A5B00]',
  AWAITING_COLLECTION: 'bg-[#FFF4E0] text-[#9A5B00]',
  PARTIALLY_SHIPPING: 'bg-teal-soft text-teal',
  IN_TRANSIT: 'bg-teal-soft text-teal',
  DELIVERED: 'bg-free-ship/10 text-free-ship',
  COMPLETED: 'bg-free-ship/10 text-free-ship',
  CANCELLED: 'bg-surface text-muted-foreground',
};

const label: Record<OrderStatus, string> = {
  UNPAID: 'Unpaid',
  AWAITING_SHIPMENT: 'To ship',
  AWAITING_COLLECTION: 'Awaiting collection',
  PARTIALLY_SHIPPING: 'Partly shipped',
  IN_TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

/** Order status as the seller sees it. A status the UI does not know (old data) shows as its raw value (DECISIONS H12). */
export function OrderStatusBadge({ status, className }: { status: OrderStatus; className?: string }) {
  return <span className={cn('inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', tone[status] ?? 'bg-surface text-muted-foreground', className)}>{label[status] ?? status}</span>;
}
