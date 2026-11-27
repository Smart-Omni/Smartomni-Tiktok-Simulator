import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { AsyncState } from '@/components/AsyncState';
import { TestToolsSheet } from '@/components/seller/TestTools';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useAsync } from '@/lib/useAsync';
import { ArbitrationPanel } from '@/pages/console/ArbitrationPanel';
import { completeAftersale, getAftersaleRecords } from '@/pages/console/adminEndpoints';

/** Status history of one aftersale request, with actor (GET /test-admin/aftersale/:ref/records). */
export function AftersaleRecordsPanel({ shopId, requestId }: { shopId: string; requestId: string }) {
  const records = useAsync(() => getAftersaleRecords(shopId, requestId), [shopId, requestId]);
  return (
    <section className="admin-surface" aria-label="Aftersale records">
      <div className="admin-section-title"><h2>History · {requestId}</h2></div>
      <AsyncState {...records} onRetry={records.reload} isEmpty={(d) => d.records.length === 0} emptyText="No status history recorded.">
        {(d) => <ol className="admin-timeline">{d.records.map((h, i) => <li key={i}><strong>{h.from ?? 'Created'} → {h.to}</strong><span>{h.actor} · {new Date(h.at).toLocaleString()}</span>{h.note && <p>{h.note}</p>}</li>)}</ol>}
      </AsyncState>
    </section>
  );
}

/**
 * TEST actions on one return/cancellation: its records, arbitration (returns only) and "refund paid out" (SUCCESS -> COMPLETE),
 * which TikTok does on its side and a seller cannot do.
 */
export function AftersaleTestActions({ shopId, request, onChanged }: { shopId: string; request: { id: string; kind: string; status: string }; onChanged: () => void }) {
  const [sheet, setSheet] = useState<'Records' | 'Arbitration'>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const canComplete = request.status.endsWith('REQUEST_SUCCESS');
  const complete = async () => {
    setBusy(true);
    try {
      await completeAftersale(shopId, request.id);
      toast.success(`${request.id}: refund completed`);
      setConfirming(false);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tabs = [
    { label: 'Records', scope: 'shop' as const, render: () => <AftersaleRecordsPanel shopId={shopId} requestId={request.id} /> },
    ...(request.kind === 'RETURN' ? [{ label: 'Arbitration', scope: 'shop' as const, render: () => <ArbitrationPanel shopId={shopId} initialRef={request.id} /> }] : []),
  ];
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="outline" className="seller-test-button" aria-label={`Test actions for ${request.id}`}>
            <FlaskConical aria-hidden="true" />Test actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="theme-seller min-w-48">
          <DropdownMenuLabel className="text-xs">TEST · simulator only</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => setSheet('Records')}>View records</DropdownMenuItem>
          {request.kind === 'RETURN' && <DropdownMenuItem onSelect={() => setSheet('Arbitration')}>Arbitrate dispute</DropdownMenuItem>}
          {canComplete && <DropdownMenuItem onSelect={() => setConfirming(true)}>Complete refund</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      {sheet && <TestToolsSheet open title={`Request ${request.id}`} description="Simulator records and operator decisions for this request." tabs={tabs} initialTab={sheet} onOpenChange={(o) => { if (!o) { setSheet(undefined); onChanged(); } }} />}
      <Dialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <DialogContent className="theme-seller font-sans sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Complete refund?</DialogTitle>
            <DialogDescription>Marks the refund of {request.id} as paid out. The request becomes final and cannot change again.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void complete()}>Complete refund</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
