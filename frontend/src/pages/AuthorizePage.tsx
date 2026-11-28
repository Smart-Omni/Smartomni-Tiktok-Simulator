import { useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowRightLeft, Check, ChevronDown, Link2, LockKeyhole, ShoppingBag, Store } from 'lucide-react';
import '../authorize.css';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState';
import { loginUrl } from '../components/RequireRole';
import { api, ApiError } from '../lib/api';
import { forgetSharedSeller, sharedSeller } from '../lib/session';
import { useAsync } from '../lib/useAsync';

interface Consent {
  app: { appKey: string; name: string };
  shop: { id: string; name: string; region: string; currency: string };
  scopes: string[];
  redirectUri: string;
  state: string | null;
}

const permissionNames: Record<string, string> = {
  authorized_shops: 'Connected shops', product: 'Products', order: 'Orders',
  event: 'Webhooks & events', inventory: 'Inventory', conversation: 'Customer messages',
  fulfillment: 'Shipping & fulfillment', promotion: 'Promotions', aftersale: 'Returns & refunds',
};

function Permissions({ scopes }: { scopes: string[] }) {
  const groups = new Map<string, { title: string; actions: Set<string> }>();
  for (const scope of scopes) {
    const [, resource, action] = /^sim\.([^.]+)\.(read|write|manage)$/.exec(scope) ?? [];
    const key = resource && permissionNames[resource] ? resource : scope;
    const group = groups.get(key) ?? { title: permissionNames[key] ?? scope, actions: new Set<string>() };
    if (action && permissionNames[key]) group.actions.add(action === 'read' ? 'View' : action === 'write' ? 'Edit' : 'Manage');
    groups.set(key, group);
  }
  return <>
    <ul className="consent-permissions">{[...groups].map(([key, group]) => <li key={key}>
      <span className="consent-check"><Check size={14} aria-hidden="true" /></span>
      <div><strong>{group.title}</strong><span>{[...group.actions].join(' & ') || 'Requested permission'}</span></div>
    </li>)}</ul>
    {scopes.length > 0 && <details className="consent-scope-details"><summary>View permission identifiers <ChevronDown size={14} aria-hidden="true" /></summary><ul>{scopes.map(scope => <li key={scope}><code>{scope}</code></li>)}</ul></details>}
  </>;
}

/**
 * Seller consent page (simulator-defined URL: /seller/authorize?app_key=&state=[&redirect_uri=]). The real TikTok
 * authorization URL is unsupported in the contract. Only the shop of the signed-in seller can be authorized. The browser never builds the redirect: the API returns the URL
 * (registered redirect URI only, code/error plus the echoed state) and this page just navigates to it.
 */
export function AuthorizePage({ navigate = (url: string) => window.location.assign(url) }: { navigate?: (url: string) => void }) {
  const [params] = useSearchParams();
  const location = useLocation();
  const [session] = useState(sharedSeller);
  const appKey = params.get('app_key') ?? '';
  if (!appKey) return <div className="state state-error" role="alert">Missing app_key. Start the connection from SmartOmni.</div>;
  const signInUrl = loginUrl(location.pathname + location.search, 'SELLER');
  if (!session) return <Navigate to={signInUrl} replace />;
  return (
    <Consent
      sessionToken={session.sessionToken}
      signInUrl={signInUrl}
      appKey={appKey}
      state={params.get('state') ?? undefined}
      redirectUri={params.get('redirect_uri') ?? undefined}
      navigate={navigate}
    />
  );
}

