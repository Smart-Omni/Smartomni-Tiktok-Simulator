import { useState, type FormEvent } from 'react';
import { FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { TestBadge } from '@/components/seller/TestTools';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { sendTestBuyerMessage } from '@/pages/console/adminEndpoints';

/** TEST: the buyer of the open conversation replies (POST /test-admin/chat/conversations/:ref/buyer-message). */
export function SimulateBuyerReply({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await sendTestBuyerMessage(conversationId, text.trim());
      setText('');
      onSent();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="seller-test-reply" aria-label="Simulate buyer reply">
      <TestBadge />
      <Input aria-label="Buyer reply text" placeholder="Simulate a reply from the buyer" maxLength={2000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
      <Button type="submit" size="sm" variant="outline" className="seller-test-button" disabled={!text.trim() || busy}>
        <FlaskConical aria-hidden="true" />Simulate buyer reply
      </Button>
    </form>
  );
}
