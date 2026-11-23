import { Input } from '@/components/ui/input';
import type { VariantDraft } from '@/lib/catalogValidation';

export function VariantExtras({ value, onChange, warehouses, label }: { value: VariantDraft; onChange: (v: VariantDraft) => void; warehouses: { externalId: string; name: string }[]; label: string }) {
  return <details className="seller-variant-extras"><summary>Attribute & initial inventory</summary><div>
    <label><span>Attribute name</span><Input aria-label={`Attribute name ${label}`} maxLength={100} placeholder="Phân loại" value={value.attributeName} onChange={(e) => onChange({ ...value, attributeName: e.target.value })} /></label>
    {warehouses.map((w) => <label key={w.externalId}><span>{w.name}</span><Input aria-label={`Initial stock ${label} in ${w.name}`} inputMode="numeric" placeholder="0" value={value.stock[w.externalId] ?? ''} onChange={(e) => { const stock = { ...value.stock }; if (e.target.value === '') delete stock[w.externalId]; else stock[w.externalId] = e.target.value; onChange({ ...value, stock }); }} /></label>)}
  </div></details>;
}
