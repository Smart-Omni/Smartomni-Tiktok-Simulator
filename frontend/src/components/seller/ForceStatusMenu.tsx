import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ORDER_NEXT, orderStatusLabel } from '@/lib/orderNext';
import { transitionOrder } from '@/pages/console/adminEndpoints';

/**
 * TEST: forces an order through the simulator state machine (POST /test-admin/orders/:ref/transition), e.g. to reach
 * DELIVERED or COMPLETED, which a seller cannot do in TikTok. "Next step" leaves `to` out so the API also drives fulfillment.
 */
export function ForceStatusMenu({ shopId, orderId, status, onChanged, className }: { shopId: string; orderId: string; status: string; onChanged: () => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  const next = ORDER_NEXT[status] ?? [];
  if (next.length === 0) return null;
  const go = async (to?: string) => {
    setBusy(true);
    try {
      const r = await transitionOrder(shopId, orderId, to);
      if (r.transitioned) toast.success(`${orderId}: ${orderStatusLabel(r.from)} → ${orderStatusLabel(r.status)}`);
      else toast.info(`${orderId} stays ${orderStatusLabel(r.status)}`);
      onChanged();
    } catch (e) {
      toast.error(`Refused: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="outline" disabled={busy} className={className ?? 'seller-test-button'} aria-label={`Force status of ${orderId}`}>
          <FlaskConical aria-hidden="true" />Force status
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="theme-seller min-w-48">
        <DropdownMenuLabel className="text-xs">TEST · simulator state machine</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void go()}>Next step</DropdownMenuItem>
        <DropdownMenuSeparator />
        {next.map((to) => <DropdownMenuItem key={to} onSelect={() => void go(to)}>{to === 'CANCELLED' ? 'Cancel order' : orderStatusLabel(to)}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
