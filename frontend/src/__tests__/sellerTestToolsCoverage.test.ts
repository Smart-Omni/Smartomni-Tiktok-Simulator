import { describe, expect, it } from 'vitest';

/**
 * Every simulator test API is reachable from Seller Center (docs/seller-center-test-tools-plan.md, section 3), or is listed as
 * deliberately left in the Test Console only. Static check: each entry is a chain of source files from a Seller Center page to the
 * file that calls the API; every file must import the next one and the last one must contain the call.
 */
const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../__tests__/**', '!../**/*.d.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const source = (file: string) => {
  const text = sources[`../${file}`];
  if (text === undefined) throw new Error(`unknown source file ${file}`);
  return text;
};
const importsModule = (from: string, to: string) => {
  const module = to.replace(/\.tsx?$/, '');
  const base = module.split('/').at(-1)!;
  return new RegExp(`from '[^']*(?:@/${module}|/${base})'`).test(source(from));
};

const SC = 'pages/seller-center/';
const CON = 'pages/console/';
const P = {
  orders: `${SC}SellerOrders.tsx`,
  detail: `${SC}SellerOrderDetail.tsx`,
  returns: `${SC}SellerReturns.tsx`,
  products: `${SC}SellerProducts.tsx`,
  vouchers: `${SC}SellerVouchers.tsx`,
  messages: `${SC}SellerMessages.tsx`,
  shop: `${SC}SellerShop.tsx`,
  testing: `${SC}SellerTesting.tsx`,
};
const admin = `${CON}adminEndpoints.ts`;

