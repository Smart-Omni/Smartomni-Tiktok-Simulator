import { useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Search, Users } from 'lucide-react';
import { Loaded, SellerCard } from '@/components/seller/SellerUi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/lib/auth';
import { getShopBuyers } from '@/lib/endpoints';
import type { DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();

function Customers({ seller }: { seller: DemoSession }) {
  const buyers = useAsync(() => getShopBuyers(seller), [seller.sessionToken, seller.shopId]);
  const [query, setQuery] = useState('');
  const [requestedPage, setPage] = useState(1);
  const items = (buyers.data?.items ?? []).filter((b) => normalize(`${b.name} ${b.city} ${b.id}`).includes(normalize(query)));
  const pages = Math.max(1, Math.ceil(items.length / 10));
  const page = Math.min(requestedPage, pages);
  return <SellerCard label="Shop customers" className="seller-customers">
    <div className="seller-customers-toolbar">
      <div className="seller-customers-search"><Search size={15} aria-hidden="true" /><Input aria-label="Search customers" placeholder="Search name, city or customer ID" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} /></div>
      <Button variant="outline" size="sm" onClick={buyers.reload}><RefreshCw size={14} />Refresh</Button>
    </div>
    {buyers.error && buyers.data && <div className="seller-load-notice" role="alert">Could not refresh customers: {buyers.error.message}</div>}
    <Loaded result={buyers} what="customers">{() => items.length ? <>
      <Table><TableHeader><TableRow><TableHead>Customer</TableHead><TableHead>Customer ID</TableHead><TableHead>City</TableHead></TableRow></TableHeader><TableBody>{items.slice((page - 1) * 10, page * 10).map((buyer) => <TableRow key={buyer.id}><TableCell><span className="seller-customer-name"><span className="seller-customer-avatar" aria-hidden="true">{buyer.name.charAt(0).toUpperCase()}</span>{buyer.name}</span></TableCell><TableCell className="font-mono text-xs">{buyer.id}</TableCell><TableCell>{buyer.city || '—'}</TableCell></TableRow>)}</TableBody></Table>
      <nav aria-label="Customers pagination" className="seller-product-pagination"><span>{(page - 1) * 10 + 1}–{Math.min(page * 10, items.length)} of {items.length}</span><div><span>Page {page} of {pages}</span><Button variant="outline" size="sm" aria-label="Previous page" disabled={page === 1} onClick={() => setPage(page - 1)}><ChevronLeft size={14} /></Button><Button variant="outline" size="sm" aria-label="Next page" disabled={page === pages} onClick={() => setPage(page + 1)}><ChevronRight size={14} /></Button></div></nav>
    </> : <div className="seller-catalog-empty"><Users size={26} /><p>{query ? 'No customers match your search.' : 'No customers in this shop yet.'}</p>{query && <Button variant="outline" size="sm" onClick={() => setQuery('')}>Clear search</Button>}</div>}</Loaded>
  </SellerCard>;
}

export function SellerCustomers() {
  const { seller } = useAuth();
  return seller ? <Customers key={`${seller.shopId}:${seller.sessionToken}`} seller={seller} /> : null;
}
