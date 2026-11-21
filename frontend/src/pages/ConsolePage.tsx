import { useRef, useState } from 'react';
import { Activity, ArrowUpRight, Boxes, ChevronRight, Clock3, Database, FlaskConical, Info, KeyRound, LayoutDashboard, ListOrdered, MessageSquare, Package, ReceiptText, RotateCcw, Scale, ScrollText, ShieldCheck, ShoppingBag, Store, Tag, Truck, Webhook, Zap, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { StatusPanel } from './console/StatusPanel';
import { ShopsPanel } from './console/ShopsPanel';
import { ResetPanel } from './console/ResetPanel';
import { ClockPanel } from './console/ClockPanel';
import { HttpLogPanel } from './console/HttpLogPanel';
import { WebhooksPanel } from './console/WebhooksPanel';
import { FaultsPanel } from './console/FaultsPanel';
import { TokensPanel } from './console/TokensPanel';
import { SandboxPanel } from './console/SandboxPanel';
import { ArbitrationPanel } from './console/ArbitrationPanel';
import { DisputesPanel } from './console/DisputesPanel';
import { consoleTabs } from '../features/registry';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import type { ShopSummary } from './console/types';

interface Screen { label: string; title: string; description: string; icon: LucideIcon }
const GROUPS: { label: string; screens: Screen[] }[] = [
  { label: 'Workspace', screens: [
    { label: 'Status', title: 'Overview', description: 'Live system health and a clear starting point for your tests.', icon: LayoutDashboard },
    { label: 'Shop & scenario', title: 'Shops & scenarios', description: 'Manage test shops, activate scenarios and prepare product data.', icon: Store },
  ] },
  { label: 'Commerce', screens: [
    { label: 'Orders', title: 'Orders', description: 'Inspect orders and exercise the simulator order lifecycle.', icon: ListOrdered },
    { label: 'Sandbox', title: 'Create test orders', description: 'Choose SKUs and create a batch of sandbox orders for the selected shop.', icon: FlaskConical },
    { label: 'Fulfillment', title: 'Fulfillment', description: 'Control shipment progress and test delivery states.', icon: Truck },
    { label: 'Aftersale', title: 'Returns & refunds', description: 'Review aftersale requests, their history and refund completion.', icon: ReceiptText },
    { label: 'Arbitration', title: 'Dispute arbitration', description: 'Open or adjudicate a return dispute using the Admin API.', icon: Scale },
    { label: 'Inventory', title: 'Inventory', description: 'Inspect stock changes and inventory update requests.', icon: Boxes },
    { label: 'Coupons', title: 'Coupons', description: 'Inspect vouchers available in the selected shop.', icon: Tag },
    { label: 'Chat', title: 'Chat testing', description: 'Simulate buyer messages, agent activity and delivery faults.', icon: MessageSquare },
  ] },
  { label: 'Integration', screens: [
    { label: 'Disputes', title: 'Dispute events', description: 'Inspect simulator disputes and trigger status changes and compensation webhooks.', icon: Scale },
    { label: 'Authorization', title: 'Authorization', description: 'Inspect granted scopes and test token expiry or revocation.', icon: KeyRound },
    { label: 'Webhooks', title: 'Webhooks', description: 'Inspect deliveries, queue test events and replay jobs.', icon: Webhook },
    { label: 'HTTP log', title: 'HTTP request log', description: 'Trace requests and responses across simulator routers.', icon: ScrollText },
  ] },
  { label: 'System tools', screens: [
    { label: 'Clock', title: 'Business clock', description: 'Control business time to test holds and time-dependent scenarios.', icon: Clock3 },
    { label: 'Faults', title: 'Fault injection', description: 'Configure API and webhook faults for resilience testing.', icon: Zap },
    { label: 'Reset', title: 'Reset data', description: 'Review the impact before resetting simulator data.', icon: RotateCcw },
  ] },
];
const SCREENS = GROUPS.flatMap((g) => g.screens);
const SCOPE_NOTES: Record<string, string> = {
  'Shop & scenario': 'This page shows all shops. Each scenario or product action applies to the shop shown on its card.',
  Clock: 'The business clock is shared by all shops.',
  Chat: 'Conversations from all shops are shown. New conversations use the selected shop.',
  Webhooks: 'Delivery jobs from all shops are shown. New test events use the selected shop.',
  Faults: 'Rules from all shops are shown. Use the form to choose a shop-specific or global rule.',
  'HTTP log': 'Requests from all shops are shown unless “selected shop only” is enabled.',
  Reset: 'The reset scope is chosen in the form. Review its impact before confirming.',
  Disputes: 'Only disputes for the selected shop are shown. These simulator records are separate from aftersale arbitration and are cleared when the API restarts.',
};

export function ConsolePage() {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<string>('Status');
  const extra = consoleTabs();
  const [shopId, setShopId] = useState<string>('');
  const shops = useAsync(() => api<{ items: ShopSummary[] }>('/test-admin/shops'), []);
  const list = shops.data?.items ?? [];
  const selected = list.find((s) => s.id === shopId)?.id ?? list[0]?.id ?? '';
  const currentShop = list.find((s) => s.id === selected);
  const screen = SCREENS.find((s) => s.label === tab) ?? { title: tab, description: 'Simulator test controls.' };
  const select = (label: string) => {
    setTab(label);
    if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
  };

  return (
    <div className="admin-console">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-brand"><span className="admin-brand-mark"><ShieldCheck size={20} /></span><div>TikTok<small>SHOP SIMULATOR</small></div></div>
        <nav className="admin-nav" aria-label="Test Console navigation">
          {GROUPS.map((group) => (
            <div className="admin-nav-group" key={group.label}>
              <div className="admin-eyebrow">{group.label}</div>
              {group.screens.map(({ label, title, icon: Icon }) => (
                <button type="button" key={label} aria-current={tab === label ? 'page' : undefined} onClick={() => select(label)}>
                  <Icon size={17} aria-hidden="true" /><span>{title}</span>{tab === label && <ChevronRight size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
          ))}
          {extra.filter((e) => !SCREENS.some((s) => s.label === e.label)).map((e) => (
            <button type="button" key={e.path} aria-current={tab === e.label ? 'page' : undefined} onClick={() => select(e.label)}><Package size={17} />{e.label}</button>
          ))}
        </nav>
        <div className="admin-sidebar-note"><FlaskConical size={16} /><span>Sandbox</span></div>
      </aside>
      <div className="admin-workspace" ref={workspaceRef}>
        <div className="admin-context-bar">
          <div className="admin-workspace-welcome"><strong>Admin Console</strong></div>
          <div className="admin-header-actions"><Link to="/" className="admin-role-link" aria-label="Open Tiptop Shop" title="Tiptop Shop"><ShoppingBag size={17} /></Link><Link to="/seller-center" className="admin-role-link" aria-label="Open Seller Center" title="Seller Center"><Store size={17} /></Link><span className="admin-operator" title="Admin test workspace">AD</span></div>
        </div>
        <div className="admin-content">
          {tab !== 'Shop & scenario' && <section className="admin-shop-context" aria-label="Shop context">
            <div className="admin-shop-context-label"><Store size={17} aria-hidden="true" /><span>Working shop<small>Choose the shop for this workspace</small></span></div>
            <label className="admin-shop-picker"><Store size={15} />
            <select value={selected} onChange={(e) => setShopId(e.target.value)} disabled={list.length === 0} aria-label="Selected shop">
              {list.length === 0 ? <option value="">{shops.loading ? 'Loading shops…' : 'No shops — run seed'}</option> : null}
              {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
            {currentShop && <span className="admin-shop-context-status"><span />{currentShop.status === 'ACTIVE' ? 'Active shop' : currentShop.status}</span>}
            <details className="admin-page-info" key={tab}><summary aria-label="Page information" title="Page information"><Info size={17} /></summary><div><p>{screen.description}</p>{SCOPE_NOTES[tab] && <p>{SCOPE_NOTES[tab]}</p>}</div></details>
          </section>}
          {shops.error ? <div className="state state-error" role="alert">Could not load shops: {shops.error.message}<button onClick={shops.reload}>Retry</button></div> : null}
          {tab === 'Status' && (
            <>
              <div className="admin-overview-strip">
                <div><Store size={18} /><span>Selected shop<strong>{currentShop?.name ?? 'No shop selected'}</strong></span></div>
                <div><Package size={18} /><span>Products<strong>{currentShop?.counts.products ?? '—'}</strong></span></div>
                <div><Activity size={18} /><span>Shop status<strong>{currentShop?.status ?? '—'}</strong></span></div>
                <div><Database size={18} /><span>Available shops<strong>{shops.data ? list.length : '—'}</strong></span></div>
              </div>
              <div className="admin-section-title"><h2>System health</h2><span>Updates every 5 seconds</span></div>
              <StatusPanel onSeeded={shops.reload} />
              <div className="admin-section-title"><h2>Quick actions</h2></div>
              <div className="admin-shortcuts">{[
                ['Sandbox', 'Create test orders', 'Select products and prepare a batch of orders.'],
                ['Orders', 'Inspect order lifecycle', 'Review history and exercise order transitions.'],
                ['Webhooks', 'Inspect event deliveries', 'Review attempts and replay a webhook job.'],
              ].map(([target, title]) => <button key={target} onClick={() => select(target)}><ArrowUpRight size={18} /><strong>{title}</strong></button>)}</div>
            </>
          )}
          <div className={`admin-panel${['Orders', 'Fulfillment', 'Aftersale', 'Inventory', 'Chat', 'Authorization', 'Webhooks', 'HTTP log', 'Faults', 'Disputes'].includes(tab) ? ' admin-register-panel' : ''}`} role="region" aria-label={`${screen.title} controls`} key={`${tab}:${selected}`}>
            {tab === 'Disputes' && <DisputesPanel shopId={selected} />}
            {tab === 'Shop & scenario' && <ShopsPanel shops={shops} />}
            {tab === 'Reset' && <ResetPanel shops={list} defaultShopId={selected} onDone={shops.reload} />}
            {tab === 'Clock' && <ClockPanel />}
            {tab === 'HTTP log' && <HttpLogPanel shopId={selected} />}
            {tab === 'Webhooks' && <WebhooksPanel shopId={selected} />}
            {tab === 'Faults' && <FaultsPanel shopId={selected} />}
            {tab === 'Sandbox' && (selected ? <SandboxPanel shopId={selected} /> : <div className="state state-empty">Select a shop to create test orders.</div>)}
            {tab === 'Arbitration' && (selected ? <ArbitrationPanel shopId={selected} /> : <div className="state state-empty">Select a shop to inspect disputes.</div>)}
            {tab === 'Authorization' && <TokensPanel shopId={selected} />}
            {extra.filter((e) => e.label === tab).map((e) => <div key={e.path}>{e.render({ shopId: selected })}</div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
