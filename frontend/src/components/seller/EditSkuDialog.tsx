import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { validText } from '@/lib/catalogValidation';
import type { CatalogSku } from '@/lib/types';

export function EditSkuDialog({ sku, onClose, onSave }: { sku: CatalogSku; onClose: () => void; onSave: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [values, setValues] = useState({ sellerSku: sku.sellerSku, name: sku.name, attributeName: sku.attributeName });
  const [busy, setBusy] = useState(false);
  const valid = validText(values.sellerSku, 100) && validText(values.name, 200) && validText(values.attributeName, 100);
  return <Dialog open onOpenChange={(open) => !open && !busy && onClose()}><DialogContent className="theme-seller font-sans sm:max-w-md"><DialogHeader><DialogTitle>Edit SKU</DialogTitle><DialogDescription>{sku.externalId}</DialogDescription></DialogHeader>
    <form className="flex flex-col gap-4" onSubmit={async (e) => { e.preventDefault(); if (!valid || busy) return; setBusy(true); try { if (await onSave(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])))) onClose(); } finally { setBusy(false); } }}>
      {([['sellerSku', 'Seller SKU', 100], ['name', 'Variant name', 200], ['attributeName', 'Attribute name', 100]] as const).map(([key, label, max]) => <label key={key} className="flex flex-col gap-2 text-xs"><span>{label}</span><Input aria-label={label} required maxLength={max} disabled={busy} value={values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.value })} /></label>)}
      <DialogFooter><Button variant="outline" type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={!valid || busy}>Save SKU</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
