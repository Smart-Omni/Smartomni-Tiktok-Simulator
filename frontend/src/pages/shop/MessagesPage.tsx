import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Search, Store, ChevronRight, Package, ShoppingBag, X } from 'lucide-react';
import { ChatThread } from '@/components/ChatThread';
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
  const [showShops, setShowShops] = useState(false);
  const shopId = params.get('shop') ?? buyer.shopId;
  const chat = inShop(buyer, shopId);
  const shops = useAsync(async () => (await getIdentities()).sellers.flatMap((s) => s.shops), []);
  const options = [...new Map((shops.data ?? []).map((s) => [s.id, s])).values()];
  if (!shops.loading && !options.some((s) => s.id === shopId)) options.unshift({ id: shopId, name: 'Selected shop' });
  const selected = options.find((s) => s.id === shopId);
  const filtered = options.filter((s) => s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="buyer-messages-page">
    <header className="buyer-messenger-topbar">
      <Link to="/" className="buyer-messenger-brand" aria-label="Tiptop Shop home"><span>TikTok<span className="buyer-messenger-brand-dot" /></span><small>SHOP SIMULATOR</small></Link>
      <div className="buyer-messenger-title"><span className="buyer-messenger-title-icon"><MessageSquare size={19} /></span><div><h1>Messages</h1><p>A little conversation. A better shopping experience.</p></div></div>
      <nav aria-label="Messaging navigation"><button className="buyer-messenger-shop-toggle" aria-label={showShops ? 'Hide shops' : 'Show shops'} aria-controls="buyer-chat-shops" aria-expanded={showShops} onClick={() => setShowShops(!showShops)}>{showShops ? <X size={18} /> : <Store size={18} />}</button><Link to="/account/orders" aria-label="My orders" title="My orders"><Package size={17} /></Link><Link to="/" aria-label="Back to shopping" title="Back to shopping"><ShoppingBag size={17} /></Link></nav>
    </header>
    <div className="buyer-chat-workspace" data-show-shops={showShops}>
      <aside id="buyer-chat-shops" className="buyer-chat-sidebar" aria-label="Shops">
        <div className="buyer-chat-sidebar-heading"><div><span className="buyer-messenger-eyebrow">YOUR INBOX</span><h2>Shop conversations<span>{options.length}</span></h2></div></div>
        <label className="buyer-chat-search"><Search size={15} aria-hidden /><input aria-label="Search shops" placeholder="Search shops" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <div className="buyer-messenger-list-label">ALL SHOPS <Store size={12} /></div>
        <div className="buyer-chat-shop-list">
          {shops.error ? <div className="buyer-chat-no-results" role="alert">Could not load shops.<button onClick={shops.reload}>Try again</button></div> : shops.loading ? <Skeleton className="m-4 h-20" /> : filtered.length ? filtered.map((s, index) => <button key={s.id} type="button" aria-label={s.name} aria-pressed={s.id === shopId} onClick={() => { setParams(s.id === buyer.shopId ? {} : { shop: s.id }, { replace: true }); setShowShops(false); }}>
            <span className="chat-shop-avatar" data-color={index % 4} aria-hidden>{s.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('')}</span><span className="buyer-chat-shop-name">{s.name}<small>{s.id === shopId ? 'Current conversation' : 'Start or continue a chat'}</small></span><ChevronRight size={14} aria-hidden />
          </button>) : <p className="buyer-chat-no-results">No shops found.</p>}
        </div>
        <div className="buyer-messenger-sidebar-footer"><Link to="/"><ArrowLeft size={15} />Explore the marketplace</Link><span>Find something worth talking about.</span></div>
      </aside>
      <ShopChat key={shopId} session={chat} shopName={selected?.name} />
    </div>
  </div>;
}

export function MessagesPage() {
  const { buyer } = useAuth();
  return buyer ? <Messages key={buyer.sessionToken} buyer={buyer} /> : null;
}
