import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PersistentBusinessClock } from '../src/clock/clock';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { webhookSignature } from '../src/webhooks/webhook-worker.service';
import {
  buildProductStatusChangeData,
  buildReverseStatusUpdateData,
  buildSellerDeauthorizationData,
  buildUpcomingAuthExpirationData,
  WEBHOOK_TYPE,
} from '../src/webhooks/webhook-emitter.service';
import { ADMIN_TOKEN, cleanDb, createApp } from './helpers';
import { TiktokTestClient } from './tiktok-client';
import { signWebhook, verifyWebhook } from '../../contracts/signing/sign';

const admin = { 'x-test-admin-token': ADMIN_TOKEN };
const BAG = 'sim-sku-a-BAG-NAT';
const HOOKS = '/event/202309/webhooks';

describe('TikTok OpenAPI 202602 / 202309 / 202606 Upgrade & Dispute State Machine', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cfg: AppConfig;
  let http: ReturnType<typeof request>;
  let t: TiktokTestClient;

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
    await cleanDb(prisma);
    await app.get(SeedService).seedAll();
    await app.get(PersistentBusinessClock).reset();
  });

  const advanceClock = (ms: number) => http.put('/test-admin/clock').set(admin).send({ advanceMs: ms }).expect(200);
  const transition = (id: string, to: string) => http.post(`/test-admin/orders/${id}/transition`).set(admin).send({ to }).expect(201);

  const paidOrder = async (buyer: { token: string; shopId: string }, key: string, quantity = 1, sku = BAG) => {
    const c = await t.checkout(buyer, [{ skuId: sku, quantity }], key).expect(201);
    const id = c.body.order.id as string;
    await t.pay(buyer, id).expect(201);
    await advanceClock((cfg.orders.holdMinutes + 1) * 60_000);
    await http.post('/test-admin/orders/release-due').set(admin).expect(201);
    return id;
  };

  const deliveredOrder = async (buyer: { token: string; shopId: string }, key: string, qty = 1) => {
    const id = await paidOrder(buyer, key, qty);
    for (const to of ['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED']) await transition(id, to);
    return id;
  };

  const askReturn = (buyer: { token: string; shopId: string }, orderId: string, quantity = 1, returnType = 'REFUND', sellerProposedReturnType?: string) =>
    http
      .post(`/demo/shops/${buyer.shopId}/aftersale/returns`)
      .set('x-demo-session', buyer.token)
      .send({ orderId, items: [{ skuId: BAG, quantity }], returnType, sellerProposedReturnType });

  const subscribe = (token: string, topic: string) =>
    t.call('PUT', HOOKS, token, { body: { event_type: topic, address: 'http://localhost:9/hook' } }).expect(200);

  // =========================================================================
  // BƯỚC 1: Webhook HMAC & Event Types
  // =========================================================================
  describe('Step 1: Webhook HMAC & Event Types', () => {
    it('computes HMAC signature conforming to HMAC-SHA256(secret, path + timestamp + rawBody)', () => {
      const secret = 'test-secret-123';
      const path = '/api/v1/webhook';
      const timestamp = '1730000000';
      const body = JSON.stringify({ event: 'test', data: { id: 1 } });

      const sigService = webhookSignature(secret, path, timestamp, body);
      const sigContract = signWebhook(path, timestamp, secret, body);

      expect(sigService).toBe(sigContract);
      expect(verifyWebhook(path, timestamp, secret, body, sigService)).toBe(true);
      expect(verifyWebhook(path, timestamp, 'wrong-secret', body, sigService)).toBe(false);
    });

    it('verifies standard WEBHOOK_TYPE mapping and payload builders for 4 core topics', () => {
      expect(WEBHOOK_TYPE.REVERSE_STATUS_UPDATE).toBe(4);
      expect(WEBHOOK_TYPE.PRODUCT_STATUS_CHANGE).toBe(5);
      expect(WEBHOOK_TYPE.SELLER_DEAUTHORIZATION).toBe(6);
      expect(WEBHOOK_TYPE.UPCOMING_AUTHORIZATION_EXPIRATION).toBe(7);

      const deauthData = buildSellerDeauthorizationData('shop-1', 'app-key-1');
      expect(deauthData.shop_id).toBe('shop-1');
      expect(deauthData.app_key).toBe('app-key-1');

      const expData = buildUpcomingAuthExpirationData('shop-1', 'app-key-1', 1800000000);
      expect(expData.shop_id).toBe('shop-1');
      expect(expData.expiration_time).toBe(1800000000);

      const revData = buildReverseStatusUpdateData({
        reverseId: 'rev-1',
        orderId: 'ord-1',
        reverseType: 'REFUND',
        reverseStatus: 'RETURN_OR_REFUND_REQUEST_PENDING',
        arbitrationStatus: 'IN_ARBITRATION',
      });
      expect(revData.reverse_id).toBe('rev-1');
      expect(revData.arbitration_status).toBe('IN_ARBITRATION');

      const prodData = buildProductStatusChangeData({
        productId: 'prod-1',
        status: 'ACTIVATE',
        auditStatus: 'APPROVED',
      });
      expect(prodData.product_id).toBe('prod-1');
      expect(prodData.audit_status).toBe('APPROVED');
    });
  });

  // =========================================================================
  // BƯỚC 2: After-Sales 202602 & Arbitration Workflow
  // =========================================================================
  describe('Step 2: After-Sales 202602 & Arbitration Workflow', () => {
    it('searches returns via POST /return_refund/202602/returns/search with filters and locale', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const orderId = await deliveredOrder(buyer, 'key-ret-202602-search');
      const retRes = await askReturn(buyer, orderId, 1, 'REFUND', 'DROP_OFF').expect(201);
      const retId = retRes.body.request.id as string;

      // Search without filters
      const res = await t
        .call('POST', '/return_refund/202602/returns/search', a.accessToken, {
          body: { page_size: 10, locale: 'vi-VN' },
        })
        .expect(200);

      expect(res.body.code).toBe(0);
      expect(res.body.data.returns).toBeInstanceOf(Array);
      const found = res.body.data.returns.find((r: any) => r.return_id === retId);
      expect(found).toBeDefined();
      expect(found.arbitration_status).toBe('NO_ARBITRATION');
      expect(found.seller_proposed_return_type).toBe('DROP_OFF');
      expect(typeof found.return_reason_text).toBe('string');

      // Search with arbitration_status filter
      const resFiltered = await t
        .call('POST', '/return_refund/202602/returns/search', a.accessToken, {
          body: { page_size: 10, arbitration_status: 'NO_ARBITRATION' },
        })
        .expect(200);
      expect(resFiltered.body.data.returns.some((r: any) => r.return_id === retId)).toBe(true);

      const resEmpty = await t
        .call('POST', '/return_refund/202602/returns/search', a.accessToken, {
          body: { page_size: 10, arbitration_status: 'IN_ARBITRATION' },
        })
        .expect(200);
      expect(resEmpty.body.data.returns.some((r: any) => r.return_id === retId)).toBe(false);
    });

    it('transitions arbitration_status: NO_ARBITRATION -> IN_ARBITRATION -> ARBITRATION_WIN and emits REVERSE_STATUS_UPDATE', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken, 'REVERSE_STATUS_UPDATE');

      const buyer = await t.buyerSession(0);
      const orderId = await deliveredOrder(buyer, 'key-ret-dispute-flow');
      const retRes = await askReturn(buyer, orderId, 1, 'REFUND').expect(201);
      const retId = retRes.body.request.id as string;

      // Initial state
      let row = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: retId } });
      expect(row.arbitrationStatus).toBe('NO_ARBITRATION');

      // 1. Buyer files dispute
      const disputeRes = await http
        .post(`/demo/shops/${buyer.shopId}/aftersale/${retId}/dispute`)
        .set('x-demo-session', buyer.token)
        .send({ note: 'Seller refused refund unfairly' })
        .expect(201);
      expect(disputeRes.body.request.arbitrationStatus).toBe('IN_ARBITRATION');

      row = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: retId } });
      expect(row.arbitrationStatus).toBe('IN_ARBITRATION');

      // Verify webhook job was enqueued for dispute
      const disputeJobs = await prisma.webhookJob.findMany({
        where: { topic: 'REVERSE_STATUS_UPDATE' },
        orderBy: { createdAt: 'asc' },
      });
      expect(disputeJobs.length).toBeGreaterThan(0);
      const latestDisputeJob = disputeJobs[disputeJobs.length - 1];
      expect((latestDisputeJob.payload as any).type).toBe(4);
      expect((latestDisputeJob.payload as any).data.arbitration_status).toBe('IN_ARBITRATION');

      // 2. Admin / platform resolves dispute with WIN via demo endpoint
      const seller = await t.sellerSession(0);
      const adminArbitrateRes = await http
        .post(`/demo/shops/${buyer.shopId}/aftersale/${retId}/arbitrate`)
        .set('x-demo-session', seller.token)
        .send({ decision: 'ARBITRATION_WIN', note: 'Buyer evidence accepted' })
        .expect(201);
      expect(adminArbitrateRes.body.request.arbitrationStatus).toBe('ARBITRATION_WIN');

      row = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: retId } });
      expect(row.arbitrationStatus).toBe('ARBITRATION_WIN');

      // Check via search API
      const searchRes = await t
        .call('POST', '/return_refund/202602/returns/search', a.accessToken, {
          body: { page_size: 10, arbitration_status: 'ARBITRATION_WIN' },
        })
        .expect(200);
      expect(searchRes.body.data.returns.some((r: any) => r.return_id === retId)).toBe(true);

      // 3. Test terminal state idempotency and refusal
      await http
        .post(`/test-admin/aftersale/${retId}/arbitration`)
        .set(admin)
        .send({ decision: 'ARBITRATION_WIN' })
        .expect(201); // Idempotent repeat succeeds

      await http
        .post(`/test-admin/aftersale/${retId}/arbitration`)
        .set(admin)
        .send({ decision: 'ARBITRATION_LOSS' })
        .expect(400); // Terminal state cannot transition to a different decision

      // 4. Test ARBITRATION_LOSS on another return request via /test-admin
      const order2Id = await deliveredOrder(buyer, 'key-ret-dispute-loss');
      const ret2Res = await askReturn(buyer, order2Id, 1, 'REFUND').expect(201);
      const ret2Id = ret2Res.body.request.id as string;
      await http
        .post(`/test-admin/aftersale/${ret2Id}/arbitration`)
        .set(admin)
        .send({ decision: 'IN_ARBITRATION' })
        .expect(201);
      await http
        .post(`/test-admin/aftersale/${ret2Id}/arbitration`)
        .set(admin)
        .send({ decision: 'ARBITRATION_LOSS' })
        .expect(201);
      const row2 = await prisma.aftersaleRequest.findFirstOrThrow({ where: { externalId: ret2Id } });
      expect(row2.arbitrationStatus).toBe('ARBITRATION_LOSS');
    });

    it('returns aftersale eligibility via GET /return_refund/202602/orders/:order_id/aftersale_eligibility', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0);
      const orderId = await deliveredOrder(buyer, 'key-eligibility-test');

      const res = await t
        .call('GET', `/return_refund/202602/orders/${orderId}/aftersale_eligibility`, a.accessToken)
        .expect(200);

      expect(res.body.code).toBe(0);
      expect(res.body.data.request_types).toContain('REFUND');
      expect(res.body.data.request_types).toContain('RETURN_AND_REFUND');
      expect(res.body.data.request_types).toContain('EXCHANGE');
      expect(res.body.data.request_types).toContain('REPLACEMENT');
      expect(res.body.data.sku_eligibility).toBeDefined();
    });
  });

  // =========================================================================
  // BƯỚC 3: Product Write & Customer Service APIs
  // =========================================================================
  describe('Step 3: Product Management & Customer Service APIs', () => {
    it('creates, checks listing, updates, activates, deactivates, and searches products', async () => {
      const a = await t.connect(0);
      await subscribe(a.accessToken, 'PRODUCT_STATUS_CHANGE');

      // 1. Create product
      const createRes = await t
        .call('POST', '/product/202309/products', a.accessToken, {
          body: {
            title: 'Sản phẩm thử nghiệm Mộc Lan',
            description: 'Mô tả chi tiết sản phẩm thủ công mỹ nghệ',
            category_id: 'cat-vn-handicraft-01',
            brand_id: 'brand-moc-lan',
            skus: [{ outer_sku_id: 'SKU-TEST-001', price: { amount: '150000', currency: 'VND' }, inventory: [{ quantity: 10 }] }],
          },
        })
        .expect(200);

      expect(createRes.body.code).toBe(0);
      const newProductId = createRes.body.data.product_id;
      expect(newProductId).toBeDefined();

      // 2. Listing check
      const checkRes = await t
        .call('POST', '/product/202309/products/listing_check', a.accessToken, {
          body: { title: 'Sản phẩm thử nghiệm Mộc Lan', skus: [{ outer_sku_id: 'SKU-TEST-001' }] },
        })
        .expect(200);
      expect(checkRes.body.code).toBe(0);
      expect(checkRes.body.data.check_result).toBe('PASS');

      // 3. Update product
      const updateRes = await t
        .call('PUT', `/product/202509/products/${newProductId}`, a.accessToken, {
          body: { title: 'Sản phẩm thử nghiệm Mộc Lan - Đã cập nhật' },
        })
        .expect(200);
      expect(updateRes.body.code).toBe(0);

      // 4. Activate product
      const activateRes = await t
        .call('POST', '/product/202309/products/activate', a.accessToken, {
          body: { product_ids: [newProductId] },
        })
        .expect(200);
      expect(activateRes.body.code).toBe(0);

      // Verify webhook emitted with type 5
      const prodJobs = await prisma.webhookJob.findMany({
        where: { topic: 'PRODUCT_STATUS_CHANGE' },
      });
      expect(prodJobs.length).toBeGreaterThan(0);
      expect((prodJobs[0].payload as any).type).toBe(5);

      // 5. Deactivate product
      const deactivateRes = await t
        .call('POST', '/product/202309/products/deactivate', a.accessToken, {
          body: { product_ids: [newProductId] },
        })
        .expect(200);
      expect(deactivateRes.body.code).toBe(0);

      // 6. Metadata APIs: categories, attributes, brands, rules
      const catsRes = await t.call('GET', '/product/202309/categories', a.accessToken).expect(200);
      expect(catsRes.body.code).toBe(0);
      expect(catsRes.body.data.categories).toBeInstanceOf(Array);

      const attrsRes = await t.call('GET', '/product/202309/attributes', a.accessToken).expect(200);
      expect(attrsRes.body.code).toBe(0);

      const brandsRes = await t.call('GET', '/product/202309/brands', a.accessToken).expect(200);
      expect(brandsRes.body.code).toBe(0);

      const rulesRes = await t.call('GET', '/product/202309/rules', a.accessToken).expect(200);
      expect(rulesRes.body.code).toBe(0);

      // 7. Image and file upload
      const imgRes = await t.call('POST', '/product/202309/images/upload', a.accessToken, { body: { image_data: 'base64-data' } }).expect(200);
      expect(imgRes.body.code).toBe(0);
      expect(imgRes.body.data.url).toBeDefined();

      const fileRes = await t.call('POST', '/product/202309/files/upload', a.accessToken, { body: { file_name: 'cert.pdf' } }).expect(200);
      expect(fileRes.body.code).toBe(0);
      expect(fileRes.body.data.url).toBeDefined();

      // 8. Advanced search 202502 with audit_status, listing_platforms, sns_filter
      const searchRes = await t
        .call('POST', '/product/202502/products/search', a.accessToken, {
          body: {
            page_size: 10,
            audit_status: 'APPROVED',
            listing_platforms: ['TIKTOK_SHOP'],
            sns_filter: 'ALL',
          },
        })
        .expect(200);
      expect(searchRes.body.code).toBe(0);
      expect(searchRes.body.data.products).toBeInstanceOf(Array);
    });

    it('sends customer service messages (TEXT & IMAGE) and uploads chat images', async () => {
      const a = await t.connect(0);
      const buyer = await t.buyerSession(0, 0);

      // Create conversation by buyer initiating a chat message
      await http.post(`/demo/shops/${buyer.shopId}/chat/messages`).set('x-demo-session', buyer.token).send({ text: 'Xin chào shop' }).expect(201);

      // Get conversation ID from customer service list
      const convList = await t.call('GET', '/customer_service/202309/conversations', a.accessToken, { query: { page_size: '10' } }).expect(200);
      expect(convList.body.data.conversations.length).toBeGreaterThan(0);
      const convId = convList.body.data.conversations[0].id;

      // 1. Upload chat image
      const imgUpload = await t
        .call('POST', '/customer_service/202309/images/upload', a.accessToken, {
          body: { image_data: 'chat-image-base64' },
        })
        .expect(200);
      expect(imgUpload.body.code).toBe(0);
      expect(imgUpload.body.data.url).toBeDefined();

      // 2. Send TEXT message
      const textMsg = await t
        .call('POST', `/customer_service/202606/conversations/${convId}/messages`, a.accessToken, {
          body: { type: 'TEXT', content: JSON.stringify({ content: 'Xin chào, tôi cần hỗ trợ về đơn hàng.' }) },
        })
        .expect(200);
      expect(textMsg.body.code).toBe(0);
      expect(textMsg.body.data.message_id).toBeDefined();

      // 3. Send IMAGE message
      const imageMsg = await t
        .call('POST', `/customer_service/202606/conversations/${convId}/messages`, a.accessToken, {
          body: { type: 'IMAGE', content: JSON.stringify({ url: imgUpload.body.data.url }) },
        })
        .expect(200);
      expect(imageMsg.body.code).toBe(0);
      expect(imageMsg.body.data.message_id).toBeDefined();
    });
  });
});
