import { useState } from 'react';
import { AsyncState } from '../components/AsyncState';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ConsoleTab } from './registry';
import { PaginatedList } from '../components/console/PaginatedList';

interface AdminConversation {
  id: string;
  rowId: string;
  shopName: string;
  buyerNickname: string;
  buyerUserId: string;
  buyerImUserId: string;
  identityKnown: boolean;
  messages: number;
  agentJoined: boolean;
  canSendMessage: boolean;
  dropSendResponse: boolean;
  complaintTestLabel: boolean;
}

/** Conversation controls. `complaint test label` is seeded TEST DATA, not an AI/classifier result. */
export function ChatPanel({ shopId }: { shopId: string }) {
  const list = useAsync(() => api<{ items: AdminConversation[] }>('/test-admin/chat/conversations'), [], 5000);
  const [msg, setMsg] = useState<string>();
  async function run(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMsg(label);
      list.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  const post = (path: string, body: unknown) => api(`/test-admin/chat/conversations/${path}`, { method: 'POST', body });
  return (
    <div>
      <p className="muted">Image upload and Send Message 202606 are unsupported (no verified contract); only TEXT messages are created.</p>
      <div className="row-wrap">
        <button onClick={() => void run('Created an unlinked conversation.', () => api('/test-admin/chat/conversations', { method: 'POST', body: { shopId, unknownBuyerNickname: 'unlinked_user', text: 'Hello from an unknown TikTok user' } }))} disabled={!shopId}>
          New conversation from an unlinked TikTok user
        </button>
      </div>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <AsyncState {...list} onRetry={list.reload} isEmpty={(d) => d.items.length === 0} emptyText="No conversations. Seed the shops first.">
        {(d) => (
          <PaginatedList items={d.items} label="Conversations" initialPageSize={5}>{(visible) => <div className="scroll"><table className="admin-chat-table">
            <thead><tr><th>Shop</th><th>Buyer</th><th>Identity</th><th>Msgs</th><th>Flags</th><th>Controls</th></tr></thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.rowId}>
                  <td>{c.shopName}</td>
                  <td>{c.buyerNickname}<div className="muted">user_id {c.buyerUserId}<br />im_user_id {c.buyerImUserId}</div></td>
                  <td>{c.identityKnown ? <span className="pill ok">linked</span> : <span className="pill bad">unlinked</span>}</td>
                  <td>{c.messages}</td>
                  <td><div className="admin-chat-flags">
                    {c.complaintTestLabel ? <span className="pill warn">complaint test label</span> : null}
                    {c.agentJoined ? <span className="pill">agent joined</span> : null}
                    {!c.canSendMessage ? <span className="pill bad">cannot send</span> : null}
                    {c.dropSendResponse ? <span className="pill bad">drops send response</span> : null}
                  </div></td>
                  <td><div className="admin-chat-controls">
                    <button onClick={() => void run('Buyer message sent.', () => post(`${c.rowId}/buyer-message`, { text: 'Test buyer message' }))}>Buyer message</button>
                    <button onClick={() => void run('Buyer message stored, event suppressed.', () => post(`${c.rowId}/buyer-message`, { text: 'Message with a lost event', suppressEvent: true }))}>Lose event</button>
                    <button onClick={() => void run('Buyer message stored, event duplicated.', () => post(`${c.rowId}/buyer-message`, { text: 'Message with a duplicated event', duplicateEvent: true }))}>Duplicate event</button>
                    <button onClick={() => void run('Agent toggled.', () => post(`${c.rowId}/agent`, { joined: !c.agentJoined }))}>{c.agentJoined ? 'Agent leaves' : 'Agent joins'}</button>
                    <button onClick={() => void run('Flag changed.', () => post(`${c.rowId}/flags`, { canSendMessage: !c.canSendMessage }))}>{c.canSendMessage ? 'Block sending' : 'Allow sending'}</button>
                    <button onClick={() => void run('Flag changed.', () => post(`${c.rowId}/flags`, { dropSendResponse: !c.dropSendResponse }))}>{c.dropSendResponse ? 'Stop dropping responses' : 'Drop send response'}</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table></div>}</PaginatedList>
        )}
      </AsyncState>
    </div>
  );
}

const tabs: ConsoleTab[] = [{ path: 'chat', label: 'Chat', order: 80, render: (c) => <ChatPanel {...c} /> }];
export default tabs;
