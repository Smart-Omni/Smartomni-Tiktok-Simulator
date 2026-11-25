import { useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Copy, Download, Pencil, Plus } from 'lucide-react';
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
import { createCoupon, createCouponBatch, deactivateCouponBatch, getBusinessClock, getCoupons, getCouponBatch, listCouponBatches, patchCoupon } from '@/lib/endpoints';
import { shopPrice } from '@/lib/format';
import type { Coupon, CouponBatchCode, DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

/** Form rules and request body from the former /seller Coupons tab. */
const DAY_MS = 86_400_000;
const wholeInRange = (v: string, max: number) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) && Number(v) >= 1 && Number(v) <= max;
export const emptyVoucher = { title: '', promoCode: '', kind: 'AMOUNT_OFF', value: '', cap: '', minSpend: '', days: '7', limit: '', audience: 'ALL' };
export type VoucherForm = typeof emptyVoucher;

function fieldError(f: Record<string, string>, key: string): string | undefined {
  const value = f[key];
  if (key === 'title') return value.trim().length >= 1 && value.trim().length <= 100 ? undefined : 'Enter a title of 1–100 characters.';
  if (key === 'promoCode') return value.trim() === '' || /^[A-Za-z0-9]{6,12}$/.test(value.trim()) ? undefined : 'Use 6–12 letters or digits, or leave empty.';
  if (key === 'startAt') return value === '' || Number.isFinite(Date.parse(value)) ? undefined : 'Choose a valid start time.';
  if (['cap', 'minSpend', 'limit'].includes(key) && value === '') return undefined;
  const max = key === 'quantity' ? 500 : key === 'limit' ? 1_000_000 : key === 'days' ? 99_999_999 : key === 'value' && f.kind === 'PERCENT_OFF' ? 100 : 2_000_000_000;
  if (['quantity', 'limit', 'days', 'value', 'cap', 'minSpend'].includes(key)) {
    if (key === 'cap' && f.kind !== 'PERCENT_OFF') return undefined;
    return wholeInRange(value, max) ? undefined : `Enter a whole number from 1 to ${max.toLocaleString('en-US')}.`;
  }
  return undefined;
}
const formValid = (f: Record<string, string>) => Object.keys(f).every((key) => !fieldError(f, key));
function expiresAt(days: string, businessNow: number): string {
  const end = businessNow + Number(days) * DAY_MS;
  if (!Number.isFinite(businessNow) || !Number.isFinite(new Date(end).getTime())) throw new Error('Cannot calculate expiry from the business clock and valid days.');
  return new Date(end).toISOString();
}
const discountOf = (f: { kind: string; value: string; cap: string }) =>
  f.kind === 'AMOUNT_OFF' ? { type: 'AMOUNT_OFF', amountVnd: Number(f.value) } : { type: 'PERCENT_OFF', percentage: Number(f.value), ...(f.cap ? { maxDiscountVnd: Number(f.cap) } : {}) };

/** An empty code is allowed: the backend then generates a 10-character code. */
export function voucherValid(f: VoucherForm): boolean {
  return formValid(f);
}

export function voucherBody(f: VoucherForm, businessNow: number) {
  const endAt = expiresAt(f.days, businessNow);
  return {
    title: f.title.trim(),
    ...(f.promoCode.trim() ? { promoCode: f.promoCode.trim() } : {}),
    discount: discountOf(f),
    endAt,
    audience: f.audience,
    ...(f.minSpend ? { minSpendVnd: Number(f.minSpend) } : {}),
    ...(f.limit ? { redemptionLimit: Number(f.limit) } : {}),
  };
}

export const MAX_BATCH_QUANTITY = 500;
export const emptyBatch = { title: '', kind: 'PERCENT_OFF', value: '', cap: '', minSpend: '', days: '30', quantity: '10', audience: 'ALL', startAt: '' };
export type BatchForm = typeof emptyBatch;

export function batchValid(f: BatchForm): boolean {
  return formValid(f);
}

