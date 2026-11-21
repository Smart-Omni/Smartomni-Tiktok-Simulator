import { useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { AsyncState } from '../../components/AsyncState';
import { PaginatedList } from '../../components/console/PaginatedList';
import { useAsync } from '../../lib/useAsync';
import { disputeLabel, disputeStatuses, getDispute, listDisputes, triggerDispute, type DisputeRecord, type DisputeStatus, type DisputeTriggerResult } from './disputeEndpoints';

const tone = (status: DisputeStatus) => status === 'DISPUTE_APPROVED' ? 'success' : status === 'DISPUTE_REJECTED' ? 'danger' : 'warning';
const date = (value: string) => new Date(value).toLocaleString();

function DisputeForm({ shopId, record, onDone, onClose }: { shopId: string; record?: DisputeRecord; onDone: (result: DisputeTriggerResult) => void; onClose: () => void }) {
  const [orderId, setOrderId] = useState(record?.orderId ?? '');
  const [returnId, setReturnId] = useState(record?.returnId ?? '');
  const [status, setStatus] = useState<DisputeStatus>(record?.status ?? 'DISPUTE_PENDING_REVIEW');
  const [reason, setReason] = useState(record?.reason ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('VND');
  const [webhook, setWebhook] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approved = status === 'DISPUTE_APPROVED';
  const validAmount = amount.trim() !== '' && Number.isSafeInteger(Number(amount)) && Number(amount) >= 0;
  const valid = !!shopId && !!orderId.trim() && (!approved || validAmount);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !valid) return;
    setBusy(true); setError('');
    try {
      const result = await triggerDispute({ shop_id: shopId, order_id: orderId.trim(), ...(record ? { dispute_id: record.disputeId } : {}), ...(returnId.trim() ? { return_id: returnId.trim() } : {}), status, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(approved ? { compensation_amount: Number(amount), currency: currency.trim(), ...(webhook.trim() ? { webhook_url: webhook.trim() } : {}) } : {}) });
      onDone(result);
    } catch (e) { setError(`${(e as Error).message}. Refresh the list before submitting again to check whether the change was applied.`); }
    finally { setBusy(false); }
  }
  return <form className="admin-dispute-form" onSubmit={(e) => void submit(e)} aria-label={record ? 'Update dispute' : 'Create dispute'}>
    <div className="admin-dispute-form-bar"><strong>{record ? record.disputeId : 'New dispute'}</strong><button type="button" disabled={busy} aria-label="Close dispute form" onClick={onClose}><X size={15} /></button></div>
    <fieldset disabled={busy} className="admin-dispute-fields">
      <label>Order ID<input required maxLength={100} value={orderId} readOnly={!!record} onChange={(e) => setOrderId(e.target.value)} /></label>
      <label>Return ID (optional)<input maxLength={100} value={returnId} readOnly={!!record} onChange={(e) => setReturnId(e.target.value)} /></label>
      <label>Status<select value={status} onChange={(e) => setStatus(e.target.value as DisputeStatus)}>{disputeStatuses.map((s) => <option key={s} value={s}>{disputeLabel(s)}</option>)}</select></label>
      <label className="admin-dispute-wide">Reason (optional)<textarea maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      {approved && <>
        <label>Compensation amount<input required type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label>Currency<input required maxLength={10} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label>
        <label className="admin-dispute-wide">Webhook URL (optional)<input type="url" maxLength={300} placeholder="Use the backend subscription target" value={webhook} onChange={(e) => setWebhook(e.target.value)} /></label>
        <p className="admin-dispute-wide muted">Approving sends a DISPUTE_STATUS_CHANGE webhook. Approved and rejected disputes cannot change status.</p>
      </>}
    </fieldset>
    {error && <div role="alert" className="state state-error">{error}</div>}
    <div className="admin-dispute-form-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="admin-primary" disabled={busy || !valid}>{busy ? 'Applying…' : record ? 'Apply status' : 'Create dispute'}</button></div>
  </form>;
}

