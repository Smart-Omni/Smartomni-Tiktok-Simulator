import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { MessageSquare, Search, Store, ChevronRight } from 'lucide-react';
import { ChatThread } from '@/components/ChatThread';
import { ShopFooter } from '@/components/shop/ShopFooter';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { getIdentities, inShop, listConversations } from '@/lib/endpoints';
import type { DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';

/** Keyed by shop so the previous shop's thread cannot be reused. */
function ShopChat({ session, shopName }: { session: DemoSession; shopName?: string }) {
  const list = useAsync(() => listConversations(session), [session.sessionToken, session.shopId], 4000);
  return <div className="buyer-chat-main">
    {list.loading && !list.data ? <Skeleton className="m-5 h-40" /> : list.error && !list.data ? (
      <Alert variant="destructive" className="m-5 w-auto"><AlertDescription>Could not load messages: {list.error.message}</AlertDescription></Alert>
    ) : <ChatThread session={session} conversationId={list.data?.items[0]?.id} onSent={list.reload} appearance="storefront" shopName={shopName} />}
  </div>;
}

function Messages({ buyer }: { buyer: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const shopId = params.get('shop') ?? buyer.shopId;
  const chat = inShop(buyer, shopId);
  const shops = useAsync(async () => (await getIdentities().catch(() => null))?.sellers.flatMap((s) => s.shops) ?? [], []);
  const options = [...new Map((shops.data ?? []).map((s) => [s.id, s])).values()];
  if (!shops.loading && !options.some((s) => s.id === shopId)) options.unshift({ id: shopId, name: 'Selected shop' });
  const selected = options.find((s) => s.id === shopId);
  const filtered = options.filter((s) => s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="buyer-messages-page">
    <nav className="transaction-breadcrumb" aria-label="Breadcrumb"><Link to="/">Home</Link><span>/</span><span aria-current="page">Messages</span></nav>
    <div className="buyer-chat-title"><h1>Messages</h1><MessageSquare size={22} aria-hidden /></div>
    <div className="buyer-chat-workspace">
      <aside className="buyer-chat-sidebar" aria-label="Shops">
        <div className="buyer-chat-sidebar-heading"><h2>Shops</h2><span>{options.length}</span></div>
        <label className="buyer-chat-search"><Search size={15} aria-hidden /><input aria-label="Search shops" placeholder="Search shops" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="buyer-chat-shop-list">
          {shops.loading ? <Skeleton className="m-4 h-20" /> : filtered.length ? filtered.map((s) => <button key={s.id} type="button" aria-pressed={s.id === shopId} onClick={() => setParams(s.id === buyer.shopId ? {} : { shop: s.id }, { replace: true })}>
            <span className="chat-shop-avatar"><Store size={18} aria-hidden /></span><span className="buyer-chat-shop-name">{s.name}</span><ChevronRight size={14} aria-hidden />
          </button>) : <p className="buyer-chat-no-results">No shops found.</p>}
        </div>
      </aside>
      <ShopChat key={shopId} session={chat} shopName={selected?.name} />
    </div>
    <ShopFooter />
  </div>;
}

export function MessagesPage() {
  const { buyer } = useAuth();
  return buyer ? <Messages key={buyer.sessionToken} buyer={buyer} /> : null;
}
