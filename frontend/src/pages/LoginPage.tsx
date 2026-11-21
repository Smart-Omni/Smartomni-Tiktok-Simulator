import { useEffect, useRef, useState } from 'react';
import '@/signin.css';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Loader2, MessageCircle, ShieldCheck, ShoppingBag, Store } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { getIdentities } from '@/lib/endpoints';
import type { Identities, Role, SignInIdentity } from '@/lib/types';
import { useAsync } from '@/lib/useAsync';
import { defaultBuyerName, defaultMockShop, identityCity, mockCatalog, normalizeTitle } from '@/mocks';

interface Account {
  key: string;
  name: string;
  detail: string;
  identity: SignInIdentity;
}

/** Only same-origin paths are accepted as ?next (no "//host" or absolute URLs). */
export function safeNext(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  return next;
}

/** Where to go after signing in: buyers back to `next`, sellers to Seller Center (or `next` inside it). */
export function destination(role: Role, next: string | null): string {
  const inSellerCenter = next?.startsWith('/seller-center') ?? false;
  if (role === 'SELLER') return next && inSellerCenter ? next : '/seller-center';
  return next && !inSellerCenter && !next.startsWith('/login') ? next : '/';
}

function nextLabel(next: string): string {
  const product = /^\/product\/([^/?#]+)/.exec(next);
  if (product) return mockCatalog.find((p) => p.id === decodeURIComponent(product[1]))?.title ?? 'this product';
  if (next.startsWith('/cart')) return 'your cart';
  if (next.startsWith('/checkout')) return 'checkout';
  if (next.startsWith('/account')) return 'your orders';
  if (next.startsWith('/seller-center')) return 'Seller Center';
  return 'the page you were on';
}

/**
 * Buyer to preselect: for a mock product in `next`, the first buyer of the seed shop that sells it
 * (so the product page can open the real product); otherwise the default demo buyer.
 */
export function preferredBuyerId(ids: Identities, next: string | null): string | undefined {
  const productId = next ? /^\/product\/([^/?#]+)/.exec(next)?.[1] : undefined;
  const mock = productId ? mockCatalog.find((p) => p.id === decodeURIComponent(productId)) : undefined;
  if (mock) {
    const wanted = normalizeTitle(mock.seedShop ?? defaultMockShop);
    const shop = ids.sellers.flatMap((s) => s.shops).find((x) => normalizeTitle(x.name) === wanted);
    const buyer = shop && ids.buyers.find((b) => b.shopId === shop.id);
    if (buyer) return buyer.id;
  }
  return ids.buyers.find((b) => normalizeTitle(b.name) === normalizeTitle(defaultBuyerName))?.id;
}

function toAccounts(ids: Identities): Record<Role, Account[]> {
  const detail = (shop: string, name: string) => [shop, identityCity(name)].filter(Boolean).join(' · ');
  return {
    BUYER: ids.buyers.map((b) => ({
      key: `buyer:${b.id}`,
      name: b.name,
      detail: detail('', b.name),
      identity: { role: 'BUYER', buyerId: b.id },
    })),
    SELLER: ids.sellers.map((s) => ({
      key: `seller:${s.id}`,
      name: s.name,
      detail: detail(s.shops.map((x) => x.name).join(', '), s.name),
      identity: { role: 'SELLER', sellerId: s.id },
    })),
  };
}

function SignInBrand() {
  return (
    <aside className="signin-brand-panel">
      <Link to="/" className="signin-brand"><ShieldCheck size={27} /><span>TikTok<small>SHOP SIMULATOR</small></span></Link>
      <div className="signin-brand-content">
        <div className="signin-brand-art" aria-hidden="true"><span><ShoppingBag size={35} strokeWidth={1.25} /></span><span><Store size={35} strokeWidth={1.25} /></span><span><MessageCircle size={35} strokeWidth={1.25} /></span></div>
        <h2>Shop. Sell.<br /><span>Stay connected.</span></h2>
        <div className="signin-workspaces"><span><ShoppingBag size={15} /> Buyer workspace</span><span><Store size={15} /> Seller workspace</span></div>
      </div>
      <div className="signin-brand-footer"><span>TikTok Shop Simulator</span><span>One connected experience</span></div>
    </aside>
  );
}

function AccountList({
  role,
  accounts,
  value,
  onChange,
}: {
  role: Role;
  accounts: Account[];
  value: string | undefined;
  onChange: (key: string) => void;
}) {
  const accountList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    accountList.current?.querySelector('[data-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
  }, [value]);
  if (accounts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line p-5 text-center text-sm">
        <p className="text-muted-foreground">No {role === 'BUYER' ? 'buyer' : 'seller'} accounts yet.</p>
        <Link to="/console" className="mt-1 inline-block font-semibold text-buyer hover:underline">
          Open Test Console and run Seed
        </Link>
      </div>
    );
  }
  return (
    <div ref={accountList} className="signin-accounts"><RadioGroup value={value} onValueChange={onChange} aria-label={role === 'BUYER' ? 'Buyer accounts' : 'Seller accounts'}>
      {accounts.map((a) => {
        const id = `account-${a.key}`;
        return (
          <label
            key={a.key}
            data-selected={a.key === value}
            htmlFor={id}
            className="signin-account"
          >
            <Avatar className="size-9">
              <AvatarFallback className="signin-account-avatar">{a.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="signin-account-info">
              <span className="truncate text-sm font-semibold text-ink">{a.name}</span>
              {a.detail ? <span className="truncate text-xs text-muted-foreground">{a.detail}</span> : null}
            </span>
            <RadioGroupItem id={id} value={a.key} />
          </label>
        );
      })}
    </RadioGroup></div>
  );
}

export function LoginPage() {
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [tab, setTab] = useState<Role>(params.get('role') === 'seller' ? 'SELLER' : 'BUYER');
  const [picked, setPicked] = useState<Partial<Record<Role, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = useAsync(getIdentities, []);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const accounts = ids.data ? toAccounts(ids.data) : { BUYER: [], SELLER: [] };
  const preferred = ids.data ? preferredBuyerId(ids.data, next) : undefined;
  const fallback = tab === 'BUYER' && preferred ? `buyer:${preferred}` : accounts[tab][0]?.key;
  const selectedKey = picked[tab] ?? fallback;
  const selected = accounts[tab].find((a) => a.key === selectedKey);

  const submit = async () => {
    if (!selected) return;
    setBusy(true);
    setError(undefined);
    try {
      const s = await signIn(selected.identity);
      navigate(destination(s.role, next), { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="signin-page theme-seller font-sans">
      <main className="signin-main">
        <SignInBrand />
        <section className="signin-form-panel">
          <div className="signin-form-content">
            <header className="signin-heading"><span>WELCOME BACK</span><h1>Sign in</h1><p>Choose your workspace and account.</p></header>
            {next ? (
              <div className="signin-destination">
                {next.startsWith('/product/') ? 'Sign in to buy.' : 'Sign in to continue.'} You will return to{' '}
                <strong>{nextLabel(next)}</strong> after signing in.
              </div>
            ) : null}
            <Tabs value={tab} onValueChange={(v) => { setTab(v as Role); setError(undefined); }} className="signin-tabs">
              <TabsList className="signin-roles">
                <TabsTrigger value="BUYER"><ShoppingBag size={16} /> Buyer</TabsTrigger>
                <TabsTrigger value="SELLER"><Store size={16} /> Seller</TabsTrigger>
              </TabsList>
              {(['BUYER', 'SELLER'] as const).map((role) => (
                <TabsContent key={role} value={role} className="signin-account-panel">
                  <div className="signin-account-label"><span>Select account</span>{ids.data && <span>{accounts[role].length} available</span>}</div>
                  {ids.loading && !ids.data ? (
                    <div className="flex flex-col gap-2" role="status" aria-label="Loading accounts">
                      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[62px] rounded-xl" />)}
                    </div>
                  ) : ids.error && !ids.data ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        <p>Could not load demo accounts: {ids.error.message}</p>
                        <Button variant="outline" size="sm" className="mt-1" onClick={ids.reload}>Try again</Button>
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <AccountList role={role} accounts={accounts[role]} value={selectedKey} onChange={(k) => setPicked((p) => ({ ...p, [role]: k }))} />
                  )}
                </TabsContent>
              ))}
            </Tabs>
            {error ? <Alert variant="destructive" className="mt-3"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Button className="signin-submit" disabled={!selected || busy} onClick={submit}>
              <span>{busy ? 'Signing in...' : selected ? `Sign in as ${selected.name}` : 'Sign in'}</span>{busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
            </Button>
            <Link to="/" className="signin-guest">Continue browsing as guest<ArrowRight size={13} /></Link>
          </div>
          <div className="signin-form-footer"><ShieldCheck size={13} /><span>Demo accounts · No password required</span></div>
        </section>
      </main>
    </div>
  );
}
