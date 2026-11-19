import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { ADMIN_TOKEN, cleanDb, createApp } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };

type Route = { method: 'GET' | 'POST' | 'DELETE'; path: string; scope: string; query?: Record<string, string>; body?: unknown };
const ROUTES: Route[] = [
  { method: 'GET', path: '/product/202309/categories/100002/attributes', scope: 'sim.product.read' },
  { method: 'GET', path: '/product/202309/categories/100002/rules', scope: 'sim.product.read' },
  { method: 'POST', path: '/return_refund/202309/cancellations', scope: 'sim.aftersale.write', body: { order_id: '1', cancel_reason: 'OTHER' } },
  { method: 'POST', path: '/return_refund/202309/returns', scope: 'sim.aftersale.write', body: { order_id: '1', return_type: 'REFUND', return_reason: 'OTHER' } },
  { method: 'POST', path: '/return_refund/202309/refunds/calculate', scope: 'sim.aftersale.read', body: { order_id: '1', request_type: 'REFUND' } },
  { method: 'POST', path: '/product/202309/products/1/prices/update', scope: 'sim.product.write', body: { skus: [] } },
  { method: 'POST', path: '/product/202309/inventory/search', scope: 'sim.product.read', body: { sku_ids: ['1'] } },
  { method: 'DELETE', path: '/product/202309/products', scope: 'sim.product.write', body: { product_ids: ['1'] } },
  { method: 'POST', path: '/product/202309/products/recover', scope: 'sim.product.write', body: { product_ids: ['1'] } },
  { method: 'POST', path: '/fulfillment/202309/packages/search', scope: 'sim.fulfillment.read', query: { page_size: '5' }, body: {} },
  { method: 'POST', path: '/fulfillment/202309/packages/ship', scope: 'sim.fulfillment.write', body: { packages: [{ id: '1' }] } },
  { method: 'POST', path: '/customer_service/202309/conversations', scope: 'sim.conversation.write', body: { buyer_user_id: 'x' } },
  { method: 'POST', path: '/customer_service/202309/conversations/1/messages/read', scope: 'sim.conversation.write', body: {} },
  { method: 'GET', path: '/product/202309/brands', scope: 'sim.product.read', query: { page_size: '5' } },
  { method: 'GET', path: '/product/202309/categories', scope: 'sim.product.read' },
];

describe('OAS alignment guards: every new or changed route enforces scope and shop_cipher', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let t: TiktokTestClient;
  let token: string;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    t = new TiktokTestClient(request(app.getHttpServer()), app.get(APP_CONFIG) as AppConfig);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await cleanDb(prisma);
    await app.get(SeedService).seedAll();
    token = (await t.connect(0)).accessToken;
  });

  const call = (r: Route, tok: string, extraQuery: Record<string, string> = {}) => t.call(r.method, r.path, tok, { query: { ...(r.query ?? {}), ...extraQuery }, body: r.body });

  it('rejects a shop_cipher that is not the token shop on every route', async () => {
    for (const r of ROUTES) {
      const res = await call(r, token, { shop_cipher: 'wrong' });
      expect([r.path, res.status, res.body.simulator_fault?.kind]).toEqual([r.path, 403, 'shop_cipher_mismatch']);
    }
  });

  it('rejects a token that no longer holds the route scope with 403 missing_scope', async () => {
    const tokens = (await t.http.get('/test-admin/tokens').set(admin)).body.items as Array<{ id: string }>;
    const id = tokens[0].id;
    for (const scope of [...new Set(ROUTES.map((r) => r.scope))]) {
      await t.http.post(`/test-admin/tokens/${id}/remove-scope`).set(admin).send({ scope }).expect(201);
    }
    for (const r of ROUTES) {
      const res = await call(r, token);
      expect([r.path, res.status, res.body.simulator_fault?.kind]).toEqual([r.path, 403, 'missing_scope']);
    }
  });
});