/** API -> [chain from the Seller Center page to the calling file, text of the call in that file]. */
const covered: Record<string, [string[], string]> = {
  'GET /test-admin/sandbox/products': [[P.orders, `${CON}SandboxPanel.tsx`, admin], '`/test-admin/sandbox/products?shopId='],
  'POST /test-admin/sandbox/orders': [[P.orders, `${CON}SandboxPanel.tsx`, admin], "'/test-admin/sandbox/orders'"],
  'POST /test-admin/scenarios/loyalty-orders': [[P.orders, `${CON}LoyaltyOrdersForm.tsx`, admin], "'/test-admin/scenarios/loyalty-orders'"],
  'POST /test-admin/orders/:ref/transition': [[P.orders, 'components/seller/ForceStatusMenu.tsx', admin], '/transition`'],
  'GET /test-admin/orders/:ref/audit': [[P.detail, `${CON}OrderAuditPanel.tsx`, admin], '/audit?shopId='],
  'GET /test-admin/aftersale/:ref/records': [[P.returns, 'components/seller/AftersaleTestActions.tsx', admin], '/records?shopId='],
  'POST /test-admin/aftersale/:ref/complete': [[P.returns, 'components/seller/AftersaleTestActions.tsx', admin], '/complete?shopId='],
  'POST /test-admin/aftersale/:ref/arbitration': [[P.returns, `${CON}ArbitrationPanel.tsx`, admin], '/arbitration`'],
  'GET /api/v2/simulator/dispute': [[P.returns, `${CON}DisputesPanel.tsx`, `${CON}disputeEndpoints.ts`], "const path = '/api/v2/simulator/dispute'"],
  'GET /api/v2/simulator/dispute/:id': [[P.returns, `${CON}DisputesPanel.tsx`, `${CON}disputeEndpoints.ts`], 'request<DisputeRecord>(`/${encodeURIComponent(id)}`)'],
  'POST /api/v2/simulator/dispute/trigger': [[P.returns, `${CON}DisputesPanel.tsx`, `${CON}disputeEndpoints.ts`], "request<DisputeTriggerResult>('/trigger', body)"],
  'POST /test-admin/catalog/bulk': [[P.products, `${CON}ShopsPanel.tsx`], "'/test-admin/catalog/bulk'"],
  'POST /api/v2/media/upload': [[P.products, `${CON}MediaPanel.tsx`, `${CON}mediaEndpoints.ts`], "'/api/v2/media/upload'"],
  'POST /test-admin/scenarios/loyalty-vouchers': [[P.vouchers, `${CON}LoyaltyVouchersForm.tsx`], "'/test-admin/scenarios/loyalty-vouchers'"],
  'GET /test-admin/coupons': [[P.vouchers, 'features/coupons.console.tsx'], '`/test-admin/coupons?'],
  'GET /test-admin/chat/conversations': [[P.messages, 'features/chat.console.tsx'], "api<{ items: AdminConversation[] }>('/test-admin/chat/conversations')"],
  'POST /test-admin/chat/conversations': [[P.messages, 'features/chat.console.tsx'], "api('/test-admin/chat/conversations', { method: 'POST'"],
  'POST /test-admin/chat/conversations/:ref/buyer-message': [[P.messages, 'components/seller/SimulateBuyerReply.tsx', admin], '/buyer-message`'],
  'POST /test-admin/chat/conversations/:ref/flags': [[P.messages, 'features/chat.console.tsx'], '/flags`'],
  'POST /test-admin/chat/conversations/:ref/agent': [[P.messages, 'features/chat.console.tsx'], '/agent`'],
  'GET /test-admin/shops': [[P.shop, `${CON}ShopsPanel.tsx`], "api<{ items: ShopSummary[] }>('/test-admin/shops')"],
  'POST /test-admin/shops/:shopId/scenario': [[P.shop, `${CON}ShopsPanel.tsx`], '/scenario`'],
  'GET /test-admin/tokens': [[P.testing, `${CON}TokensPanel.tsx`], '`/test-admin/tokens?shopId='],
  'POST /test-admin/tokens/:id/expire-access': [[P.testing, `${CON}TokensPanel.tsx`], '/expire-access`'],
  'POST /test-admin/tokens/:id/expire-refresh': [[P.testing, `${CON}TokensPanel.tsx`], '/expire-refresh`'],
  'POST /test-admin/tokens/:id/revoke': [[P.testing, `${CON}TokensPanel.tsx`], '/revoke`'],
  'POST /test-admin/tokens/:id/remove-scope': [[P.testing, `${CON}TokensPanel.tsx`], '/remove-scope`'],
  'POST /test-admin/authorization-codes/expire': [[P.testing, `${CON}TokensPanel.tsx`], "'/test-admin/authorization-codes/expire'"],
  'GET /test-admin/webhooks': [[P.testing, `${CON}WebhooksPanel.tsx`], '`/test-admin/webhooks?'],
  'POST /test-admin/webhooks': [[P.testing, `${CON}WebhooksPanel.tsx`], "api('/test-admin/webhooks', { method: 'POST'"],
  'POST /test-admin/webhooks/:jobId/replay': [[P.testing, `${CON}WebhooksPanel.tsx`], '/replay`'],
  'GET /test-admin/http-logs': [[P.testing, `${CON}HttpLogPanel.tsx`], '`/test-admin/http-logs?'],
  'GET /test-admin/faults': [[P.testing, `${CON}FaultsPanel.tsx`], "api<{ items: Fault[] }>('/test-admin/faults')"],
  'POST /test-admin/faults': [[P.testing, `${CON}FaultsPanel.tsx`], "api('/test-admin/faults', {"],
  'DELETE /test-admin/faults/:id': [[P.testing, `${CON}FaultsPanel.tsx`], "method: 'DELETE'"],
  'GET /test-admin/status': [[P.testing, `${CON}StatusPanel.tsx`], "'/test-admin/status'"],
  'POST /test-admin/seed': [[P.testing, `${CON}StatusPanel.tsx`], "'/test-admin/seed'"],
  'GET /test-admin/clock': [[P.testing, `${CON}ClockPanel.tsx`], "api<Clock>('/test-admin/clock')"],
  'PUT /test-admin/clock': [[P.testing, `${CON}ClockPanel.tsx`], "api('/test-admin/clock', { method: 'PUT'"],
};

/** Left in the Test Console only (plan section 3.3): a /demo list already shows the same data, or reset, which affects every shop. */
const consoleOnly = [
  'GET /test-admin/orders',
  'GET /test-admin/aftersale',
  'GET /test-admin/inventory/history',
  'POST /test-admin/reset/prepare',
  'POST /test-admin/reset',
];

describe('Seller Center test API coverage', () => {
  it('accounts for all 44 simulator test APIs exactly once', () => {
    const all = [...Object.keys(covered), ...consoleOnly];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(44);
    expect(Object.keys(covered)).toHaveLength(39);
  });

  it.each(Object.entries(covered))('%s is called from a Seller Center page', (_api, [chain, call]) => {
    for (let i = 0; i + 1 < chain.length; i++) expect(importsModule(chain[i], chain[i + 1]), `${chain[i]} imports ${chain[i + 1]}`).toBe(true);
    expect(source(chain.at(-1)!)).toContain(call);
  });

  it('keeps reset out of Seller Center', () => {
    for (const [file, text] of Object.entries(sources)) {
      if (file.startsWith(`../${SC}`) || file.startsWith('../components/seller/')) expect(text, file).not.toMatch(/ResetPanel|\/test-admin\/reset/);
    }
  });
});
