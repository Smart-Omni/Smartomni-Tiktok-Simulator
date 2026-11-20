import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ShoppingBag, Star, Truck } from 'lucide-react';
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

function Illustration() {
  return (
    <div className="relative hidden min-h-[440px] flex-col items-center justify-center gap-6 bg-buyer-soft p-10 md:flex" aria-hidden>
      <div className="flex size-36 items-center justify-center rounded-full bg-white shadow-sm">
        <ShoppingBag className="size-16 text-buyer" strokeWidth={1.5} />
      </div>
      <div className="absolute left-10 top-16 flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-free-ship shadow-sm">
        <Truck className="size-3.5" /> Free shipping
      </div>
      <div className="absolute bottom-24 right-10 flex items-center gap-1 rounded-full bg-white px-3 py-1.5 text-xs font-semibold shadow-sm">
        <Star className="size-3.5 fill-star text-star" /> 4.8
      </div>
      <p className="max-w-[260px] text-center text-sm text-buyer-ink">Shop from every demo shop. Everything here is fake data.</p>
    </div>
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
    <RadioGroup value={value} onValueChange={onChange} aria-label={role === 'BUYER' ? 'Buyer accounts' : 'Seller accounts'} className="gap-2">
      {accounts.map((a) => {
        const id = `account-${a.key}`;
        return (
          <label
            key={a.key}
            htmlFor={id}
            className="flex cursor-pointer items-center gap-3 rounded-xl border border-line px-3 py-2.5 transition-colors hover:bg-surface-2 has-[[data-state=checked]]:border-buyer has-[[data-state=checked]]:bg-buyer-soft"
          >
            <RadioGroupItem id={id} value={a.key} />
            <Avatar className="size-9">
              <AvatarFallback className={role === 'BUYER' ? 'bg-buyer text-white' : 'bg-teal text-white'}>{a.name.charAt(0).toUpperCase()}</AvatarFallback>
            </Avatar>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-ink">{a.name}</span>
              {a.detail ? <span className="truncate text-xs text-muted-foreground">{a.detail}</span> : null}
            </span>
          </label>
        );
      })}
    </RadioGroup>
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
    <div className="min-h-screen bg-surface-2 font-sans text-[15px] text-ink">
      <header className="flex h-14 items-center bg-ink px-5 text-white">
        <Link to="/" className="flex items-center gap-2.5 font-bold">
          <span className="flex size-8 items-center justify-center rounded-[9px] bg-white text-ink">t</span>
          Tiptop Shop
        </Link>
        <span className="mx-3 h-5 w-px bg-white/30" aria-hidden />
        <span className="font-semibold">Sign in</span>
        <Link to="/" className="ml-auto flex items-center gap-1.5 text-sm text-white/80 hover:text-white">
          <ArrowLeft className="size-4" /> Back to shopping
        </Link>
      </header>

      <main className="mx-auto max-w-[960px] px-4 py-8">
        {next ? (
          <div className="mb-5 rounded-card border border-buyer/20 bg-buyer-soft px-4 py-3 text-sm text-buyer-ink">
            {next.startsWith('/product/') ? 'Sign in to buy.' : 'Sign in to continue.'} You will return to{' '}
            <strong className="font-semibold">{nextLabel(next)}</strong> after signing in.
          </div>
        ) : null}

        <div className="grid overflow-hidden rounded-card border border-line-soft bg-white shadow-sm md:grid-cols-2">
          <Illustration />
          <section className="flex flex-col p-6 md:p-8">
            <h1 className="text-2xl font-bold tracking-tight">Sign in to Tiptop Shop</h1>
            <p className="mt-1 text-sm text-muted-foreground">Choose a demo account to continue.</p>

            <Tabs value={tab} onValueChange={(v) => setTab(v as Role)} className="mt-5 gap-4">
              <TabsList className="w-full">
                <TabsTrigger value="BUYER">Buyer</TabsTrigger>
                <TabsTrigger value="SELLER">Seller</TabsTrigger>
              </TabsList>
              {(['BUYER', 'SELLER'] as const).map((role) => (
                <TabsContent key={role} value={role} className="min-h-[148px]">
                  {ids.loading && !ids.data ? (
                    <div className="flex flex-col gap-2" role="status" aria-label="Loading accounts">
                      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[58px] rounded-xl" />)}
                    </div>
                  ) : ids.error && !ids.data ? (
                    <Alert variant="destructive">
                      <AlertDescription>
                        <p>Could not load demo accounts: {ids.error.message}</p>
                        <Button variant="outline" size="sm" className="mt-1" onClick={ids.reload}>
                          Try again
                        </Button>
                      </AlertDescription>
                    </Alert>
                  ) : (
                    <AccountList role={role} accounts={accounts[role]} value={selectedKey} onChange={(k) => setPicked((p) => ({ ...p, [role]: k }))} />
                  )}
                </TabsContent>
              ))}
            </Tabs>

            <p className="mt-4 text-xs text-muted-2">No password. A buyer can browse and buy from every shop.</p>

            {error ? (
              <Alert variant="destructive" className="mt-3">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Button size="lg" className="mt-4 h-11 w-full bg-buyer text-white hover:bg-buyer/90" disabled={!selected || busy} onClick={submit}>
              {busy ? 'Signing in...' : selected ? `Sign in as ${selected.name}` : 'Sign in'}
            </Button>
            <Link to="/" className="mt-3 text-center text-sm font-semibold text-muted-foreground hover:text-ink">
              Continue browsing as guest
            </Link>
          </section>
        </div>
      </main>
    </div>
  );
}
