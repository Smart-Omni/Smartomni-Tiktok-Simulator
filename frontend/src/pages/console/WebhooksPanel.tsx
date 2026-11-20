import { Fragment, useState } from 'react';
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
      <div className="row-wrap">
        <label>Request ID <input value={requestId} onChange={(e) => setRequestId(e.target.value)} aria-label="Request ID filter" /></label>
        <label>Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">all</option>{['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'DEAD'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <button onClick={jobs.reload}>Refresh</button>
      </div>
      <div className="card">
        <h3>Queue a test webhook</h3>
        <div className="row-wrap">
          <label>Topic <input value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
          <label>Target URL <input size={40} value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} /></label>
          <button disabled={!shopId} onClick={enqueue}>Queue</button>
        </div>
      </div>
      {msg ? <div className="state state-empty" role="status">{msg}</div> : null}
      <AsyncState {...jobs} onRetry={jobs.reload} isEmpty={(d) => d.items.length === 0} emptyText="No webhook jobs for this filter.">
        {(d) => (
          <div className="scroll">
            <table>
              <thead><tr><th>Created</th><th>Topic</th><th>Status</th><th>Attempts</th><th>Next</th><th>Request ID</th><th /></tr></thead>
              <tbody>
                {d.items.map((j) => (
                  <Fragment key={j.id}>
                    <tr>
                      <td>{new Date(j.createdAt).toLocaleTimeString()}</td><td>{j.topic}{j.replayOfId ? ' (replay)' : ''}</td>
                      <td><span className={`pill ${j.status === 'SUCCEEDED' ? 'ok' : j.status === 'DEAD' ? 'bad' : 'warn'}`}>{j.status}</span></td>
                      <td>{j.attemptCount}/{j.maxAttempts}</td><td>{j.status === 'PENDING' ? new Date(j.nextAttemptAt).toLocaleTimeString() : '-'}</td>
                      <td><a href="#filter" onClick={(e) => { e.preventDefault(); if (j.requestId) setRequestId(j.requestId); }}>{j.requestId ?? '-'}</a></td>
                      <td><button data-tone="info" onClick={() => replay(j.id)}>Replay</button></td>
                    </tr>
                    {j.attempts.map((a) => (
                      <tr key={a.id} className="attempt">
                        <td /><td colSpan={6}>
                          #{a.attemptNo} {a.status} {a.httpStatus ?? ''} by {a.workerId}
                          {a.deliveries > 1 ? ` / ${a.deliveries} deliveries (duplicate)` : ''}
                          {a.possibleDuplicate ? ' / possible duplicate (previous attempt abandoned)' : ''}
                          {a.lateCompletion ? ' / late completion (lease lost)' : ''}
                          {a.error ? ` / ${a.error}` : ''}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AsyncState>
    </div>
  );
}