function Consent(props: { sessionToken: string; signInUrl: string; appKey: string; state?: string; redirectUri?: string; navigate: (url: string) => void }) {
  const { sessionToken, appKey, state, redirectUri, navigate } = props;
  const query = new URLSearchParams({ app_key: appKey });
  if (state) query.set('state', state);
  if (redirectUri) query.set('redirect_uri', redirectUri);
  const [expired, setExpired] = useState(false);
  /** A rejected session means nobody is signed in any more. */
  const onError = (e: unknown): never => {
    if (e instanceof ApiError && e.status === 401) {
      forgetSharedSeller(sessionToken);
      setExpired(true);
    }
    throw e;
  };
  const ctx = useAsync(() => api<Consent>(`/demo/authorization/consent?${query.toString()}`, { demoSession: sessionToken }).catch(onError), [sessionToken, appKey, state, redirectUri]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  const decide = async (decision: 'accept' | 'deny') => {
    setBusy(true);
    setErr(undefined);
    try {
      const res = await api<{ redirectUrl: string }>('/demo/authorization/consent', {
        method: 'POST',
        demoSession: sessionToken,
        body: { app_key: appKey, state, redirect_uri: redirectUri, decision },
      }).catch(onError);
      navigate(res.redirectUrl);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  if (expired) return <Navigate to={props.signInUrl} replace />;

  return (
    <div className="consent-page">
      <header className="consent-topbar"><Link to="/seller-center" className="consent-brand"><ShoppingBag size={24} aria-hidden="true" /><span>TikTok Shop<small>SELLER AUTHORIZATION</small></span></Link><span className="consent-environment">Simulator environment</span></header>
      <div className="consent-heading"><span className="consent-eyebrow">CONNECT YOUR WORKSPACE</span><h1>One connection. More possibilities.</h1><p>Review the permissions below to connect your shop to SmartOmni.</p></div>
      {err ? <div className="state state-error" role="alert">{err}</div> : null}
      <AsyncState {...ctx} onRetry={ctx.reload}>
        {(d) => (
          <section className="consent-card" aria-label="Shop connection authorization">
            <aside className="consent-overview">
              <div className="consent-app-bridge" aria-hidden="true"><span className="consent-app-mark">S<span /></span><ArrowRightLeft size={20} /><span className="consent-shop-mark"><ShoppingBag size={30} /></span></div>
              <span className="consent-eyebrow">APP CONNECTION</span>
              <h2>Connect with<br />{d.app.name}</h2>
              <p>Bring your shop operations together in one workspace.</p>
              <div className="consent-shop"><span className="consent-store-icon"><Store size={20} aria-hidden="true" /></span><div><small>YOU ARE CONNECTING</small><strong>{d.shop.name}</strong><span>{d.shop.region} · {d.shop.currency}</span></div></div>
              <Link className="consent-switch" to={props.signInUrl}>Sign in as another seller <ArrowRight size={14} aria-hidden="true" /></Link>
              <div className="consent-overview-note"><Link2 size={16} aria-hidden="true" /><span>Access applies to the shop shown above.</span></div>
            </aside>
            <div className="consent-review">
              <div className="consent-section-heading"><span className="consent-step">01 / REVIEW ACCESS</span><LockKeyhole size={18} aria-hidden="true" /></div>
              <h2>You're in control.</h2>
              <p className="consent-intro">{d.app.name} wants to access your shop with the following permissions.</p>
              <h3>Requested permissions</h3>
              {d.scopes.length === 0 ? (
                <p className="muted">No scopes configured for this app.</p>
              ) : (
                <Permissions scopes={d.scopes} />
              )}
              <div className="consent-return"><ArrowRightLeft size={16} aria-hidden="true" /><div><strong>Return to SmartOmni</strong><p>After your decision, you will be redirected to:</p><code>{d.redirectUri}</code></div></div>
              <div className="consent-actions" aria-busy={busy}>
                <button className="consent-deny" disabled={busy} onClick={() => void decide('deny')}><ArrowLeft size={16} aria-hidden="true" />Deny</button>
                <button className="consent-accept" disabled={busy} onClick={() => void decide('accept')}>Authorize <ArrowRight size={16} aria-hidden="true" /></button>
              </div>
              {busy && <p className="consent-progress" role="status">Processing your decision…</p>}
            </div>
          </section>
        )}
      </AsyncState>
      <footer className="consent-footer"><LockKeyhole size={13} aria-hidden="true" /><span>Simulator only · Permission names are placeholders, not official TikTok Shop scopes.</span></footer>
    </div>
  );
}
