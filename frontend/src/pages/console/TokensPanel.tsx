import { useState } from 'react';
import { AsyncState } from '../../components/AsyncState';
import { api } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { statusTone } from '../../components/console/statusTone';

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
      <p className="muted">Test faults for the SmartOmni connection: expire a token, revoke the authorization, or remove one granted scope. SmartOmni sees the effect on its next API call.</p>
      {msg ? <div className="state state-error" role="alert">{msg}</div> : null}
      <div className="row-wrap">
        <button data-tone="warning" disabled={!shopId} onClick={() => void act('/test-admin/authorization-codes/expire', { shopId })}>Expire unused authorization codes</button>
      </div>
      <AsyncState {...tokens} onRetry={tokens.reload} isEmpty={(d) => d.items.length === 0} emptyText="No authorization for this shop yet. Connect it from SmartOmni (consent page: /seller/authorize).">
        {(d) => (
          <div>
            {d.items.map((t) => (
              <article key={t.id} className="card">
                <h3>{t.appKey} <span className="pill" data-tone={statusTone(t.status)}>{t.status}</span></h3>
                <div className="muted">
                  Access token {t.accessExpired ? 'EXPIRED' : 'expires'} {new Date(t.accessExpiresAt).toLocaleString()} / refresh token {t.refreshExpired ? 'EXPIRED' : 'expires'} {new Date(t.refreshExpiresAt).toLocaleString()}
                  {t.revokedAt ? ` / revoked ${new Date(t.revokedAt).toLocaleString()}` : ''}
                </div>
                <div className="muted">Granted scopes: {t.scopes.length === 0 ? '(none)' : t.scopes.join(', ')}</div>
                <div className="row-wrap">
                  <button data-tone="warning" disabled={t.status !== 'ACTIVE'} onClick={() => void act(`/test-admin/tokens/${t.id}/expire-access`)}>Expire access token</button>
                  <button data-tone="warning" disabled={t.status !== 'ACTIVE'} onClick={() => void act(`/test-admin/tokens/${t.id}/expire-refresh`)}>Expire refresh token</button>
                  <button data-tone="danger" disabled={t.status !== 'ACTIVE'} onClick={() => void act(`/test-admin/tokens/${t.id}/revoke`)}>Revoke authorization</button>
                  {t.scopes.map((s) => (
                    <button data-tone="danger" key={s} onClick={() => void act(`/test-admin/tokens/${t.id}/remove-scope`, { scope: s })}>Remove {s}</button>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </AsyncState>
    </div>
  );
}
