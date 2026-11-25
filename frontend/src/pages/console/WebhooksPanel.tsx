import { Fragment, useState } from 'react';
import { ChevronDown, ChevronUp, Plus, RefreshCw, RotateCcw, X } from 'lucide-react';
import { PageActions } from '../../components/console/PageActions';
import { PaginatedList } from '../../components/console/PaginatedList';
import { statusTone } from '../../components/console/statusTone';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import type { WebhookJob } from './types';

export function WebhooksPanel({ shopId }: { shopId: string }) {
  const [requestId, setRequestId] = useState('');
  const [status, setStatus] = useState('');
  const [onlyShop, setOnlyShop] = useState(false);
  const [limit, setLimit] = useState('50');
  const [msg, setMsg] = useState<string>();
  const [topic, setTopic] = useState('SIMULATOR_TEST');
  const [targetUrl, setTargetUrl] = useState('http://host.docker.internal:9999/webhook');
  const [showComposer, setShowComposer] = useState(false);
  const [payloadText, setPayloadText] = useState('{ "note": "foundation test event" }');
  const [maxAttempts, setMaxAttempts] = useState('5');
  const [queuing, setQueuing] = useState(false);
  let payload: Record<string, unknown> | undefined;
  let payloadError = '';
  try {
    const value: unknown = JSON.parse(payloadText);
    if (!value || typeof value !== 'object' || Array.isArray(value)) payloadError = 'Payload must be a JSON object.';
    else payload = value as Record<string, unknown>;
  } catch { payloadError = 'Enter valid JSON for the payload.'; }
  const attemptsValid = /^\d+$/.test(maxAttempts) && Number(maxAttempts) >= 1 && Number(maxAttempts) <= 20;
  const canQueue = !!shopId && !!topic.trim() && topic.trim().length <= 100 && !!payload && attemptsValid && !queuing;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const statusLabels: Record<string, string> = { PENDING: 'Pending', IN_PROGRESS: 'In progress', SUCCEEDED: 'Succeeded', DEAD: 'Failed' };
  const qs = new URLSearchParams();
  if (requestId.trim()) qs.set('requestId', requestId.trim());
  if (status) qs.set('status', status);
  if (onlyShop && shopId) qs.set('shopId', shopId);
  qs.set('limit', limit);
  const jobs = useAsync(() => api<{ items: WebhookJob[] }>(`/test-admin/webhooks?${qs.toString()}`), [qs.toString()], 3000);

  const replay = async (id: string) => {
    try {
      await api(`/test-admin/webhooks/${id}/replay`, { method: 'POST' });
      setMsg('Replay queued.');
      jobs.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const enqueue = async () => {
    if (!canQueue) return;
    setQueuing(true);
    try {
      await api('/test-admin/webhooks', { method: 'POST', body: { shopId, topic: topic.trim(), targetUrl, payload, maxAttempts: Number(maxAttempts) } });
      setMsg('Test webhook queued. Manually queued events are unsigned; use a subscribed business event to test signed deliveries.');
      jobs.reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setQueuing(false);
    }
  };

  return (
    <div>
      {showComposer && <section className="card admin-webhook-composer" id="webhook-composer" aria-label="Queue a test webhook">
        <div className="admin-webhook-composer-heading"><h3>Queue a test webhook</h3><button aria-label="Close webhook form" onClick={() => setShowComposer(false)}><X size={14} /></button></div>
        <form className="admin-webhook-form" onSubmit={(e) => { e.preventDefault(); void enqueue(); }}>
          <label>Topic<input required maxLength={100} disabled={queuing} value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
          <label>Target URL<input required type="url" pattern="https?://.*" disabled={queuing} value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} /></label>
          <label>Maximum attempts<input type="number" min={1} max={20} step={1} required disabled={queuing} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} /></label>
          <label className="admin-webhook-payload">Payload (JSON object)<textarea rows={5} disabled={queuing} value={payloadText} aria-invalid={!!payloadError} aria-describedby={payloadError ? 'webhook-payload-error' : undefined} onChange={(e) => setPayloadText(e.target.value)} /></label>
          {payloadError && <p id="webhook-payload-error" role="alert">{payloadError}</p>}
          {!attemptsValid && <p role="alert">Maximum attempts must be a whole number from 1 to 20.</p>}
          <button className="admin-primary admin-icon-action" disabled={!canQueue}><Plus size={14} />{queuing ? 'Queuing…' : 'Queue'}</button>
        </form>
      </section>}
      <div className="admin-log-filters admin-webhook-filters">
        <label>Request ID <input value={requestId} onChange={(e) => setRequestId(e.target.value)} aria-label="Request ID filter" /></label>
        <label>Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'DEAD'].map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
          </select>
        </label>
        <label className="admin-check"><input type="checkbox" checked={onlyShop} onChange={(e) => setOnlyShop(e.target.checked)} /> selected shop only</label>
        <label>Latest jobs to load<select value={limit} onChange={(e) => setLimit(e.target.value)}>{['25', '50', '100', '200'].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <button className="admin-icon-action" onClick={jobs.reload}><RefreshCw size={13} />Refresh</button>
      <PageActions>
        <button className="admin-primary admin-icon-action" onClick={() => setShowComposer((open) => !open)} aria-expanded={showComposer} aria-controls="webhook-composer"><Plus size={14} />Queue webhook</button>
      </PageActions>
      </div>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <p className="muted">Showing up to {limit} newest matching jobs. Pages divide the loaded jobs; older jobs are outside this view.</p>
      <AsyncState {...jobs} onRetry={jobs.reload} isEmpty={(d) => d.items.length === 0} emptyText="No webhook jobs for this filter.">
        {(d) => (
          <PaginatedList key={qs.toString()} items={d.items} label="Webhooks">
            {(visible) => <div className="scroll">
            <table className="admin-webhooks-table">
              <thead><tr><th>Created</th><th>Topic</th><th>Status</th><th>Attempts</th><th>Next retry</th><th>Request ID</th><th>Actions</th></tr></thead>
              <tbody>
                {visible.map((j) => (
                  <Fragment key={j.id}>
                    <tr>
                      <td className="admin-webhook-time">{new Date(j.createdAt).toLocaleDateString()}<small>{new Date(j.createdAt).toLocaleTimeString()}</small></td><td>{j.topic}{j.replayOfId && <small>Replay</small>}</td>
                      <td><span className="pill" data-tone={statusTone(j.status)} title={j.status}>{statusLabels[j.status] ?? j.status}</span></td>
                      <td>{j.attemptCount}/{j.maxAttempts}</td><td>{j.status === 'PENDING' ? new Date(j.nextAttemptAt).toLocaleTimeString() : '-'}</td>
                      <td>{j.requestId ? <a className="admin-webhook-request" href="#filter" title={j.requestId} onClick={(e) => { e.preventDefault(); if (j.requestId) setRequestId(j.requestId); }}>{j.requestId}</a> : '—'}</td>
                      <td><div className="admin-webhook-actions"><button className="admin-icon-action" onClick={() => replay(j.id)}><RotateCcw size={12} />Replay</button><button className="admin-icon-action" aria-label={`View attempts for ${j.id}`} aria-expanded={expandedId === j.id} aria-controls={`webhook-attempts-${j.id}`} onClick={() => setExpandedId(expandedId === j.id ? null : j.id)}>History{expandedId === j.id ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button></div></td>
                    </tr>
                    {expandedId === j.id && <tr><td colSpan={7}><div className="admin-webhook-history" id={`webhook-attempts-${j.id}`}>
                      <h4>Delivery history</h4>
                      {j.lastError && <p className="admin-error-text">{j.lastError}</p>}
                      {!j.attempts.length && <p>No delivery attempts yet.</p>}
                      {j.attempts.map((a) => (
                        <p key={a.id}>
                          #{a.attemptNo} {a.status} {a.httpStatus ?? ''} by {a.workerId}
                          {a.deliveries > 1 ? ` / ${a.deliveries} deliveries (duplicate)` : ''}
                          {a.possibleDuplicate ? ' / possible duplicate (previous attempt abandoned)' : ''}
                          {a.lateCompletion ? ' / late completion (lease lost)' : ''}
                          {a.error ? ` / ${a.error}` : ''}
                        </p>
                      ))}
                    </div></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>}
          </PaginatedList>
        )}
      </AsyncState>
    </div>
  );
}
