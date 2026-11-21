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
  const [msg, setMsg] = useState<string>();
  const [topic, setTopic] = useState('SIMULATOR_TEST');
  const [targetUrl, setTargetUrl] = useState('http://host.docker.internal:9999/webhook');
  const [showComposer, setShowComposer] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const statusLabels: Record<string, string> = { PENDING: 'Pending', IN_PROGRESS: 'In progress', SUCCEEDED: 'Succeeded', DEAD: 'Failed' };
  const qs = new URLSearchParams();
  if (requestId.trim()) qs.set('requestId', requestId.trim());
  if (status) qs.set('status', status);
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
    try {
      await api('/test-admin/webhooks', { method: 'POST', body: { shopId, topic, targetUrl, payload: { note: 'foundation test event' } } });
      setMsg('Test webhook queued (not a TikTok-format event; real events arrive in Phase 05).');
      jobs.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div>
      {showComposer && <section className="card admin-webhook-composer" id="webhook-composer" aria-label="Queue a test webhook">
        <div className="admin-webhook-composer-heading"><h3>Queue a test webhook</h3><button aria-label="Close webhook form" onClick={() => setShowComposer(false)}><X size={14} /></button></div>
        <div className="admin-webhook-form">
          <label>Topic<input value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
          <label>Target URL<input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} /></label>
          <button className="admin-primary admin-icon-action" disabled={!shopId} onClick={enqueue}><Plus size={14} />Queue</button>
        </div>
      </section>}
      <div className="admin-log-filters admin-webhook-filters">
        <label>Request ID <input value={requestId} onChange={(e) => setRequestId(e.target.value)} aria-label="Request ID filter" /></label>
        <label>Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'DEAD'].map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}
          </select>
        </label>
        <button className="admin-icon-action" onClick={jobs.reload}><RefreshCw size={13} />Refresh</button>
      <PageActions>
        <button className="admin-primary admin-icon-action" onClick={() => setShowComposer((open) => !open)} aria-expanded={showComposer} aria-controls="webhook-composer"><Plus size={14} />Queue webhook</button>
      </PageActions>
      </div>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
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
