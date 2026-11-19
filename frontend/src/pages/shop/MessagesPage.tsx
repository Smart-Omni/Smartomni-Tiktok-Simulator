import { useSearchParams } from 'react-router-dom';
import { ChatThread } from '@/components/ChatThread';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/lib/auth';
import { getIdentities, inShop, listConversations } from '@/lib/endpoints';
import type { DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';

/** One conversation with one shop. Keyed by shop so a stale list of another shop is never used. */
function ShopChat({ session }: { session: DemoSession }) {
  const list = useAsync(() => listConversations(session), [session.sessionToken, session.shopId], 4000);
  return (
    <>
      {list.data ? (
        <p className="text-sm text-muted-foreground" role="note">
          Supported message types: {list.data.supportedTypes.join(', ')}. Not simulated: {list.data.unsupported}.
        </p>
      ) : null}
      <div className="overflow-hidden rounded-card bg-white shadow-xs ring-1 ring-line-soft">
        {list.loading && !list.data ? (
          <Skeleton className="m-5 h-40" />
        ) : list.error && !list.data ? (
          <Alert variant="destructive" className="m-5 w-auto">
            <AlertDescription>Could not load messages: {list.error.message}</AlertDescription>
          </Alert>
        ) : (
          <ChatThread session={session} conversationId={list.data?.items[0]?.id} onSent={list.reload} />
        )}
      </div>
    </>
  );
}

/** Buyer chat with one shop at a time (one conversation per buyer and shop). `?shop=` picks the shop; the default is the session's shop. */
function Messages({ buyer }: { buyer: DemoSession }) {
  const [params, setParams] = useSearchParams();
  const shopId = params.get('shop') ?? buyer.shopId;
  const chat = inShop(buyer, shopId);
  const shops = useAsync(async () => (await getIdentities().catch(() => null))?.sellers.flatMap((s) => s.shops) ?? [], []);
  const options = shops.data ?? [];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="text-2xl font-bold">Messages</h1>
      {options.length > 1 ? (
        <div className="flex items-center gap-2">
          <Label htmlFor="chat-shop" className="text-sm">
            Shop
          </Label>
          <select
            id="chat-shop"
            value={shopId}
            onChange={(e) => setParams(e.target.value === buyer.shopId ? {} : { shop: e.target.value }, { replace: true })}
            className="h-9 min-w-56 rounded-lg border border-line bg-white px-3 text-sm"
          >
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <ShopChat key={shopId} session={chat} />
    </div>
  );
}

export function MessagesPage() {
  const { buyer } = useAuth();
  // the route is guarded by RequireRole BUYER
  return buyer ? <Messages key={buyer.sessionToken} buyer={buyer} /> : null;
}
