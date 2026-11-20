import { Fragment, useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import type { HttpLog } from './types';
import { PaginatedList } from '../../components/console/PaginatedList';

export function HttpLogPanel({ shopId }: { shopId: string }) {
  const [requestId, setRequestId] = useState('');
  const [router, setRouter] = useState('');
  const [onlyShop, setOnlyShop] = useState(false);
  const [open, setOpen] = useState<string>();
  const qs = new URLSearchParams();
  if (requestId.trim()) qs.set('requestId', requestId.trim());
  if (router) qs.set('router', router);
  if (onlyShop && shopId) qs.set('shopId', shopId);
  const logs = useAsync(() => api<{ items: HttpLog[] }>(`/test-admin/http-logs?${qs.toString()}`), [qs.toString()], 5000);

  return (
    <div>
      <div className="admin-log-filters">
        <label>Request ID <input value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="x-request-id" aria-label="Request ID filter" /></label>
        <label>Router{' '}
          <select value={router} onChange={(e) => setRouter(e.target.value)}>
            <option value="">all</option><option value="TIKTOK">TikTok</option><option value="DEMO">Demo</option><option value="TEST_ADMIN">Test admin</option>
          </select>
        </label>
        <label className="admin-check"><input type="checkbox" checked={onlyShop} onChange={(e) => setOnlyShop(e.target.checked)} /> selected shop only</label>
        <button onClick={logs.reload}>Refresh</button>
      </div>
      <p className="muted">Tokens, secrets and signatures are redacted before storage. Pagination applies to the records returned by the API.</p>
      <AsyncState {...logs} onRetry={logs.reload} isEmpty={(d) => d.items.length === 0} emptyText="No requests logged yet for this filter.">
        {(d) => (
          <PaginatedList key={qs.toString()} items={d.items} label="Requests">{(visible) => <div className="scroll">
            <table className="admin-log-table">
              <thead><tr><th>Time</th><th>Router</th><th>Method</th><th>Path</th><th>Status</th><th>ms</th><th>Request ID</th></tr></thead>
              <tbody>
                {visible.map((l) => (
                  <Fragment key={l.id}>
                    <tr onClick={() => setOpen(open === l.id ? undefined : l.id)} className="clickable">
                      <td>{new Date(l.createdAt).toLocaleTimeString()}</td><td>{l.router}</td><td>{l.method}</td><td>{l.path}</td>
                      <td><span className={`pill ${l.responseStatus < 400 ? 'ok' : 'bad'}`}>{l.responseStatus}</span></td><td>{l.durationMs}</td>
                      <td><a href="#filter" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setRequestId(l.requestId); }}>{l.requestId}</a></td>
                    </tr>
                    {open === l.id ? (
                      <tr><td colSpan={7}><pre>{JSON.stringify({ query: l.query, requestHeaders: l.requestHeaders, requestBody: l.requestBody, responseHeaders: l.responseHeaders, responseBody: l.responseBody }, null, 2)}</pre></td></tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>}</PaginatedList>
        )}
      </AsyncState>
    </div>
  );
}
