import { useState, type FormEvent } from 'react';
import { MessageSquare, Send, Store } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { getConversationMessages, sendConversationMessage, sendShopMessage } from '@/lib/endpoints';
import type { DemoSession } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/**
 * Plain-text chat thread with the rules of the former /buyer and /seller chat tabs: messages poll every 3 s,
 * unsupported types are labelled instead of faked, a SELLER cannot reply when can_send_message is false, and a
 * BUYER without a conversation starts one through POST chat/messages.
 */
export function ChatThread({ session, conversationId, onSent, appearance, shopName }: { session: DemoSession; conversationId: string | undefined; onSent: () => void; appearance?: 'storefront'; shopName?: string }) {
  const buyer = session.role === 'BUYER';
  const thread = useAsync(() => (conversationId ? getConversationMessages(session, conversationId) : Promise.resolve(undefined)), [session.sessionToken, conversationId], 3000);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!conversationId && !buyer) {
    return (
      <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
        <MessageSquare className="size-8 text-muted-2" aria-hidden />
        Select a conversation
      </div>
    );
  }
  const canSendHere = buyer || thread.data?.conversation.canSendMessage !== false;
  const canSend = text.trim().length > 0 && !busy && canSendHere;
  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      if (conversationId) await sendConversationMessage(session, conversationId, text);
      else await sendShopMessage(session, text);
      setText('');
      thread.reload();
      onSent();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const title = buyer ? 'Chat with the shop' : thread.data?.conversation.buyerNickname;

  return (
    <section aria-label="Chat thread" className={cn('flex h-full flex-col', appearance === 'storefront' ? 'storefront-thread' : 'min-h-[480px]')}>
      <header className="chat-thread-header border-b border-line-soft px-5 py-3 font-semibold">{appearance === 'storefront' ? <><span className="chat-shop-avatar"><Store size={19} /></span><span>{shopName ?? 'Shop'}<small>Shop conversation</small></span></> : title ?? <Skeleton className="h-5 w-32" />}</header>
      <div className="chat-message-area flex flex-1 flex-col gap-2 overflow-y-auto bg-surface-2 px-5 py-4">
        {!conversationId ? (
          <div className="chat-empty m-auto text-center text-sm text-muted-foreground">{appearance === 'storefront' && <MessageSquare size={27} aria-hidden />}<p>Say hello to start a conversation.</p></div>
        ) : thread.loading && !thread.data ? (
          <Skeleton className="h-10 w-2/3" />
        ) : thread.error && !thread.data ? (
          <Alert variant="destructive">
            <AlertDescription>{thread.error.message}</AlertDescription>
          </Alert>
        ) : thread.data?.items.length === 0 ? (
          <p className="m-auto text-sm text-muted-foreground">No messages yet.</p>
        ) : (
          <ol className="flex flex-col gap-2" aria-label="Messages">
            {thread.data?.items.map((m) => {
              const mine = buyer ? m.role === 'BUYER' : m.role !== 'BUYER';
              return (
                <li key={m.id} className={cn('flex max-w-[75%] flex-col gap-0.5', mine ? 'items-end self-end' : 'items-start self-start')}>
                  <span className="text-[11px] text-muted-2">
                    {m.roleLabel} · {time(m.at)}
                  </span>
                  <span className={cn('chat-bubble rounded-2xl px-3.5 py-2 text-sm', mine ? cn('chat-bubble-mine rounded-br-sm', appearance !== 'storefront' && 'bg-primary text-primary-foreground') : 'rounded-bl-sm bg-white ring-1 ring-line-soft')}>
                    {m.supported ? m.text : <em>[unsupported message type {m.type}]</em>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {!canSendHere ? (
        <p className="border-t border-line-soft bg-buyer-soft px-5 py-2 text-xs text-buyer-ink" role="note">
          The shop cannot send messages in this conversation (can_send_message = false).
        </p>
      ) : null}
      {error ? (
        <p className="px-5 pt-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <form onSubmit={send} className="chat-composer flex items-center gap-2 border-t border-line-soft p-3">
        <Input aria-label="Message" placeholder="Type a text message" maxLength={2000} value={text} disabled={!canSendHere} onChange={(e) => setText(e.target.value)} className={appearance === 'storefront' ? '!h-11 !rounded-[10px] !text-xs' : 'h-10 rounded-full'} />
        <Button type="submit" size="icon" aria-label="Send" disabled={!canSend} className={appearance === 'storefront' ? '!size-11 !rounded-[10px] !bg-[#171717] !text-white disabled:!bg-[#eaeaea] disabled:!text-[#999] disabled:!opacity-100' : 'size-10'}>
          <Send />
        </Button>
      </form>
    </section>
  );
}
