import { useState } from 'react';
import { ArrowDownLeft, ChevronDown, PackageCheck, RotateCcw, Scale, Truck } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cancelReturnRequest, disputeReturnRequest, shipReturnRequest } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import type { Aftersale, DemoSession } from '@/lib/types';

type ReturnAction = 'cancel' | 'ship-back' | 'dispute';
const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ');
const RETURN_STATUS: Record<string, { label: string; tone: string }> = {
  RETURN_OR_REFUND_REQUEST_PENDING: { label: 'Awaiting seller review', tone: 'pending' },
  AWAITING_BUYER_RESPONSE: { label: 'Your response needed', tone: 'pending' },
  REFUND_OR_RETURN_REQUEST_REJECT: { label: 'Request declined', tone: 'declined' },
  AWAITING_BUYER_SHIP: { label: 'Ready to ship back', tone: 'pending' },
  BUYER_SHIPPED_ITEM: { label: 'Return in transit', tone: 'info' },
  REJECT_RECEIVE_PACKAGE: { label: 'Return parcel declined', tone: 'declined' },
  RETURN_OR_REFUND_REQUEST_SUCCESS: { label: 'Return approved', tone: 'success' },
  RETURN_OR_REFUND_REQUEST_CANCEL: { label: 'Request cancelled', tone: 'neutral' },
  RETURN_OR_REFUND_REQUEST_COMPLETE: { label: 'Return completed', tone: 'success' },
};

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
      <div className="buyer-return-summary"><span className="buyer-return-summary-icon"><ArrowDownLeft size={18} /></span><div><strong>{label(request.type)}</strong><span>Requested {new Date(request.createdAt).toLocaleDateString()}</span></div><div className="buyer-return-refund"><small>Requested amount</small><strong>{shopPrice(request.refund.totalVnd)}</strong></div></div>
      <div className="buyer-return-state-row"><span className="buyer-return-status" data-tone={RETURN_STATUS[request.status]?.tone ?? 'neutral'}><span />{RETURN_STATUS[request.status]?.label ?? label(request.status)}</span>
      {request.arbitrationStatus && request.arbitrationStatus !== 'NO_ARBITRATION' && <span className="buyer-return-arbitration" data-status={request.arbitrationStatus} role="status"><Scale size={13} /><span>{request.arbitrationStatus === 'IN_ARBITRATION' ? 'Dispute under review' : label(request.arbitrationStatus)}</span></span>}
      </div>
      {request.sellerProposedReturnType && <p className="text-xs text-muted-foreground">Seller proposal: {request.sellerProposedReturnType === 'REFUND' ? 'Refund only' : label(request.sellerProposedReturnType)}</p>}
      {request.returnTrackingNumber && <div className="buyer-return-tracking"><Truck size={14} />Return tracking <strong>{request.returnTrackingNumber}</strong></div>}
      <details className="buyer-return-details"><summary>Request details<ChevronDown size={13} /></summary><div><dl><div><dt>Request ID</dt><dd className="font-mono">{request.id}</dd></div><div><dt>Reason</dt><dd>{label(request.reason)}</dd></div>{request.rejectReason && <div><dt>Seller response</dt><dd>{label(request.rejectReason)}</dd></div>}</dl><ul>{request.items.map((item) => <li key={item.skuId}><span>{item.quantity} × {item.productName}</span><small>{item.skuName}</small></li>)}</ul></div></details>
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