function DisputeDetail({ id, shopId, onDone, onClose }: { id: string; shopId: string; onDone: (result: DisputeTriggerResult) => void; onClose: () => void }) {
  const detail = useAsync(() => getDispute(id), [id]);
  const [editing, setEditing] = useState(false);
  return <section className="admin-dispute-detail" aria-label="Dispute detail">
    <div className="admin-dispute-form-bar"><strong>Dispute detail</strong><button aria-label="Close dispute detail" onClick={onClose}><X size={15} /></button></div>
    <AsyncState {...detail} onRetry={detail.reload}>{(record) => record.shopId !== shopId ? <div className="state state-error" role="alert">This dispute belongs to another shop.</div> : <>
      <dl className="admin-dispute-facts">{[['Dispute ID', record.disputeId], ['Order ID', record.orderId], ['Return ID', record.returnId ?? '—'], ['Status', disputeLabel(record.status)], ['Created', date(record.createdAt)], ['Updated', date(record.updatedAt)], ['Reason', record.reason ?? '—']].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {record.compensation && <details><summary>Compensation</summary><pre>{JSON.stringify(record.compensation, null, 2)}</pre></details>}
      {record.adjustment && <details><summary>Adjustment</summary><pre>{JSON.stringify(record.adjustment, null, 2)}</pre></details>}
      {record.status === 'DISPUTE_PENDING_REVIEW' && !editing && <button onClick={() => setEditing(true)}>Update status</button>}
      {editing && record.status === 'DISPUTE_PENDING_REVIEW' && <DisputeForm shopId={shopId} record={record} onClose={() => setEditing(false)} onDone={(result) => { setEditing(false); detail.reload(); onDone(result); }} />}
    </>}</AsyncState>
  </section>;
}

export function DisputesPanel({ shopId }: { shopId: string }) {
  const list = useAsync(listDisputes, [], 5000);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState('');
  const [result, setResult] = useState<DisputeTriggerResult>();
  const items = (list.data?.disputes ?? []).filter((r) => r.shopId === shopId && (!status || r.status === status) && `${r.disputeId} ${r.orderId} ${r.returnId ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  function done(value: DisputeTriggerResult) { setResult(value); setCreating(false); list.reload(); }
  return <div className="admin-disputes">
    <div className="admin-log-filters"><label>Search disputes<input placeholder="Dispute, order or return ID" value={query} onChange={(e) => setQuery(e.target.value)} /></label><label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{disputeStatuses.map((s) => <option key={s} value={s}>{disputeLabel(s)}</option>)}</select></label><button className="admin-icon-action" onClick={list.reload}><RefreshCw size={14} />Refresh</button><button className="admin-primary admin-icon-action" disabled={!shopId} aria-expanded={creating} onClick={() => { setCreating(!creating); setSelected(''); setResult(undefined); }}><Plus size={14} />New dispute</button></div>
    {result && <div className="admin-dispute-result" role="status"><strong>{result.dispute_id} · {disputeLabel(result.dispute_status)}</strong>{result.dispute_status === 'DISPUTE_APPROVED' && <span>Webhook queued: {result.webhook_enqueued ? 'Yes' : 'No'} · Direct delivery: {result.webhook_sent ? 'Sent' : 'Not sent'}{result.target_url ? ` · ${result.target_url}` : ''}</span>}</div>}
    {creating && <DisputeForm shopId={shopId} onDone={done} onClose={() => setCreating(false)} />}
    {list.error && list.data && <div role="alert" className="state state-error">Refresh failed: {list.error.message}<button onClick={list.reload}>Retry</button></div>}
    <AsyncState {...list} onRetry={list.reload}>{() => items.length === 0 ? <div className="state state-empty">No disputes match this shop and filters.</div> : <PaginatedList key={`${query}:${status}`} items={items} label="Disputes">{(rows) => <div className="scroll"><table className="admin-data-table"><thead><tr><th>Dispute / Order</th><th>Status</th><th>Compensation</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{rows.map((r) => <tr key={r.disputeId}><td><strong>{r.disputeId}</strong><small className="admin-dispute-order">{r.orderId}</small></td><td><span className="pill" data-tone={tone(r.status)}>{disputeLabel(r.status)}</span></td><td>{r.compensation ? `${r.compensation.amount.toLocaleString()} ${r.compensation.currency}` : '—'}</td><td>{date(r.updatedAt)}</td><td><button aria-label={`View dispute ${r.disputeId}`} onClick={() => { setSelected(r.disputeId); setCreating(false); }}>View details</button></td></tr>)}</tbody></table></div>}</PaginatedList>}</AsyncState>
    {selected && <DisputeDetail key={selected} id={selected} shopId={shopId} onDone={done} onClose={() => setSelected('')} />}
  </div>;
}
