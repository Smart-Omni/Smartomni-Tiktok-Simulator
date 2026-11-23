import { INestApplication } from '@nestjs/common';
import { promises as fs } from 'fs';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { conformErrors } from './contract';
import { ADMIN_TOKEN, createApp, resetToSeed } from './helpers';
import { TiktokTestClient } from './tiktok-client';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const HOOKS = '/event/202309/webhooks';
const tracking = (id: string) => `/fulfillment/202309/orders/${id}/tracking`;
const pkgPath = (id: string) => `/fulfillment/202309/packages/${id}`;
const SKU = 'sim-sku-a-BAG-NAT';

describe('Phase 07a: packages, tracking, shipping documents', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let t: TiktokTestClient;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    cfg = app.get(APP_CONFIG);
    http = request(app.getHttpServer());
    t = new TiktokTestClient(http, cfg);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
    await app.get(PersistentBusinessClock).reset();
  });

  /** Checkout, and (by default) pay: a paid order is AWAITING_SHIPMENT at once, with its TO_FULFILL package. */
  async function placeOrder(buyer: { token: string; shopId: string }, key: string, skuId = SKU, pay = true) {
    const c = await t.checkout(buyer, [{ skuId, quantity: 2 }], key).expect(201);
    if (pay) await t.pay(buyer, c.body.order.id).expect(201);
    return c.body.order.id as string;
  }
  const packageIdOf = async (orderId: string) => (await prisma.package.findFirstOrThrow({ where: { order: { externalId: orderId } } })).externalId;
  const arrange = (seller: { token: string; shopId: string }, orderId: string) => http.post(`/demo/shops/${seller.shopId}/orders/${orderId}/arrange-shipment`).set('x-demo-session', seller.token).send({});
  const advance = (seller: { token: string; shopId: string }, orderId: string) => http.post(`/demo/shops/${seller.shopId}/orders/${orderId}/advance-shipment`).set('x-demo-session', seller.token).send({});

  describe('shipping rules', () => {
    it('refuses to arrange shipment while the order is UNPAID, with a clear code, and creates no package', async () => {
      const seller = await t.sellerSession(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-hold-01', SKU, false);
      const r = await arrange(seller, id);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('order_unpaid');
      expect(await prisma.package.count()).toBe(0);
      const view = (await http.get(`/demo/shops/${seller.shopId}/orders/${id}/fulfillment`).set('x-demo-session', seller.token).expect(200)).body;
      expect(view.blockedReason).toBe('order_unpaid');
      expect(view.package).toBeNull();
      // paying makes it shippable at once: no hold period, the package exists right away
      await t.pay(buyer, id).expect(201);
      const ready = (await http.get(`/demo/shops/${seller.shopId}/orders/${id}/fulfillment`).set('x-demo-session', seller.token).expect(200)).body;
      expect(ready).toMatchObject({ orderStatus: 'AWAITING_SHIPMENT', canArrange: true, blockedReason: null, package: { status: 'TO_FULFILL' } });
    });

    it('creates a TO_FULFILL package on payment; arrange -> collect -> deliver walks the order and package; DELIVERED is not COMPLETED', async () => {
      const seller = await t.sellerSession(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-flow-01', SKU);
      const pkg = await prisma.package.findFirstOrThrow({ where: { order: { externalId: id } } });
      expect(pkg).toMatchObject({ status: 'TO_FULFILL', trackingNumber: null });
      const arranged = (await arrange(seller, id).expect(201)).body;
      expect(arranged.orderStatus).toBe('AWAITING_COLLECTION');
      expect(arranged.package.status).toBe('PROCESSING');
      expect(arranged.package.trackingNumber).toMatch(/^SIM\d{11}$/);
      expect((await advance(seller, id).expect(201)).body.orderStatus).toBe('IN_TRANSIT');
      const delivered = (await advance(seller, id).expect(201)).body;
      expect(delivered.orderStatus).toBe('DELIVERED');
      expect(delivered.package.status).toBe('COMPLETED');
      expect((await prisma.order.findFirstOrThrow({ where: { externalId: id } })).completedAt).toBeNull();
      expect((await advance(seller, id)).status).toBe(400); // nothing after DELIVERED but COMPLETED, which is not a carrier step
    });

    it('a repeated arrange (or API ship) is idempotent: one package, one tracking number, no second ORDER transition', async () => {
      const seller = await t.sellerSession(0);
      const buyer = await t.buyerSession(0);
      const a = await t.connect(0);
      const id = await placeOrder(buyer, 'key-ful-idem-01', SKU);
      const first = (await arrange(seller, id).expect(201)).body;
      const second = (await arrange(seller, id).expect(201)).body;
      expect(second.package.trackingNumber).toBe(first.package.trackingNumber);
      const pkgId = await packageIdOf(id);
      await t.call('POST', `${pkgPath(pkgId)}/ship`, a.accessToken, { body: {} }).expect(200);
      expect(await prisma.package.count()).toBe(1);
      expect((await prisma.orderAudit.findMany({ where: { order: { externalId: id }, toStatus: 'AWAITING_COLLECTION' } })).length).toBe(1);
    });

    it('cancelling after arrange cancels the package and records a tracking event', async () => {
      const seller = await t.sellerSession(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-canc-01', SKU);
      await arrange(seller, id).expect(201);
      await http.post(`/demo/shops/${seller.shopId}/orders/${id}/cancel`).set('x-demo-session', seller.token).send({ reason: 'out of packaging' }).expect(201);
      const pkg = await prisma.package.findFirstOrThrow({ where: { order: { externalId: id } } });
      expect(pkg.status).toBe('CANCELLED');
      const events = await prisma.trackingEvent.findMany({ where: { order: { externalId: id } }, orderBy: { seq: 'asc' } });
      expect(events.map((e) => e.status)).toEqual(['PROCESSING', 'CANCELLED']);
    });

    it('the Test Console jump to IN_TRANSIT also keeps package and tracking consistent', async () => {
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-tc-0001', SKU);
      await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'AWAITING_COLLECTION' }).expect(201);
      await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'IN_TRANSIT' }).expect(201);
      const pkg = await prisma.package.findFirstOrThrow({ where: { order: { externalId: id } } });
      expect(pkg.status).toBe('FULFILLING');
      expect(pkg.trackingNumber).toBeTruthy();
    });
  });

  describe('GET tracking / package detail', () => {
    it('tracking reflects the transitions in order, with millisecond timestamps, and conforms to the OAS schema', async () => {
      const a = await t.connect(0);
      const seller = a.seller;
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-trk-001', SKU);
      expect((await t.call('GET', tracking(id), a.accessToken).expect(200)).body.data.tracking).toEqual([]);
      await arrange(seller, id).expect(201);
      await http.put('/test-admin/clock').set(admin).send({ advanceMs: 60_000 }).expect(200);
      await advance(seller, id).expect(201);
      await http.put('/test-admin/clock').set(admin).send({ advanceMs: 60_000 }).expect(200);
      await advance(seller, id).expect(201);
      const res = await t.call('GET', tracking(id), a.accessToken).expect(200);
      expect(conformErrors('ops/fulfillment.tracking.response.json', res.body)).toEqual([]);
      const list = res.body.data.tracking as { description: string; update_time_millis: number }[];
      expect(list.map((e) => e.description)).toEqual([
        'Seller has arranged the shipment. Waiting for the carrier to collect the parcel.',
        'The parcel was collected by the carrier and is in transit.',
        'Your package was delivered!',
      ]);
      const gap = list[1].update_time_millis - list[0].update_time_millis; // the business clock keeps running, so allow a little real time
      expect(gap).toBeGreaterThanOrEqual(60_000);
      expect(gap).toBeLessThan(65_000);
      expect(list[0].update_time_millis).toBeGreaterThan(1e12); // milliseconds
    });

    it('package detail conforms to the schema and carries the package/order/line ids', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-det-001', SKU);
      const pkgId = await packageIdOf(id);
      const order = (await t.call('GET', '/order/202507/orders', a.accessToken, { query: { ids: id } }).expect(200)).body.data.orders[0];
      expect(order.packages).toEqual([{ id: pkgId }]);
      expect(order.line_items.every((l: any) => l.package_id === pkgId)).toBe(true);
      const res = await t.call('GET', pkgPath(pkgId), a.accessToken).expect(200);
      expect(conformErrors('ops/fulfillment.package_detail.response.json', res.body)).toEqual([]);
      expect(res.body.data).toMatchObject({ package_id: pkgId, package_status: 'TO_FULFILL', orders: [{ id }], shipping_type: 'TIKTOK', recipient_address: { region_code: 'VN' } });
      expect(res.body.data.order_line_item_ids.sort()).toEqual(order.line_items.map((l: any) => l.id).sort());
      expect(res.body.data.tracking_number).toBeUndefined();
    });

    it('another shop\'s order and package are as unknown as nonexistent ones', async () => {
      const a = await t.connect(0);
      const b = await t.connect(1);
      const seller = a.seller;
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-iso-001', SKU);
      await arrange(seller, id).expect(201);
      const pkgId = await packageIdOf(id);
      for (const [path, query] of [[tracking(id), undefined], [pkgPath(pkgId), undefined], [`${pkgPath(pkgId)}/shipping_documents`, { document_type: 'SHIPPING_LABEL' }]] as const) {
        const r = await t.call('GET', path, b.accessToken, { query });
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toContain(id);
      }
      expect((await t.call('GET', tracking('0000'), a.accessToken)).status).toBe(404);
      expect((await t.call('POST', `${pkgPath(pkgId)}/ship`, b.accessToken, { body: {} })).status).toBe(404);
    });

    it('needs the fulfillment scopes and a valid signature', async () => {
      const a = await t.connect(0);
      await prisma.token.updateMany({ data: { scopes: ['sim.order.read'] } });
      const r = await t.call('GET', tracking('1'), a.accessToken);
      expect(r.status).toBe(403);
      expect(r.body.simulator_fault.kind).toBe('missing_scope');
      await prisma.token.updateMany({ data: { scopes: ['sim.fulfillment.read'] } });
      expect((await t.call('POST', `${pkgPath('1')}/ship`, a.accessToken, { body: {} })).status).toBe(403); // read scope cannot ship
      expect((await t.call('GET', tracking('1'), a.accessToken, { secret: 'wrong' })).status).toBe(401);
    });
  });

  describe('POST ship package', () => {
    it('ships an AWAITING_SHIPMENT package once; UNPAID orders have no package to ship; bad bodies are invalid_input', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const unpaid = await placeOrder(buyer, 'key-ful-ship-hold', SKU, false);
      expect(await prisma.package.count({ where: { order: { externalId: unpaid } } })).toBe(0);
      const ready = await placeOrder(buyer, 'key-ful-ship-rdy1');
      const pkgId = await packageIdOf(ready);
      for (const body of [{ handover_method: 'TELEPORT' }, { nope: 1 }, { self_shipment: { shipping_provider_id: 'x', tracking_number: 'y' } }]) {
        const bad = await t.call('POST', `${pkgPath(pkgId)}/ship`, a.accessToken, { body });
        expect(bad.status).toBe(400);
        expect(bad.body.simulator_fault.kind).toBe('invalid_input');
      }
      const ok = await t.call('POST', `${pkgPath(pkgId)}/ship`, a.accessToken, { body: { handover_method: 'PICKUP' } }).expect(200);
      expect(conformErrors('ops/fulfillment.package_ship.response.json', ok.body)).toEqual([]);
      const pkg = await prisma.package.findFirstOrThrow({ where: { externalId: pkgId } });
      expect(pkg).toMatchObject({ status: 'PROCESSING', handoverMethod: 'PICKUP' });
    });

    it('a cancelled order cannot be shipped', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-ship-canc', SKU);
      const pkgId = await packageIdOf(id);
      await http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to: 'CANCELLED' }).expect(201);
      const r = await t.call('POST', `${pkgPath(pkgId)}/ship`, a.accessToken, { body: {} });
      expect(r.status).toBe(400);
      expect(r.body.simulator_fault.kind).toBe('order_not_shippable');
    });
  });

  describe('shipping documents (PDF)', () => {
    async function arranged() {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-doc-0001', SKU);
      await arrange(a.seller, id).expect(201);
      return { a, id, pkgId: await packageIdOf(id) };
    }
    const docs = (token: string, pkgId: string, q: Record<string, string>) => t.call('GET', `${pkgPath(pkgId)}/shipping_documents`, token, { query: q });

    it('returns a downloadable test PDF; same URL and same bytes on repeat and after "restart" (file re-read from disk)', async () => {
      const { a, pkgId } = await arranged();
      const res = await docs(a.accessToken, pkgId, { document_type: 'SHIPPING_LABEL' }).expect(200);
      expect(conformErrors('ops/fulfillment.shipping_documents.response.json', res.body)).toEqual([]);
      const { doc_url, tracking_number } = res.body.data;
      expect(doc_url).toMatch(new RegExp(`^${cfg.publicApiBaseUrl.replace(/\/$/, '')}/demo/files/shipping-documents/[0-9a-f]{48}\\.pdf$`));
      expect(tracking_number).toMatch(/^SIM\d{11}$/);
      const path = new URL(doc_url).pathname;
      const pdf = await http.get(path).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      const bytes = pdf.body as Buffer;
      expect(bytes.length).toBeGreaterThan(300);
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      expect(bytes.toString('latin1')).toContain('%%EOF');
      expect(bytes.toString('latin1')).toContain('TEST DATA - NOT A REAL SHIPPING LABEL');
      expect(bytes.toString('latin1')).toContain(tracking_number);
      // repeat: identical URL; a new app instance over the same database and PDF dir serves the same bytes
      expect((await docs(a.accessToken, pkgId, { document_type: 'SHIPPING_LABEL' }).expect(200)).body.data.doc_url).toBe(doc_url);
      const row = await prisma.shippingDocument.findFirstOrThrow();
      expect(row.sizeBytes).toBe(bytes.length);
      const restarted = await createApp();
      try {
        const again = await request(restarted.getHttpServer()).get(path).buffer(true).parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
        expect(again.status).toBe(200);
        expect(Buffer.compare(again.body as Buffer, bytes)).toBe(0);
        expect(Buffer.compare(await fs.readFile(row.filePath), bytes)).toBe(0);
      } finally {
        await restarted.close();
      }
    });

    it('supports label, packing slip and both; rejects unsupported types/formats; refuses before shipment is arranged', async () => {
      const { a, pkgId } = await arranged();
      const urls = new Set<string>();
      for (const document_type of ['SHIPPING_LABEL', 'PACKING_SLIP', 'SHIPPING_LABEL_AND_PACKING_SLIP']) urls.add((await docs(a.accessToken, pkgId, { document_type }).expect(200)).body.data.doc_url);
      expect(urls.size).toBe(3);
      for (const q of [{}, { document_type: 'SHIPPING_LABEL_PICTURE' }, { document_type: 'HAZMAT_LABEL' }, { document_type: 'SHIPPING_LABEL', document_format: 'ZPL' }, { document_type: 'SHIPPING_LABEL', document_size: 'A0' }]) {
        const r = await docs(a.accessToken, pkgId, q as Record<string, string>);
        expect(r.status).toBe(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      }
      const buyer = await t.buyerSession(0);
      const fresh = await placeOrder(buyer, 'key-ful-doc-0002', SKU);
      const freshPkg = await packageIdOf(fresh);
      const early = await docs(a.accessToken, freshPkg, { document_type: 'SHIPPING_LABEL' });
      expect(early.status).toBe(400);
      expect(early.body.simulator_fault.kind).toBe('package_not_arranged');
      expect(await prisma.shippingDocument.count({ where: { package: { externalId: freshPkg } } })).toBe(0);
    });

    it('the public file route only serves known unguessable tokens', async () => {
      const { a, pkgId } = await arranged();
      await docs(a.accessToken, pkgId, { document_type: 'SHIPPING_LABEL' }).expect(200);
      await http.get(`/demo/files/shipping-documents/${'0'.repeat(48)}.pdf`).expect(404);
      await http.get('/demo/files/shipping-documents/..%2F..%2Fpackage.json').expect(404);
      await http.get('/demo/files/shipping-documents/abc.pdf').expect(404);
    });

    it('the seller UI endpoint returns the label URL for the seller only; a buyer sees tracking but no label link', async () => {
      const { a, id } = await arranged();
      const label = (await http.post(`/demo/shops/${a.seller.shopId}/orders/${id}/shipping-label`).set('x-demo-session', a.seller.token).send({}).expect(201)).body;
      expect(label.url).toContain('/demo/files/shipping-documents/');
      const buyer = await t.buyerSession(0);
      await http.post(`/demo/shops/${buyer.shopId}/orders/${id}/shipping-label`).set('x-demo-session', buyer.token).send({}).expect(403);
      const ownerOrders = (await prisma.order.findFirstOrThrow({ where: { externalId: id } })).buyerId;
      const owner = ownerOrders === buyer.buyerId ? buyer : await t.buyerSession(0, 1);
      const view = (await http.get(`/demo/shops/${owner.shopId}/orders/${id}/fulfillment`).set('x-demo-session', owner.token).expect(200)).body;
      expect(view.tracking.length).toBeGreaterThan(0);
      expect(JSON.stringify(view)).not.toContain('shipping-documents');
      const stranger = await t.buyerSession(0, owner.buyerId === buyer.buyerId ? 1 : 0);
      if (stranger.buyerId !== owner.buyerId) await http.get(`/demo/shops/${stranger.shopId}/orders/${id}/fulfillment`).set('x-demo-session', stranger.token).expect(404);
    });
  });

  describe('PACKAGE_UPDATE webhooks', () => {
    it('are written with every package change, in the same transaction as the order event, only for subscribed topics', async () => {
      const a = await t.connect(0);
      await t.call('PUT', HOOKS, a.accessToken, { body: { event_type: 'PACKAGE_UPDATE', address: 'http://localhost:9/pkg' } }).expect(200);
      const buyer = await t.buyerSession(0);
      const id = await placeOrder(buyer, 'key-ful-hook-001', SKU);
      await arrange(a.seller, id).expect(201);
      await advance(a.seller, id).expect(201);
      await advance(a.seller, id).expect(201);
      const jobs = await prisma.webhookJob.findMany({ where: { topic: 'PACKAGE_UPDATE' }, orderBy: { createdAt: 'asc' } });
      expect(jobs.map((j) => (j.payload as any).data.package_status)).toEqual(['TO_FULFILL', 'PROCESSING', 'FULFILLING', 'COMPLETED']);
      const env: any = jobs[1].payload;
      expect(conformErrors('webhook-envelope.json', env)).toEqual([]);
      expect(env.data).toMatchObject({ order_id: id, package_id: await packageIdOf(id) });
      expect(await prisma.webhookJob.count({ where: { topic: 'ORDER_STATUS_CHANGE' } })).toBe(0); // not subscribed -> nothing
      // a refused action writes nothing
      const before = await prisma.webhookJob.count();
      await advance(a.seller, id).expect(400);
      expect(await prisma.webhookJob.count()).toBe(before);
    });
  });
});