/** No promoCode and no redemptionLimit: every code is generated and single-use. */
export function batchBody(f: BatchForm, businessNow: number) {
  if (!Number.isFinite(businessNow)) throw new Error('Cannot read the business clock.');
  const start = f.startAt ? Date.parse(f.startAt) : businessNow;
  if (!Number.isFinite(start)) throw new Error('Choose a valid start time.');
  return {
    title: f.title.trim(),
    discount: discountOf(f),
    ...(f.startAt ? { startAt: new Date(start).toISOString() } : {}),
    endAt: expiresAt(f.days, start),
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
            if (!canSubmit || busy) return;
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
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const text = (key: keyof F & string, label: string, extra: { placeholder?: string; numeric?: boolean; maxLength?: number; upper?: boolean; hint?: string; type?: 'datetime-local' } = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${prefix}-${key}`}>{label}</Label>
      <Input
        id={`${prefix}-${key}`}
        value={f[key]}
        type={extra.type}
        step={extra.type === 'datetime-local' ? 1 : undefined}
        placeholder={extra.placeholder}
        maxLength={extra.maxLength}
        inputMode={extra.numeric ? 'numeric' : undefined}
        onBlur={() => setTouched((previous) => ({ ...previous, [key]: true }))}
        aria-invalid={touched[key] && !!fieldError(f, key)}
        aria-describedby={touched[key] && fieldError(f, key) ? `${prefix}-${key}-error` : undefined}
        onChange={(e) => setF({ ...f, [key]: extra.upper ? e.target.value.toUpperCase() : e.target.value })}
      />
      {touched[key] && fieldError(f, key) ? <span id={`${prefix}-${key}-error`} className="text-xs text-destructive" role="alert">{fieldError(f, key)}</span> : null}
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
      {text('title', 'Title', { maxLength: 100 })}
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
      description="Each code can be used once. Codes are private: buyers must type them. Valid days are counted from the start time."
      submit="Create batch"
      canSubmit={batchValid(f)}
      onClose={onClose}
      onSubmit={() => onCreate(f)}
    >
      {text('title', 'Title', { placeholder: 'Loyalty Diamond 30%', maxLength: 100 })}
      {text('quantity', `Quantity (1-${MAX_BATCH_QUANTITY})`, { numeric: true })}
      {select('kind', 'Discount type', KIND_OPTIONS)}
      {text('value', f.kind === 'AMOUNT_OFF' ? 'Amount off (VND)' : 'Percent off (1-100)', { numeric: true })}
      {f.kind === 'PERCENT_OFF' ? text('cap', 'Maximum discount VND (optional)', { numeric: true }) : null}
      {text('minSpend', 'Minimum spend VND (optional)', { numeric: true })}
      {text('startAt', 'Starts at (optional)', { type: 'datetime-local', hint: 'Local time. Leave empty to start at the current business time.' })}
      {text('days', 'Valid for (days)', { numeric: true })}
      {select('audience', 'Audience', AUDIENCE_OPTIONS)}
    </FormDialog>
  );
}

const localDateTime = (iso: string) => {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19) : '';
};
export interface VoucherEdit { title: string; startAt: string; endAt: string; limit: string; minSpend: string }
export function voucherEditError(f: VoucherEdit, redeemed: number): string | undefined {
  if (!f.title.trim() || f.title.trim().length > 100) return 'Title must contain 1–100 characters.';
  const start = Date.parse(f.startAt), end = Date.parse(f.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 'End time must be after start time.';
  if (f.limit !== '' && (!wholeInRange(f.limit, 1_000_000) || Number(f.limit) < redeemed)) return `Redemption limit must be between ${Math.max(1, redeemed)} and 1,000,000.`;
  if (f.minSpend !== '' && !wholeInRange(f.minSpend, 2_000_000_000)) return 'Minimum spend must be 1–2,000,000,000 VND, or empty.';
}
export const voucherEditBody = (f: VoucherEdit) => ({ title: f.title.trim(), startAt: new Date(f.startAt).toISOString(), endAt: new Date(f.endAt).toISOString(), redemptionLimit: f.limit === '' ? null : Number(f.limit), minSpendVnd: f.minSpend === '' ? null : Number(f.minSpend) });

function EditVoucherDialog({ coupon, onClose, onSave }: { coupon: Coupon; onClose: () => void; onSave: (body: ReturnType<typeof voucherEditBody>) => Promise<void> }) {
  const [f, setF] = useState<VoucherEdit>({ title: coupon.title, startAt: localDateTime(coupon.startAt), endAt: localDateTime(coupon.endAt), limit: coupon.redemptionLimit == null ? '' : String(coupon.redemptionLimit), minSpend: coupon.minSpendVnd == null ? '' : String(coupon.minSpendVnd) });
  const error = voucherEditError(f, coupon.redeemedCount);
  return <FormDialog title="Edit voucher" description={coupon.promoCode ?? coupon.id} submit="Save voucher" canSubmit={!error} onClose={onClose} onSubmit={() => onSave({ ...voucherEditBody(f), startAt: f.startAt === localDateTime(coupon.startAt) ? coupon.startAt : new Date(f.startAt).toISOString(), endAt: f.endAt === localDateTime(coupon.endAt) ? coupon.endAt : new Date(f.endAt).toISOString() })}>
    {([['title', 'Title', 'text'], ['startAt', 'Starts at', 'datetime-local'], ['endAt', 'Ends at', 'datetime-local'], ['limit', 'Redemption limit (optional)', 'text'], ['minSpend', 'Minimum spend VND (optional)', 'text']] as const).map(([key, label, type]) => <label key={key} className="flex flex-col gap-2 text-xs"><span>{label}</span><Input aria-label={label} type={type} step={type === 'datetime-local' ? 1 : undefined} maxLength={key === 'title' ? 100 : undefined} inputMode={key === 'limit' || key === 'minSpend' ? 'numeric' : undefined} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} /></label>)}
    {error && <p role="alert" className="text-xs text-destructive sm:col-span-2">{error}</p>}
  </FormDialog>;
}

function CodesDialog({ seller, batchId, onClose }: { seller: DemoSession; batchId: string; onClose: () => void }) {
  const detail = useAsync(() => getCouponBatch(seller, batchId), [seller.sessionToken, seller.shopId, batchId]);
  const [deactivating, setDeactivating] = useState<CouponBatchCode>();
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
                      <TableHead className="text-right">Action</TableHead>
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
                        <TableCell className="text-right"><Button variant="outline" size="sm" disabled={c.status === 'DEACTIVATED'} aria-label={`Deactivate ${c.promoCode}`} onClick={() => setDeactivating(c)}>Deactivate</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </Loaded>
        {deactivating && <FormDialog title="Deactivate code?" description={`${deactivating.promoCode} cannot be reactivated afterwards.`} submit="Deactivate code" canSubmit onClose={() => setDeactivating(undefined)} onSubmit={async () => { await patchCoupon(seller, deactivating.id, { deactivated: true }); setDeactivating(undefined); detail.reload(); toast.success('Code deactivated'); }}><span className="text-xs text-muted-foreground sm:col-span-2">Other codes in this batch stay available.</span></FormDialog>}
      </DialogContent>
    </Dialog>
  );
}

function SingleVouchers({ seller, tabs }: { seller: DemoSession; tabs: ReactNode }) {
  const list = useAsync(() => getCoupons(seller), [seller.sessionToken, seller.shopId], 10000);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Coupon>();

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
      <SellerCard className="seller-voucher-panel">
      <div className="seller-voucher-toolbar">
        {tabs}
        <Button onClick={() => setCreating(true)}>
          <Plus /> New voucher
        </Button>
      </div>
        <Loaded result={list} what="vouchers">
          {(d) =>
            d.items.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No vouchers yet.</p>
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
                        <Button size="sm" variant="ghost" onClick={() => setEditing(c)}><Pencil size={13} />Edit</Button>
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
      {editing && <EditVoucherDialog coupon={editing} onClose={() => setEditing(undefined)} onSave={async (body) => { await patchCoupon(seller, editing.id, body); toast.success('Voucher saved'); setEditing(undefined); list.reload(); }} />}

      {creating ? (
        <NewVoucherDialog
          onClose={() => setCreating(false)}
          onCreate={async (f) => {
            const clock = await getBusinessClock();
            await createCoupon(seller, voucherBody(f, Date.parse(clock.now)));
            toast.success('Voucher created');
            setCreating(false);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function CodeBatches({ seller, tabs }: { seller: DemoSession; tabs: ReactNode }) {
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
      <SellerCard className="seller-voucher-panel">
      <div className="seller-voucher-toolbar">
        {tabs}
        <Button onClick={() => setCreating(true)}>
          <Plus /> New code batch
        </Button>
      </div>
        <Loaded result={list} what="code batches">
          {(d) =>
            d.items.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">No code batches yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="bg-surface-2 hover:bg-surface-2">
                    <TableHead className="pl-4">Title</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Used</TableHead>
                    <TableHead>Valid from</TableHead>
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
                      <TableCell>{day(b.startAt)}</TableCell>
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
            const clock = await getBusinessClock();
            const created = await createCouponBatch(seller, batchBody(f, Date.parse(clock.now)));
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
  const tabs = (
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'batches' ? { tab: 'batches' } : {}, { replace: true })}>
        <TabsList variant="line" className="h-11 justify-start gap-2">
          <TabsTrigger value="vouchers">Vouchers</TabsTrigger>
          <TabsTrigger value="batches">Code batches</TabsTrigger>
        </TabsList>
      </Tabs>
  );
  return <div className="seller-vouchers-page">{tab === 'batches' ? <CodeBatches seller={seller} tabs={tabs} /> : <SingleVouchers seller={seller} tabs={tabs} />}</div>;
}

export function SellerVouchers() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Vouchers key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
