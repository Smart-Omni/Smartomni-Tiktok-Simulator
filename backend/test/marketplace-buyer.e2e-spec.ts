import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createApp, resetToSeed } from './helpers';

describe('Marketplace Buyer (Buyer mua mọi shop trên sàn)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetToSeed(app, prisma);
  });

  describe('Session Management (scope & shopId)', () => {
    it('grants scope MARKETPLACE to BUYER and returns seeded shopId for compatibility', async () => {
      const ids = (await http.get('/demo/identities')).body;
      const buyer = ids.buyers[0];

      const res = await http.post('/demo/sessions').send({ role: 'BUYER', email: buyer.email, password: '123' }).expect(201);
      expect(res.body.role).toBe('BUYER');
      expect(res.body.scope).toBe('MARKETPLACE');
      expect(res.body.shopId).toBe(buyer.shopId);
      expect(res.body.sessionToken).toBeDefined();

      const me = await http.get('/demo/me').set('x-demo-session', res.body.sessionToken).expect(200);
      expect(me.body.role).toBe('BUYER');
      expect(me.body.scope).toBe('MARKETPLACE');
      expect(me.body.buyer.id).toBe(buyer.id);
    });

    it('grants scope SHOP to SELLER', async () => {
      const ids = (await http.get('/demo/identities')).body;
      const seller = ids.sellers[0];

      const res = await http.post('/demo/sessions').send({ role: 'SELLER', email: seller.email, password: '123' }).expect(201);
      expect(res.body.role).toBe('SELLER');
      expect(res.body.scope).toBe('SHOP');
      expect(res.body.shopId).toBe(seller.shops[0].id);

      const me = await http.get('/demo/me').set('x-demo-session', res.body.sessionToken).expect(200);
      expect(me.body.role).toBe('SELLER');
      expect(me.body.scope).toBe('SHOP');
    });
  });

  describe('Public Marketplace Catalog Endpoints', () => {
    it('GET /demo/catalog returns active products of all active shops across the marketplace', async () => {
      const res = await http.get('/demo/catalog').expect(200);
      expect(res.body.currency).toBe('VND');
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.items.length).toBeGreaterThan(0);

      const first = res.body.items[0];
      expect(first.id).toBeDefined();
      expect(first.title).toBeDefined();
      expect(first.shop).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    });

    it('GET /demo/catalog supports filtering by shopId and search query q', async () => {
      const shops = await prisma.shop.findMany({ where: { status: 'ACTIVE' } });
      expect(shops.length).toBeGreaterThanOrEqual(2);
      const targetShop = shops[0];

      const res = await http.get('/demo/catalog').query({ shopId: targetShop.id }).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      for (const item of res.body.items) {
        expect(item.shop.id).toBe(targetShop.id);
      }

      // Search query q
      const sampleTitle = res.body.items[0].title.split(' ')[0];
      const searchRes = await http.get('/demo/catalog').query({ q: sampleTitle }).expect(200);
      expect(searchRes.body.items.length).toBeGreaterThan(0);
      for (const item of searchRes.body.items) {
        const matches = item.title.toLowerCase().includes(sampleTitle.toLowerCase()) || (item.description ?? '').toLowerCase().includes(sampleTitle.toLowerCase());
        expect(matches).toBe(true);
      }
    });

    it('GET /demo/catalog/:shopId/:productId returns product detail with shop information', async () => {
      const catRes = await http.get('/demo/catalog').expect(200);
      const sample = catRes.body.items[0];

      const detailRes = await http.get(`/demo/catalog/${sample.shop.id}/${sample.id}`).expect(200);
      expect(detailRes.body.currency).toBe('VND');
      expect(detailRes.body.shop).toEqual(sample.shop);
      expect(detailRes.body.product.id).toBe(sample.id);

      // Inactive or non-existent product returns 404
      await http.get(`/demo/catalog/${sample.shop.id}/non-existent-product-id-999`).expect(404);
    });
  });

  describe('Multi-Shop Cart & Checkout Isolation', () => {
    it('buyer can add items from multiple shops to cart and view them grouped by shop', async () => {
      const ids = (await http.get('/demo/identities')).body;
      const buyer = ids.buyers[0];
      const buyerSess = (await http.post('/demo/sessions').send({ role: 'BUYER', email: buyer.email, password: '123' }).expect(201)).body;

      const shops = await prisma.shop.findMany({ where: { status: 'ACTIVE' }, include: { products: { include: { skus: true } } } });
      const shopA = shops[0];
      const shopB = shops[1];

      const skuA = shopA.products[0].skus[0];
      const skuB = shopB.products[0].skus[0];

      // Add item from Shop A
      await http
        .put(`/demo/shops/${shopA.id}/cart/items`)
        .set('x-demo-session', buyerSess.sessionToken)
        .send({ skuId: skuA.externalId, quantity: 2 })
        .expect(200);

      // Add item from Shop B
      await http
        .put(`/demo/shops/${shopB.id}/cart/items`)
        .set('x-demo-session', buyerSess.sessionToken)
        .send({ skuId: skuB.externalId, quantity: 3 })
        .expect(200);

      // Check shop-scoped cart A
      const cartA = await http
        .get(`/demo/shops/${shopA.id}/cart`)
        .set('x-demo-session', buyerSess.sessionToken)
        .expect(200);
      expect(cartA.body.items).toHaveLength(1);
      expect(cartA.body.items[0].skuId).toBe(skuA.externalId);

      // Check grouped marketplace cart: GET /demo/cart
      const marketplaceCart = await http
        .get('/demo/cart')
        .set('x-demo-session', buyerSess.sessionToken)
        .expect(200);

      expect(marketplaceCart.body.currency).toBe('VND');
      expect(marketplaceCart.body.shops).toHaveLength(2);
      expect(marketplaceCart.body.itemCount).toBe(5);

      const groupA = marketplaceCart.body.shops.find((s: any) => s.shop.id === shopA.id);
      const groupB = marketplaceCart.body.shops.find((s: any) => s.shop.id === shopB.id);
      expect(groupA).toBeDefined();
      expect(groupB).toBeDefined();
      expect(groupA.items[0].skuId).toBe(skuA.externalId);
      expect(groupB.items[0].skuId).toBe(skuB.externalId);

      // Checkout only Shop A from cart
      const checkoutRes = await http
        .post(`/demo/shops/${shopA.id}/checkout`)
        .set('x-demo-session', buyerSess.sessionToken)
        .send({ checkoutKey: 'checkout-marketplace-test-1' })
        .expect(201);
      expect(checkoutRes.body.order.shopId).toBe(shopA.id);

      // Shop A cart is now empty, but Shop B cart item remains!
      const cartAAfter = await http
        .get(`/demo/shops/${shopA.id}/cart`)
        .set('x-demo-session', buyerSess.sessionToken)
        .expect(200);
      expect(cartAAfter.body.items).toHaveLength(0);

      const cartBAfter = await http
        .get(`/demo/shops/${shopB.id}/cart`)
        .set('x-demo-session', buyerSess.sessionToken)
        .expect(200);
      expect(cartBAfter.body.items).toHaveLength(1);
      expect(cartBAfter.body.items[0].skuId).toBe(skuB.externalId);

      // GET /demo/buyer/orders returns all orders with shop info
      const buyerOrders = await http
        .get('/demo/buyer/orders')
        .set('x-demo-session', buyerSess.sessionToken)
        .expect(200);
      expect(buyerOrders.body.items.length).toBeGreaterThan(0);
      const placedOrder = buyerOrders.body.items.find((o: any) => o.id === checkoutRes.body.order.id);
      expect(placedOrder).toBeDefined();
      expect(placedOrder.shop).toMatchObject({ id: shopA.id, name: shopA.name });
    });

    it('places one order per shop, pays, chats and lists coupons/aftersale in a shop other than the default one', async () => {
      const ids = (await http.get('/demo/identities')).body;
      const buyer = ids.buyers[0];
      const sess = (await http.post('/demo/sessions').send({ role: 'BUYER', email: buyer.email, password: '123' }).expect(201)).body;
      const auth = { 'x-demo-session': sess.sessionToken };

      // two shops, neither of them has to be the buyer's own one
      const others = await prisma.shop.findMany({ where: { status: 'ACTIVE', id: { not: sess.shopId } }, include: { products: { include: { skus: true } } }, orderBy: { id: 'asc' }, take: 2 });
      expect(others).toHaveLength(2);
      const [one, two] = others;
      const placed: { shopId: string; orderId: string }[] = [];
      for (const shop of [one, two]) {
        const sku = shop.products.find((p) => p.skus.length)!.skus[0];
        await http.put(`/demo/shops/${shop.id}/cart/items`).set(auth).send({ skuId: sku.externalId, quantity: 1 }).expect(200);
        const r = await http.post(`/demo/shops/${shop.id}/checkout`).set(auth).send({ checkoutKey: `cross-shop-${shop.id}` }).expect(201);
        expect(r.body.order.shopId).toBe(shop.id);
        placed.push({ shopId: shop.id, orderId: r.body.order.id });
      }

      const all = (await http.get('/demo/buyer/orders').set(auth).expect(200)).body.items;
      expect(placed.every((p) => all.some((o: any) => o.id === p.orderId && o.shop.id === p.shopId))).toBe(true);

      // pay in the second shop through the shop-scoped endpoint
      const paid = await http.post(`/demo/shops/${two.id}/orders/${placed[1].orderId}/pay`).set(auth).expect(201);
      expect(paid.body.order.shopId).toBe(two.id);

      // chat, coupons and aftersale take the shop from the URL, not from the session
      await http.post(`/demo/shops/${two.id}/chat/messages`).set(auth).send({ text: 'Hello from another shop' }).expect(201);
      const convs = (await http.get(`/demo/shops/${two.id}/chat/conversations`).set(auth).expect(200)).body.items;
      expect(convs).toHaveLength(1);
      expect((await http.get(`/demo/shops/${one.id}/chat/conversations`).set(auth).expect(200)).body.items).toHaveLength(0);
      await http.get(`/demo/shops/${two.id}/coupons`).set(auth).expect(200);
      await http.get(`/demo/shops/${two.id}/aftersale`).set(auth).expect(200);
    });
  });
});
