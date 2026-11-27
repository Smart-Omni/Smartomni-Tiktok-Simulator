import { PaginatedList } from '../../components/console/PaginatedList';
import { useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { statusTone } from '../../components/console/statusTone';
import { PageActions } from '../../components/console/PageActions';

interface TokenView {
  id: string;
  appKey: string;
  shopName: string;
  scopes: string[];
  status: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  accessExpired: boolean;
  refreshExpired: boolean;
  revokedAt: string | null;
}

/** Authorization state of the selected shop. Only metadata: token values and hashes are never available here. */
export function TokensPanel({ shopId }: { shopId: string }) {
  const tokens = useAsync(() => api<{ items: TokenView[] }>(`/test-admin/tokens?shopId=${encodeURIComponent(shopId)}`), [shopId], 5000);
  const [msg, setMsg] = useState<string>();

  const act = async (path: string, body?: unknown) => {
    try {
      await api(path, { method: 'POST', body: body ?? {} });
      setMsg(undefined);
      tokens.reload();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div>
      {msg ? <div className="state state-error" role="alert">{msg}</div> : null}
      <PageActions>
        <button data-tone="warning" disabled={!shopId} onClick={() => void act('/test-admin/authorization-codes/expire', { shopId })}>Expire unused authorization codes</button>
      </PageActions>
      <AsyncState {...tokens} onRetry={tokens.reload} isEmpty={(d) => d.items.length === 0} emptyText="No authorization for this shop.">
        {(d) => (
          <PaginatedList items={d.items} label="Authorizations" initialPageSize={5}>{(visible) => <div>
            {visible.map((t) => (
              <article key={t.id} className="card">
                <h3>{t.appKey} <span className="pill" data-tone={statusTone(t.status)}>{t.status}</span></h3>
                <div className="muted">
                  Access token {t.accessExpired ? 'EXPIRED' : 'expires'} {new Date(t.accessExpiresAt).toLocaleString()} / refresh token {t.refreshExpired ? 'EXPIRED' : 'expires'} {new Date(t.refreshExpiresAt).toLocaleString()}
                  {t.revokedAt ? ` / revoked ${new Date(t.revokedAt).toLocaleString()}` : ''}
                </div>

                <div className="admin-token-actions">
                  <button data-tone="warning" disabled={t.status !== 'ACTIVE'} onClick={() => void act(`/test-admin/tokens/${t.id}/expire-access`)}>Expire access token</button>
                  <button data-tone="warning" disabled={t.status !== 'ACTIVE'} onClick={() => void act(`/test-admin/tokens/${t.id}/expire-refresh`)}>Expire refresh token</button>
                  <button data-tone="danger" disabled={t.status !== 'ACTIVE'} onClick={() => { if (window.confirm('Revoke this authorization? SmartOmni must authorize the shop again.')) void act(`/test-admin/tokens/${t.id}/revoke`); }}>Revoke authorization</button>
                </div>
                <details className="admin-token-scopes"><summary>Granted scopes ({t.scopes.length})</summary><div className="admin-scope-grid">
                  {t.scopes.map((s) => (
                    <button data-tone="danger" key={s} onClick={() => void act(`/test-admin/tokens/${t.id}/remove-scope`, { scope: s })}>Remove {s}</button>
                  ))}
                </div></details>
              </article>
            ))}
          </div>}</PaginatedList>
        )}
      </AsyncState>
    </div>
  );
}
