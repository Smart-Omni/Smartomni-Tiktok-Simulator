import { MapPin, Store, Warehouse } from 'lucide-react';
import { Loaded, SellerCard, humanize } from '@/components/seller/SellerUi';
import { useAuth } from '@/lib/auth';
import { getShop } from '@/lib/endpoints';
import { useAsync } from '@/lib/useAsync';

export function SellerShop() {
  const { seller } = useAuth();
  const shop = useAsync(() => seller ? getShop(seller) : Promise.reject(new Error('Not signed in')), [seller?.sessionToken, seller?.shopId]);
  return <Loaded result={shop} what="shop information">{(data) => <div className="flex flex-col gap-4">
    <SellerCard label="Shop profile" className="p-5">
      <div className="mb-5 flex items-center gap-3"><Store size={22} /><div><h2>{data.name}</h2><span className="text-xs text-muted-foreground">{humanize(data.status)}</span></div></div>
      <dl className="seller-shop-facts">{[['Shop ID', data.id], ['Region', data.region], ['Currency', data.currency]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </SellerCard>
    <SellerCard label="Warehouses" className="p-5"><h2 className="mb-4 flex items-center gap-2"><Warehouse size={16} />Warehouses <span className="text-xs text-muted-foreground">{data.warehouses.length}</span></h2>
      {data.warehouses.length ? <ul className="seller-shop-warehouses">{data.warehouses.map((w) => <li key={w.id}><Warehouse size={18} /><div><strong>{w.name}</strong><span>{w.code}</span></div><span className="flex items-center gap-1"><MapPin size={12} />{w.city}</span></li>)}</ul> : <p className="text-sm text-muted-foreground">No warehouses.</p>}
    </SellerCard>
  </div>}</Loaded>;
}
