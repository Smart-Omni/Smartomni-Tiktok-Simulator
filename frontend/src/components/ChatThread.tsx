import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageSquare, Send, Store, ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';
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
  const messagesRef = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const latestId = thread.data?.items.at(-1)?.id;
  useEffect(() => {
    if (appearance === 'storefront' && followMessages.current && messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
  }, [latestId, appearance]);

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
    if (!canSend) return;
    setError(undefined);
    setBusy(true);
    try {
      if (conversationId) await sendConversationMessage(session, conversationId, text);
      else await sendShopMessage(session, text);
      setText('');
      followMessages.current = true;
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
      <header className="chat-thread-header border-b border-line-soft px-5 py-3 font-semibold">{appearance === 'storefront' ? <><span className="chat-shop-avatar"><Store size={21} /></span><span>{shopName ?? 'Shop'}<small>Direct shop conversation</small></span><span className="buyer-chat-thread-label"><MessageSquare size={14} />Shop messages</span></> : title ?? <Skeleton className="h-5 w-32" />}</header>
      <div ref={messagesRef} onScroll={() => { const area = messagesRef.current; if (area) followMessages.current = area.scrollHeight - area.scrollTop - area.clientHeight < 80; }} className="chat-message-area flex flex-1 flex-col gap-2 overflow-y-auto bg-surface-2 px-5 py-4">
        {!conversationId ? (
          <div className="chat-empty m-auto text-center text-sm text-muted-foreground">{appearance === 'storefront' && <><span className="buyer-chat-empty-art"><MessageSquare size={38} strokeWidth={1.4} aria-hidden /><span><Store size={19} /></span></span><span className="buyer-messenger-eyebrow">GREAT FINDS START WITH A HELLO</span><h2>Meet {shopName ?? 'your next favorite shop'}.</h2></>}<p>Say hello to start a conversation.</p>{appearance === 'storefront' && <small>Ask about a product, sizing, availability, or your order.</small>}</div>
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
            {thread.data?.items.map((m, index, messages) => {
              const mine = buyer ? m.role === 'BUYER' : m.role !== 'BUYER';
              const showDate = appearance === 'storefront' && (index === 0 || new Date(m.at).toDateString() !== new Date(messages[index - 1].at).toDateString());
              return (
                <Fragment key={m.id}>
                {showDate && <li role="presentation" className="buyer-chat-date-divider"><span>{new Date(m.at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}</span></li>}
                <li key={m.id} className={cn('flex max-w-[75%] flex-col gap-0.5', mine ? 'items-end self-end' : 'items-start self-start')}>
                  <span className="text-[11px] text-muted-2">
                    {m.roleLabel} · {time(m.at)}
                  </span>
                  <span className={cn('chat-bubble rounded-2xl px-3.5 py-2 text-sm', mine ? cn('chat-bubble-mine rounded-br-sm', appearance !== 'storefront' && 'bg-primary text-primary-foreground') : 'rounded-bl-sm bg-white ring-1 ring-line-soft')}>
                    {m.supported ? m.text : <em>[unsupported message type {m.type}]</em>}
                  </span>
                </li>
                </Fragment>
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
        {appearance === 'storefront' ? <div className="buyer-chat-compose-box"><label htmlFor="buyer-message">Your message</label><textarea id="buyer-message" aria-label="Message" placeholder={`Write a message to ${shopName ?? 'the shop'}…`} maxLength={2000} rows={2} value={text} disabled={!canSendHere} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (canSend) e.currentTarget.form?.requestSubmit(); } }} /><div className="buyer-chat-compose-hint"><span>Enter to send · Shift + Enter for a new line</span><span>{text.length} / 2,000</span></div></div> : <Input aria-label="Message" placeholder="Type a text message" maxLength={2000} value={text} disabled={!canSendHere} onChange={(e) => setText(e.target.value)} className="h-10 rounded-full" />}
        <Button type="submit" size="icon" aria-label="Send" disabled={!canSend} className={appearance === 'storefront' ? '!size-11 !rounded-[10px] !bg-[#171717] !text-white disabled:!bg-[#eaeaea] disabled:!text-[#999] disabled:!opacity-100' : 'size-10'}>
          <Send />
        </Button>
      </form>
      {appearance === 'storefront' && <div className="buyer-chat-bottom-note">Questions about a purchase?<Link to="/account/orders">View your orders<ArrowUpRight size={12} /></Link></div>}
    </section>
  );
}
