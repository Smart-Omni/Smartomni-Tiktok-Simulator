import { useState } from 'react';
import { api } from '../../lib/api';

const whole = (value: string, max: number) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= max;
const defaultTiers = [
  { name: 'Gold', percentage: '10', cap: '' },
  { name: 'Platinum', percentage: '20', cap: '' },
  { name: 'Diamond', percentage: '30', cap: '' },
];

/** Test-data setup: one batch of single-use percentage codes per tier, using the business clock. */
export function LoyaltyVouchersForm({ shopId, onCreated, onClose }: { shopId: string; onCreated: (message: string) => void; onClose: () => void }) {
  const [quantity, setQuantity] = useState('100');
  const [validDays, setValidDays] = useState('365');
  const [tiers, setTiers] = useState(defaultTiers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = !!shopId && whole(quantity, 500) && whole(validDays, 365) && tiers.length >= 1 && tiers.length <= 10
    && tiers.every((t) => t.name.trim().length >= 1 && t.name.trim().length <= 40 && whole(t.percentage, 100) && (!t.cap || whole(t.cap, 2_000_000_000)));
  const update = (index: number, field: keyof typeof defaultTiers[number], value: string) => setTiers((rows) => rows.map((t, i) => i === index ? { ...t, [field]: value } : t));

  async function create() {
    if (!valid || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ batches: { title: string; codes: unknown[] }[] }>('/test-admin/scenarios/loyalty-vouchers', {
        method: 'POST',
        body: { shopId, quantityPerTier: Number(quantity), validDays: Number(validDays), tiers: tiers.map((t) => ({ name: t.name.trim(), percentage: Number(t.percentage), ...(t.cap ? { maxDiscountVnd: Number(t.cap) } : {}) })) },
      });
      onCreated(`Created ${result.batches.map((b) => `${b.title} (${b.codes.length} codes)`).join(', ')}`);
    } catch (e) {
      setError(`${(e as Error).message}. Check the coupon list before submitting again: new batches may already exist.`);
    } finally { setBusy(false); }
  }

  return <form className="card admin-scenario-form" aria-label="Loyalty voucher scenario" onSubmit={(e) => { e.preventDefault(); void create(); }}>
    <h3>Create loyalty voucher batches</h3>
    <p>Each submission creates new single-use codes for every tier, valid from the current business time. These percentages are test data.</p>
    <fieldset disabled={busy}>
      <div className="admin-fields-grid">
        <label>Codes per tier<input type="number" required min={1} max={500} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label>Validity (days)<input type="number" required min={1} max={365} step={1} value={validDays} onChange={(e) => setValidDays(e.target.value)} /></label>
      </div>
      {tiers.map((tier, i) => <fieldset key={i} className="admin-fields-grid">
        <legend>Tier {i + 1}</legend>
        <label>Tier {i + 1} name<input required maxLength={40} value={tier.name} onChange={(e) => update(i, 'name', e.target.value)} /></label>
        <label>Tier {i + 1} percent off<input type="number" required min={1} max={100} step={1} value={tier.percentage} onChange={(e) => update(i, 'percentage', e.target.value)} /></label>
        <label>Tier {i + 1} maximum discount (VND, optional)<input type="number" min={1} max={2000000000} step={1} value={tier.cap} onChange={(e) => update(i, 'cap', e.target.value)} /></label>
        <button type="button" disabled={tiers.length === 1} onClick={() => setTiers((rows) => rows.filter((_, index) => index !== i))}>Remove tier {i + 1}</button>
      </fieldset>)}
      <div className="admin-table-actions">
        <button type="button" disabled={tiers.length >= 10} onClick={() => setTiers((rows) => [...rows, { name: '', percentage: '', cap: '' }])}>Add tier</button>
        <button type="button" onClick={onClose}>Cancel</button>
        <button className="admin-primary" disabled={!valid}>{busy ? 'Creating batches…' : 'Generate voucher batches'}</button>
      </div>
    </fieldset>
    {error && <p className="state state-error" role="alert">{error}</p>}
  </form>;
}
