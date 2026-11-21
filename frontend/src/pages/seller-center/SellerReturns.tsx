import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { humanize, Loaded, NativeSelect, SellerCard } from '@/components/seller/SellerUi';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { approveAftersale, listAftersale, rejectAftersale } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import { OPEN_AFTERSALE } from '@/lib/sellerOrders';
import type { Aftersale, DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';

/** Same kind labels as the former /seller Returns tab. */
const kindLabel = (r: Aftersale) => (r.kind === 'RETURN' ? (r.type === 'RETURN_AND_REFUND' ? 'Return and refund' : 'Refund only') : r.type === 'CANCEL' ? 'Cancel (seller/system)' : 'Buyer cancellation');

function Returns({ seller }: { seller: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('status') === 'all' ? 'all' : 'open';
  const list = useAsync(() => listAftersale(seller), [seller.sessionToken, seller.shopId], 5000);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (r: Aftersale, action: 'approve' | 'reject') => {
    setBusy(r.id);
    try {
      if (action === 'approve') await approveAftersale(seller, r.id);
      else await rejectAftersale(seller, r.id, reasons[r.id] ?? list.data?.rejectReasons[0]?.name ?? 'OTHER');
      toast.success(action === 'approve' ? 'Request approved' : 'Request rejected');
      list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const all = list.data?.items ?? [];
  const open = all.filter((r) => OPEN_AFTERSALE.includes(r.status));
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Returns & refunds</h1>
      <p className="text-sm text-muted-foreground">Review customer requests, manage return decisions and keep track of refunds.</p>
      <SellerCard>
        <Tabs value={tab} onValueChange={(v) => setParams(v === 'open' ? { status: 'open' } : { status: 'all' }, { replace: true })}>
          <TabsList variant="line" className="h-12 w-full justify-start gap-2 overflow-x-auto overflow-y-hidden rounded-none border-b border-line-soft px-4 [scrollbar-width:none]">
            <TabsTrigger value="open" className="flex-none px-3 after:bg-teal data-[state=active]:font-semibold data-[state=active]:text-teal">
              Open ({open.length})
            </TabsTrigger>
            <TabsTrigger value="all" className="flex-none px-3 after:bg-teal data-[state=active]:font-semibold data-[state=active]:text-teal">
              All ({all.length})
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Loaded result={list} what="requests">
          {(d) => {
            const rows = tab === 'open' ? open : d.items;
            if (!rows.length) return <p className="py-12 text-center text-sm text-muted-foreground">{tab === 'open' ? 'No requests waiting for you.' : 'No cancellation or return requests.'}</p>;
            return (
              <Table className="seller-returns-table">
                <TableHeader>
                  <TableRow className="bg-surface-2 hover:bg-surface-2">
                    <TableHead className="pl-4">Request</TableHead>
                    <TableHead>Buyer</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Refund</TableHead>
                    <TableHead>Decision</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id} aria-label={`Request ${r.id}`} className="align-top">
                      <TableCell className="py-3 pl-4">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono text-xs">{r.id}</span>
                          <Link to={`/seller-center/orders/${encodeURIComponent(r.orderId)}`} className="font-mono text-xs text-teal hover:underline">
                            Order {r.orderId}
                          </Link>
                        </div>
                      </TableCell>
                      <TableCell className="py-3">{r.buyer.name}</TableCell>
                      <TableCell className="py-3">{kindLabel(r)}</TableCell>
                      <TableCell className="max-w-[220px] whitespace-normal py-3 text-xs">{r.items.map((i) => `${i.quantity}× ${i.productName} (${i.skuName})`).join(', ')}</TableCell>
                      <TableCell className="py-3 text-xs">{humanize(r.reason)}</TableCell>
                      <TableCell className="py-3">
                        <span className="seller-status" data-seller-status={r.status}>{humanize(r.status)}</span>
                        {r.rejectReason ? <div className="mt-1 text-xs text-muted-foreground">Rejected: {humanize(r.rejectReason)}</div> : null}
                        {r.returnTrackingNumber ? <div className="mt-1 font-mono text-xs text-muted-foreground">Return {r.returnTrackingNumber}</div> : null}
                      </TableCell>
                      <TableCell className="py-3 text-right font-semibold">{shopPrice(r.refund.totalVnd)}</TableCell>
                      <TableCell className="py-3">
                        {OPEN_AFTERSALE.includes(r.status) ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" disabled={busy === r.id} onClick={() => act(r, 'approve')}>
                              {r.status === 'BUYER_SHIPPED_ITEM' ? 'Accept package' : 'Approve'}
                            </Button>
                            <NativeSelect
                              aria-label={`Reject reason for ${r.id}`}
                              value={reasons[r.id] ?? d.rejectReasons[0]?.name}
                              onChange={(e) => setReasons({ ...reasons, [r.id]: e.target.value })}
                            >
                              {d.rejectReasons.map((x) => (
                                <option key={x.name} value={x.name}>
                                  {x.text}
                                </option>
                              ))}
                            </NativeSelect>
                            <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => act(r, 'reject')}>
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-2">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            );
          }}
        </Loaded>
      </SellerCard>
    </div>
  );
}

export function SellerReturns() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Returns key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
