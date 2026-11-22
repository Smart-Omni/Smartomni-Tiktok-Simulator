import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/seller/SellerUi';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { advanceShipment, arrangeShipment, cancelOrder, getShippingLabel } from '@/lib/endpoints';
import { advanceHint, sellerActionsFor, type SellerAction } from '@/lib/sellerOrders';
import type { DemoSession, OrderStatus, ShippingDocumentType } from '@/lib/types';
import { cn } from '@/lib/utils';

const CANCEL_REASONS = ['Out of stock', 'Buyer asked to cancel', 'Other'];

function CancelDialog({ orderId, onClose, onConfirm }: { orderId: string; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState(CANCEL_REASONS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="font-sans sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel order</DialogTitle>
          <DialogDescription>
            Order <span className="font-mono">{orderId}</span> is cancelled and its stock released.
          </DialogDescription>
        </DialogHeader>
        <span id="seller-cancel-reason" className="text-sm font-semibold">
          Reason
        </span>
        <RadioGroup value={reason} onValueChange={setReason} aria-labelledby="seller-cancel-reason" className="gap-2">
          {CANCEL_REASONS.map((r) => (
            <Label key={r} className="flex cursor-pointer items-center gap-2.5 font-normal">
              <RadioGroupItem value={r} />
              {r}
            </Label>
          ))}
        </RadioGroup>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep order
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(undefined);
              try {
                await onConfirm(reason);
              } catch (e) {
                setError((e as Error).message);
                setBusy(false);
              }
            }}
          >
            Cancel order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Arrange shipment / Print label / Simulate carrier / Cancel order for one order, by status. */
export function OrderActions({
  seller,
  orderId,
  status,
  hasTracking,
  onChanged,
  className,
}: {
  seller: DemoSession;
  orderId: string;
  status: OrderStatus;
  hasTracking: boolean;
  onChanged: () => void;
  className?: string;
}) {
  const [busy, setBusy] = useState<SellerAction | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [documentType, setDocumentType] = useState<ShippingDocumentType>('SHIPPING_LABEL');
  const actions = sellerActionsFor(status, hasTracking);

  const run = async (action: SellerAction, fn: () => Promise<unknown>, done: string) => {
    setBusy(action);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  /** Opens the tab synchronously (inside the click) so the browser does not block it, then points it at the PDF. */
  const printLabel = async () => {
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    setBusy('label');
    try {
      const doc = await getShippingLabel(seller, orderId, documentType);
      if (tab) tab.location.href = doc.url;
      else toast('Shipping document ready', { action: { label: 'Open PDF', onClick: () => window.open(doc.url, '_blank', 'noopener') } });
    } catch (e) {
      tab?.close();
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!actions.length) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {actions.includes('arrange') ? (
        <Button size="sm" disabled={busy !== null} onClick={() => run('arrange', () => arrangeShipment(seller, orderId), 'Shipment arranged')}>
          Arrange shipment
        </Button>
      ) : null}
      {actions.includes('label') ? (
        <div className="seller-document-actions"><NativeSelect aria-label={`Document type for ${orderId}`} value={documentType} disabled={busy !== null} onChange={(e) => setDocumentType(e.target.value as ShippingDocumentType)}><option value="SHIPPING_LABEL">Shipping label</option><option value="PACKING_SLIP">Packing slip</option><option value="SHIPPING_LABEL_AND_PACKING_SLIP">Label & packing slip</option></NativeSelect><Button size="sm" variant="outline" disabled={busy !== null} onClick={printLabel}>{documentType === 'SHIPPING_LABEL' ? 'Print label' : documentType === 'PACKING_SLIP' ? 'Print packing slip' : 'Print documents'}</Button></div>
      ) : null}
      {actions.includes('advance') ? (
        <Button size="sm" variant="outline" title={advanceHint(status)} disabled={busy !== null} onClick={() => run('advance', () => advanceShipment(seller, orderId), advanceHint(status))}>
          Simulate carrier
        </Button>
      ) : null}
      {actions.includes('cancel') ? (
        <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" disabled={busy !== null} onClick={() => setCancelling(true)}>
          Cancel order
        </Button>
      ) : null}
      {cancelling ? (
        <CancelDialog
          orderId={orderId}
          onClose={() => setCancelling(false)}
          onConfirm={async (reason) => {
            await cancelOrder(seller, orderId, reason);
            toast.success('Order cancelled');
            setCancelling(false);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}
