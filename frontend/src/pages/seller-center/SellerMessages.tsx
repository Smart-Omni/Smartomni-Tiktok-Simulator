import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChatThread } from '@/components/ChatThread';
import { Loaded, SellerCard } from '@/components/seller/SellerUi';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import { useAuth } from '@/lib/auth';
import { listConversations } from '@/lib/endpoints';
import type { ChatMessage, Conversation, DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

/** Seller chat: conversation list | ChatThread (polling and rules of the former chat.shared.tsx). */

const preview = (m: ChatMessage | null) => (m ? (m.text ?? `[${m.type}]`) : '');

function ConversationList({ items, current, onSelect }: { items: Conversation[]; current: string | undefined; onSelect: (id: string) => void }) {
  if (!items.length) return <p className="p-6 text-center text-sm text-muted-foreground">No conversations.</p>;
  return (
    <ul className="flex flex-col" aria-label="Conversations">
      {items.map((c) => (
        <li key={c.id}>
          <button
            type="button"
            aria-pressed={c.id === current}
            onClick={() => onSelect(c.id)}
            className={cn('flex w-full cursor-pointer items-center gap-3 border-l-2 px-4 py-3 text-left', c.id === current ? 'border-teal bg-teal-soft' : 'border-transparent hover:bg-surface-2')}
          >
            <Avatar className="size-9">
              <AvatarFallback className="bg-surface text-sm font-semibold">{c.buyerNickname.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold">{c.buyerNickname}</span>
              <span className="truncate text-xs text-muted-foreground">{preview(c.latest)}</span>
            </span>
            {c.unread > 0 ? <span className="rounded-full bg-teal px-2 py-0.5 text-[11px] font-semibold text-white">{c.unread} unread</span> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Messages({ seller }: { seller: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get('filter') === 'unread';
  const list = useAsync(() => listConversations(seller), [seller.sessionToken, seller.shopId], 4000);
  const [selected, setSelected] = useState<string>();

  return (
    <div className="flex flex-col gap-4">

      <SellerCard className="grid overflow-hidden md:grid-cols-[320px_minmax(0,1fr)]">
        <div className="border-b border-line-soft md:border-b-0 md:border-r">
          <label className="flex items-center gap-2 border-b border-line-soft px-4 py-3 text-sm">
            <Checkbox checked={unreadOnly} onCheckedChange={(v) => setParams(v === true ? { filter: 'unread' } : {}, { replace: true })} />
            Unread only
          </label>
          <Loaded result={list} what="conversations">
            {(d) => <ConversationList items={unreadOnly ? d.items.filter((c) => c.unread > 0) : d.items} current={selected} onSelect={setSelected} />}
          </Loaded>
        </div>
        <ChatThread session={seller} conversationId={selected} onSent={list.reload} />
      </SellerCard>
    </div>
  );
}

export function SellerMessages() {
  const { seller } = useAuth();
  // the route is guarded by RequireRole SELLER
  return seller ? <Messages key={`${seller.sessionToken}:${seller.shopId}`} seller={seller} /> : null;
}
