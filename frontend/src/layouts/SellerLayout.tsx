import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { ClipboardList, Headset, LayoutDashboard, Megaphone, Package, Store, ShieldCheck, ShoppingBag, ChevronRight, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import type { Identities } from '@/lib/types';
import { getIdentities } from '@/lib/endpoints';
import { useAsync } from '@/lib/useAsync';
import { cn } from '@/lib/utils';

interface MenuGroup {
  label: string;
  icon: LucideIcon;
  /** A group with `to` is a single link; otherwise it lists `items`. */
  to?: string;
  items?: { to: string; label: string }[];
}

const base = '/seller-center';
const menu: MenuGroup[] = [
  { label: 'Home', icon: LayoutDashboard, to: base },
  {
    label: 'Orders',
    icon: ClipboardList,
    items: [
      { to: `${base}/orders`, label: 'Manage orders' },
      { to: `${base}/returns`, label: 'Returns & refunds' },
    ],
  },
  { label: 'Products', icon: Package, to: `${base}/products` },
  { label: 'Marketing', icon: Megaphone, items: [{ to: `${base}/vouchers`, label: 'Vouchers' }] },
  { label: 'Customer service', icon: Headset, items: [{ to: `${base}/messages`, label: 'Messages' }] },
  { label: 'Shop', icon: Store, to: `${base}/shop` },
];

/** Same navigation hierarchy as the Console, using the existing Seller routes. */
function SideMenu() {
  const ref = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [pathname]);
  return <nav ref={ref} aria-label="Seller Center" className="seller-nav">
    {menu.map(({ label, icon: Icon, to, items }) => <div className="seller-nav-group" key={label}>
      <div className="seller-nav-group-label">{to === base ? 'Workspace' : label}</div>
      {(to ? [{ to, label }] : items ?? []).map((item) => <NavLink key={item.to} to={item.to} end={item.to === base} className={({ isActive }) => cn('seller-nav-link', isActive && 'is-active')}>
        <Icon size={16} aria-hidden="true" /><span>{item.label}</span><ChevronRight size={13} className="seller-nav-current" aria-hidden="true" />
      </NavLink>)}
    </div>)}
  </nav>;
}

type SellerIdentity = Identities['sellers'][number];

function ShopPicker({ owner }: { owner: SellerIdentity | undefined }) {
  const { seller, signIn } = useAuth();
  const [switching, setSwitching] = useState(false);
  const navigate = useNavigate();
  const shops = owner?.shops ?? [];
  const current = shops.find((x) => x.id === seller?.shopId);

  if (!owner || shops.length < 2) {
    return <span className="seller-shop-name">{current?.name ?? ''}</span>;
  }
  const change = async (shopId: string) => {
    setSwitching(true);
    try {
      await signIn({ role: 'SELLER', sellerId: owner.id, shopId });
      navigate(base);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };
  return (
    <Select value={seller?.shopId} onValueChange={change} disabled={switching}>
      <SelectTrigger aria-label="Shop" size="sm" className="seller-shop-select">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="theme-seller">
        {shops.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {s.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SellerMenu({ owner }: { owner: SellerIdentity | undefined }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const name = owner?.name ?? 'Seller';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Seller account menu" className="cursor-pointer rounded-full">
          <Avatar className="size-8">
            <AvatarFallback className="!bg-[#e8e8e8] text-xs font-semibold !text-[#333]">{name.charAt(0).toUpperCase()}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>{name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/">Go to Tiptop Shop</Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            await signOut('SELLER');
            navigate('/');
          }}
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What SellerLayout hands to the Seller Center pages (read with useSellerContext). */
export interface SellerContext {
  sellerName: string | undefined;
}

export const useSellerContext = () => useOutletContext<SellerContext>();

/** Seller workspace with independent content scrolling and Console styling. */
export function SellerLayout() {
  const { seller } = useAuth();
  const { pathname } = useLocation();
  const workspace = useRef<HTMLDivElement>(null);
  const ids = useAsync(getIdentities, []);
  const owner = ids.data?.sellers.find((s) => s.shops.some((x) => x.id === seller?.shopId));
  useEffect(() => { if (workspace.current) workspace.current.scrollTop = 0; }, [pathname]);
  return (
    <div className="seller-desktop-frame theme-seller font-sans">
      <div className="seller-shell">
        <aside className="seller-sidebar">
          <Link to={base} className="seller-sidebar-brand"><ShieldCheck size={25} /><span>TikTok<small>SHOP SIMULATOR</small></span></Link>
          <SideMenu />
          <div className="seller-sidebar-note"><Store size={15} /><span>Seller workspace</span></div>
        </aside>
        <div className="seller-workspace" ref={workspace}>
          <header className="seller-context-bar"><strong>Seller Center</strong><div className="seller-header-actions">
            <Link to="/" className="seller-role-link" aria-label="Open Tiptop Shop" title="Tiptop Shop"><ShoppingBag size={17} /></Link>
            <Link to="/console" className="seller-role-link" aria-label="Open Test Console" title="Test Console"><ShieldCheck size={17} /></Link>
            <SellerMenu owner={owner} />
          </div></header>
          <main className="seller-content">
            <section className="seller-shop-context" aria-label="Working shop"><div><Store size={17} /><span>Working shop<small>{owner?.name ?? (ids.loading ? 'Loading seller…' : 'Seller account')}</small></span></div><ShopPicker owner={owner} /></section>
            {ids.error && <div className="seller-load-notice" role="alert">Could not load seller information. <button onClick={ids.reload}>Retry</button></div>}
            <div className="seller-page-content"><Outlet context={{ sellerName: owner?.name } satisfies SellerContext} /></div>
          </main>
        </div>
      </div>
    </div>
  );
}
