import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Copy, Download, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { humanize, Loaded, NativeSelect, SellerCard } from '@/components/seller/SellerUi';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { createCoupon, createCouponBatch, deactivateCouponBatch, getCoupons, getCouponBatch, listCouponBatches, patchCoupon } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import type { CouponBatchCode, DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

/** Form rules and request body from the former /seller Coupons tab. */
const isWhole = (v: string): boolean => /^\d+$/.test(v) && Number(v) >= 1;
export const emptyVoucher = { title: '', promoCode: '', kind: 'AMOUNT_OFF', value: '', cap: '', minSpend: '', days: '7', limit: '', audience: 'ALL' };
export type VoucherForm = typeof emptyVoucher;

const discountOk = (f: { kind: string; value: string; cap: string }) => isWhole(f.value) && (f.kind === 'AMOUNT_OFF' || Number(f.value) <= 100) && (f.cap === '' || isWhole(f.cap));
const discountOf = (f: { kind: string; value: string; cap: string }) =>
  f.kind === 'AMOUNT_OFF' ? { type: 'AMOUNT_OFF', amountVnd: Number(f.value) } : { type: 'PERCENT_OFF', percentage: Number(f.value), ...(f.cap ? { maxDiscountVnd: Number(f.cap) } : {}) };

/** An empty code is allowed: the backend then generates a 10-character code. */
export function voucherValid(f: VoucherForm): boolean {
  return (
    f.title.trim() !== '' &&
    (f.promoCode === '' || /^[A-Za-z0-9]{6,12}$/.test(f.promoCode)) &&
    discountOk(f) &&
    isWhole(f.days) &&
    (f.minSpend === '' || isWhole(f.minSpend)) &&
    (f.limit === '' || isWhole(f.limit))
  );
}

export function voucherBody(f: VoucherForm, now = Date.now()) {
  const endAt = new Date(now + Number(f.days) * 86_400_000).toISOString();
  return {
    title: f.title,
    ...(f.promoCode ? { promoCode: f.promoCode } : {}),
    discount: discountOf(f),
    endAt,
    audience: f.audience,
    ...(f.minSpend ? { minSpendVnd: Number(f.minSpend) } : {}),
    ...(f.limit ? { redemptionLimit: Number(f.limit) } : {}),
  };
}

export const MAX_BATCH_QUANTITY = 500;
export const emptyBatch = { title: '', kind: 'PERCENT_OFF', value: '', cap: '', minSpend: '', days: '30', quantity: '10', audience: 'ALL' };
export type BatchForm = typeof emptyBatch;

export function batchValid(f: BatchForm): boolean {
  return f.title.trim() !== '' && discountOk(f) && isWhole(f.days) && (f.minSpend === '' || isWhole(f.minSpend)) && isWhole(f.quantity) && Number(f.quantity) <= MAX_BATCH_QUANTITY;
}

/** No promoCode and no redemptionLimit: every code is generated and single-use. */
export function batchBody(f: BatchForm, now = Date.now()) {
  return {
    title: f.title,
    discount: discountOf(f),
    endAt: new Date(now + Number(f.days) * 86_400_000).toISOString(),
    audience: f.audience,
    quantity: Number(f.quantity),
    ...(f.minSpend ? { minSpendVnd: Number(f.minSpend) } : {}),
  };
}

const csvCell = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function batchCsv(codes: CouponBatchCode[]): string {
  return ['promo_code,coupon_id,redeemed_count,status', ...codes.map((c) => [c.promoCode, c.id, c.redeemedCount, c.status].map(csvCell).join(','))].join('\n') + '\n';
}

const tone = (s: string) => (s === 'ONGOING' ? 'bg-teal-soft text-teal' : s === 'DEACTIVATED' || s === 'EXPIRED' ? 'bg-buyer-soft text-buyer-ink' : 'bg-[#FFF4E0] text-[#9A5B00]');
const StatusPill = ({ status }: { status: string }) => <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-semibold', tone(status))}>{humanize(status)}</span>;
const day = (iso: string) => new Date(iso).toLocaleDateString();

/** Form dialog shell shared by New voucher and New code batch: submit errors from the API show inside the dialog. */
function FormDialog({ title, description, submit, canSubmit, onClose, onSubmit, children }: { title: string; description: string; submit: string; canSubmit: boolean; onClose: () => void; onSubmit: () => Promise<void>; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="theme-seller font-sans sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(undefined);
            try {
              await onSubmit();
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          {children}
          {error ? (
            <Alert variant="destructive" className="sm:col-span-2">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || busy}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Text inputs and selects bound to one form object. */
function useFormFields<F extends Record<string, string>>(prefix: string, initial: F) {
  const [f, setF] = useState(initial);
  const text = (key: keyof F & string, label: string, extra: { placeholder?: string; numeric?: boolean; maxLength?: number; upper?: boolean; hint?: string } = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
      <Input
        id={`${prefix}-${key}`}
        value={f[key]}
        placeholder={extra.placeholder}
        maxLength={extra.maxLength}
        inputMode={extra.numeric ? 'numeric' : undefined}
        onChange={(e) => setF({ ...f, [key]: extra.upper ? e.target.value.toUpperCase() : e.target.value })}
      />
      {extra.hint ? <span className="text-xs text-muted-foreground">{extra.hint}</span> : null}
    </div>
  );
  const select = (key: keyof F & string, label: string, options: [string, string][]) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
      <NativeSelect id={`${prefix}-${key}`} className="h-9" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
  return { f, text, select };
}

const KIND_OPTIONS: [string, string][] = [
  ['AMOUNT_OFF', 'Amount off (VND)'],
  ['PERCENT_OFF', 'Percent off'],
];
const AUDIENCE_OPTIONS: [string, string][] = [
  ['ALL', 'All buyers'],
  ['NEW', 'New buyers only'],
];

function NewVoucherDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (f: VoucherForm) => Promise<void> }) {
  const { f, text, select } = useFormFields('voucher', emptyVoucher);
  return (
    <FormDialog title="New voucher" description="Validity starts now on the business clock. Code and discount cannot be changed afterwards." submit="Create voucher" canSubmit={voucherValid(f)} onClose={onClose} onSubmit={() => onCreate(f)}>
      {text('title', 'Title')}
      {text('promoCode', 'Code', { placeholder: '6-12 letters/digits', maxLength: 12, upper: true, hint: 'Leave empty to generate a 10-character code' })}
      {select('kind', 'Discount type', KIND_OPTIONS)}
      {text('value', f.kind === 'AMOUNT_OFF' ? 'Amount off (VND)' : 'Percent off (1-100)', { numeric: true })}
      {f.kind === 'PERCENT_OFF' ? text('cap', 'Maximum discount VND (optional)', { numeric: true }) : null}
      {text('minSpend', 'Minimum spend VND (optional)', { numeric: true })}
      {text('days', 'Valid days', { numeric: true })}
      {text('limit', 'Redemption limit (optional)', { numeric: true })}
      {select('audience', 'Audience', AUDIENCE_OPTIONS)}
    </FormDialog>
  );
}

function NewBatchDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (f: BatchForm) => Promise<void> }) {
  const { f, text, select } = useFormFields('batch', emptyBatch);
  return (
    <FormDialog
      title="New code batch"
      description="Each code can be used once. Codes are private: buyers must type them. Validity starts now on the business clock."
      submit="Create batch"
      canSubmit={batchValid(f)}
      onClose={onClose}
      onSubmit={() => onCreate(f)}
    >
      {text('title', 'Title', { placeholder: 'Loyalty Diamond 30%' })}
      {text('quantity', `Quantity (1-${MAX_BATCH_QUANTITY})`, { numeric: true })}
      {select('kind', 'Discount type', KIND_OPTIONS)}
      {text('value', f.kind === 'AMOUNT_OFF' ? 'Amount off (VND)' : 'Percent off (1-100)', { numeric: true })}
      {f.kind === 'PERCENT_OFF' ? text('cap', 'Maximum discount VND (optional)', { numeric: true }) : null}
      {text('minSpend', 'Minimum spend VND (optional)', { numeric: true })}
      {text('days', 'Valid for (days)', { numeric: true })}
      {select('audience', 'Audience', AUDIENCE_OPTIONS)}
    </FormDialog>
  );
}

function CodesDialog({ seller, batchId, onClose }: { seller: DemoSession; batchId: string; onClose: () => void }) {
  const detail = useAsync(() => getCouponBatch(seller, batchId), [seller.sessionToken, seller.shopId, batchId]);
  const copyAll = async (codes: CouponBatchCode[]) => {
    try {
      await navigator.clipboard.writeText(codes.map((c) => c.promoCode).join('\n'));
      toast.success(`${codes.length} codes copied`);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };
  const download = (title: string, codes: CouponBatchCode[]) => {
    const url = URL.createObjectURL(new Blob([batchCsv(codes)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'codes'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="theme-seller font-sans sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Codes{detail.data ? ` of ${detail.data.batch.title}` : ''}</DialogTitle>
          <DialogDescription>Each code can be used once. Codes are private: buyers must type them.</DialogDescription>
        </DialogHeader>
        <Loaded result={detail} what="codes">
          {(d) => (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {d.batch.redeemed} / {d.batch.quantity} used
                </span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => copyAll(d.codes)}>
                  <Copy /> Copy all
                </Button>
                <Button size="sm" variant="outline" onClick={() => download(d.batch.title, d.codes)}>
                  <Download /> Download CSV
                </Button>
              </div>
              <div className="max-h-96 overflow-y-auto rounded-lg ring-1 ring-line-soft">
                <Table aria-label="Codes">
                  <TableHeader>
                    <TableRow className="bg-surface-2 hover:bg-surface-2">
                      <TableHead className="pl-4">Code</TableHead>
                      <TableHead>Used</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.codes.map((c) => (
                      <TableRow key={c.id} aria-label={`Code ${c.promoCode}`}>
                        <TableCell className="pl-4 font-mono font-semibold">{c.promoCode}</TableCell>
                        <TableCell>{c.redeemedCount}</TableCell>
                        <TableCell>
                          <StatusPill status={c.status} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </Loaded>
      </DialogContent>
    </Dialog>
  );
}

function SingleVouchers({ seller }: { seller: DemoSession }) {
  const list = useAsync(() => getCoupons(seller), [seller.sessionToken, seller.shopId], 10000);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (id: string, deactivated: boolean) => {
    setBusy(id);
    try {
      await patchCoupon(seller, id, { deactivated });
      toast.success(deactivated ? 'Voucher deactivated' : 'Voucher reactivated');
      list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">Vouchers are seller-created demo data. Buyers type the code at checkout; the backend prices the discount.</p>
        <Button className="ml-auto" onClick={() => setCreating(true)}>
          <Plus /> New voucher
        </Button>
      </div>
      <SellerCard>
        <Loaded result={list} what="vouchers">
          {(d) =>
            d.items.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No vouchers yet. Create one with New voucher.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-surface-2 hover:bg-surface-2">
                    <TableHead className="pl-4">Code</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Min spend</TableHead>
                    <TableHead>Used</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.items.map((c) => (
                    <TableRow key={c.id} aria-label={`Voucher ${c.promoCode ?? c.id}`}>
                      <TableCell className="pl-4 font-mono font-semibold">{c.promoCode ?? '—'}</TableCell>
                      <TableCell>
                        {c.title}
                        {c.audience === 'NEW' ? <span className="ml-2 rounded-full bg-surface px-2 py-0.5 text-xs">New buyers</span> : null}
                      </TableCell>
                      <TableCell>{c.discountText}</TableCell>
                      <TableCell>{c.minSpendVnd != null ? shopPrice(c.minSpendVnd) : '—'}</TableCell>
                      <TableCell>
                        {c.redeemedCount}
                        {c.redemptionLimit != null ? ` / ${c.redemptionLimit}` : ''}
                      </TableCell>
                      <TableCell>
                        <StatusPill status={c.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" disabled={busy === c.id} onClick={() => toggle(c.id, c.status !== 'DEACTIVATED')}>
                          {c.status === 'DEACTIVATED' ? 'Reactivate' : 'Deactivate'}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </Loaded>
      </SellerCard>

      {creating ? (
        <NewVoucherDialog
          onClose={() => setCreating(false)}
          onCreate={async (f) => {
            await createCoupon(seller, voucherBody(f));
            toast.success('Voucher created');
            setCreating(false);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function CodeBatches({ seller }: { seller: DemoSession }) {
  const list = useAsync(() => listCouponBatches(seller), [seller.sessionToken, seller.shopId], 10000);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const deactivate = async (batchId: string) => {
    setBusy(batchId);
    try {
      await deactivateCouponBatch(seller, batchId);
      toast.success('Batch deactivated');
      list.reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">Batches of single-use codes for SmartOmni loyalty vouchers. Codes are hidden from buyers; SmartOmni pulls them with Search Coupon List.</p>
        <Button className="ml-auto" onClick={() => setCreating(true)}>
          <Plus /> New code batch
        </Button>
      </div>
      <SellerCard>
        <Loaded result={list} what="code batches">
          {(d) =>
            d.items.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No code batches yet. Create one with New code batch.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-surface-2 hover:bg-surface-2">
                    <TableHead className="pl-4">Title</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Used</TableHead>
                    <TableHead>Valid until</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.items.map((b) => (
                    <TableRow key={b.id} aria-label={`Batch ${b.title}`}>
                      <TableCell className="pl-4 font-semibold">{b.title}</TableCell>
                      <TableCell>{b.discountText}</TableCell>
                      <TableCell>
                        <StatusPill status={b.status} />
                      </TableCell>
                      <TableCell>
                        {b.redeemed} / {b.quantity}
                      </TableCell>
                      <TableCell>{day(b.endAt)}</TableCell>
                      <TableCell>{day(b.createdAt)}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button size="sm" variant="outline" onClick={() => setViewing(b.id)}>
                          View codes
                        </Button>
                        <Button size="sm" variant="outline" className="ml-2" disabled={busy === b.id || b.status === 'DEACTIVATED'} onClick={() => deactivate(b.id)}>
                          Deactivate
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </Loaded>
      </SellerCard>

      {creating ? (
        <NewBatchDialog
          onClose={() => setCreating(false)}
          onCreate={async (f) => {
            const created = await createCouponBatch(seller, batchBody(f));
            toast.success(`${created.codes.length} codes created`);
            setCreating(false);
            setViewing(created.batch.id);
            list.reload();
          }}
        />
      ) : null}
      {viewing ? (
        <CodesDialog
          seller={seller}
          batchId={viewing}
          onClose={() => {
            setViewing(null);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function Vouchers({ seller }: { seller: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'batches' ? 'batches' : 'vouchers';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Vouchers</h1>
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'batches' ? { tab: 'batches' } : {}, { replace: true })}>
        <TabsList variant="line" className="h-11 justify-start gap-2 border-b border-line-soft">
          <TabsTrigger value="vouchers" className="flex-none px-3 after:bg-teal data-[state=active]:font-semibold data-[state=active]:text-teal">
            Vouchers
          </TabsTrigger>
          <TabsTrigger value="batches" className="flex-none px-3 after:bg-teal data-[state=active]:font-semibold data-[state=active]:text-teal">
            Code batches
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'batches' ? <CodeBatches seller={seller} /> : <SingleVouchers seller={seller} />}
    </div>
  );
}

export function SellerVouchers() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Vouchers key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
