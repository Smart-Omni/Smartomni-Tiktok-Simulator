import { useState } from 'react';
import { PackageCheck, RotateCcw, Scale, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cancelReturnRequest, disputeReturnRequest, shipReturnRequest } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import type { Aftersale, DemoSession } from '@/lib/types';

type ReturnAction = 'cancel' | 'ship-back' | 'dispute';
const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');

/** Mirrors buyerCancelReturn, buyerShipBack and arbitrate in the existing backend. */
export function buyerReturnActions(request: Aftersale): ReturnAction[] {
  if (request.kind !== 'RETURN') return [];
  const actions: ReturnAction[] = [];
  if (['RETURN_OR_REFUND_REQUEST_PENDING', 'AWAITING_BUYER_SHIP', 'AWAITING_BUYER_RESPONSE'].includes(request.status)) actions.push('cancel');
  if (request.status === 'AWAITING_BUYER_SHIP') actions.push('ship-back');
  if (request.arbitrationStatus === 'NO_ARBITRATION') actions.push('dispute');
  return actions;
}

const ACTIONS = {
  cancel: { title: 'Cancel return request?', button: 'Cancel return request', description: 'Withdraw this return request. This does not cancel the order.', success: 'Return request cancelled', icon: RotateCcw, run: cancelReturnRequest },
  'ship-back': { title: 'Confirm return shipment?', button: 'Confirm shipment', description: 'Confirm that you have handed the return parcel to the carrier.', success: 'Return shipment confirmed', icon: Truck, run: shipReturnRequest },
  dispute: { title: 'Open a dispute?', button: 'Open dispute', description: 'Ask for an arbitration review of this return request.', success: 'Dispute opened for review', icon: Scale, run: disputeReturnRequest },
};

export function BuyerAftersaleRequests({ session, requests, onChanged }: { session: DemoSession; requests: Aftersale[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<{ request: Aftersale; action: ReturnAction }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const returns = requests.filter((r) => r.kind === 'RETURN').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!returns.length) return null;
  const action = selected && ACTIONS[selected.action];
  return <section className="buyer-aftersale" aria-label="Return requests">
    <div className="buyer-aftersale-heading"><PackageCheck size={16} /><h3>Returns & refunds</h3><span>{returns.length}</span></div>
    {returns.map((request) => <div className="buyer-return-request" key={request.id} role="group" aria-label={`Return ${request.id}`}>
      <div className="buyer-return-topline"><span>{label(request.type)}</span><span className="buyer-return-status">{label(request.status)}</span></div>
      <div className="buyer-return-meta"><span className="font-mono">#{request.id}</span><span>Requested {new Date(request.createdAt).toLocaleDateString()}</span><strong>{shopPrice(request.refund.totalVnd)}</strong></div>
      <p className="buyer-return-items">{request.items.map((item) => `${item.quantity} × ${item.productName} (${item.skuName})`).join(' · ')}</p>
      <p className="buyer-return-reason">Reason: {label(request.reason)}{request.rejectReason ? ` · Seller response: ${label(request.rejectReason)}` : ''}</p>
      {request.returnTrackingNumber && <div className="buyer-return-tracking"><Truck size={14} />Return tracking <strong>{request.returnTrackingNumber}</strong></div>}
      {request.arbitrationStatus && request.arbitrationStatus !== 'NO_ARBITRATION' && <div className="buyer-return-arbitration" role="status"><Scale size={14} /><span>{request.arbitrationStatus === 'IN_ARBITRATION' ? 'Dispute under review' : label(request.arbitrationStatus)}</span></div>}
      <div className="buyer-return-actions">{buyerReturnActions(request).map((key) => {
        const item = ACTIONS[key];
        return <Button key={key} variant="outline" size="sm" onClick={() => { setError(undefined); setSelected({ request, action: key }); }}><item.icon size={14} />{key === 'ship-back' ? 'I shipped the return' : item.button}</Button>;
      })}</div>
    </div>)}
    {selected && action && <Dialog open onOpenChange={(open) => { if (!open && !busy) setSelected(undefined); }}><DialogContent className="font-sans sm:max-w-md"><DialogHeader><DialogTitle>{action.title}</DialogTitle><DialogDescription>{action.description}</DialogDescription></DialogHeader>
      <div className="buyer-return-confirm"><span>Return request</span><strong>{selected.request.id}</strong><span>{label(selected.request.type)} · {shopPrice(selected.request.refund.totalVnd)}</span></div>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setSelected(undefined)}>Go back</Button><Button className="!bg-[#171717] !text-white hover:!bg-[#333]" disabled={busy} onClick={async () => {
        if (busy) return;
        setBusy(true); setError(undefined);
        try {
          await action.run(session, selected.request.id);
          toast.success(action.success);
          setSelected(undefined);
          onChanged();
        } catch (e) { setError((e as Error).message); }
        finally { setBusy(false); }
      }}>{busy ? 'Submitting…' : action.button}</Button></DialogFooter>
    </DialogContent></Dialog>}
  </section>;
}
