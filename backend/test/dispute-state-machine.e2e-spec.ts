import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { cleanDb, createApp } from './helpers';
import { conformErrors } from './contract';

describe('Dispute State Machine and Webhook Trigger', () => {
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
    await cleanDb(prisma);
    await app.get(SeedService).seedAll();
  });

  describe('State Machine Transitions', () => {
    it('creates a new dispute in DISPUTE_PENDING_REVIEW state', async () => {
      const res = await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_001',
          order_id: 'order_123',
          status: 'DISPUTE_PENDING_REVIEW',
          reason: 'Buyer claims product not received',
        })
        .expect(200);

      expect(res.body.code).toBe(0);
      expect(res.body.data.dispute_id).toBe('disp_test_001');
      expect(res.body.data.dispute_status).toBe('DISPUTE_PENDING_REVIEW');
      expect(res.body.data.webhook_dispatched).toBe(false);

      // Verify state was saved
      const getRes = await http.get('/api/v2/simulator/dispute/disp_test_001').expect(200);
      expect(getRes.body.data.status).toBe('DISPUTE_PENDING_REVIEW');
    });

    it('transitions DISPUTE_PENDING_REVIEW -> DISPUTE_APPROVED and fires Webhook', async () => {
      // 1. Initial review state
      await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_002',
          order_id: 'order_456',
          status: 'DISPUTE_PENDING_REVIEW',
        })
        .expect(200);

      // 2. Transition to APPROVED
      const res = await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_002',
          order_id: 'order_456',
          status: 'DISPUTE_APPROVED',
          reason: 'Valid proof provided; approved for compensation',
          compensation_amount: 150000,
          webhook_url: 'http://localhost:8080/api/v1/integrations/tiktok/webhook',
        })
        .expect(200);

      expect(res.body.code).toBe(0);
      expect(res.body.data.dispute_id).toBe('disp_test_002');
      expect(res.body.data.dispute_status).toBe('DISPUTE_APPROVED');
      expect(res.body.data.webhook_dispatched).toBe(true);
      expect(res.body.data.webhook_enqueued).toBe(true);
      expect(res.body.data.compensation).toMatchObject({
        type: 'COMPENSATION',
        adjustment_type: 'ADJUSTMENT',
        amount: 150000,
        currency: 'VND',
      });
      expect(res.body.data.adjustment).toMatchObject({
        type: 'COMPENSATION',
        adjustment_type: 'ADJUSTMENT',
        amount: 150000,
        currency: 'VND',
      });

      // 3. Verify webhook job was enqueued in database
      const jobs = await prisma.webhookJob.findMany({
        where: { topic: 'DISPUTE_STATUS_CHANGE' },
      });
      expect(jobs.length).toBeGreaterThan(0);

      const job = jobs[jobs.length - 1];
      expect(job.targetUrl).toBe('http://localhost:8080/api/v1/integrations/tiktok/webhook');

      const payload = job.payload as any;
      expect(payload.type).toBe(15);
      expect(payload.data.dispute_id).toBe('disp_test_002');
      expect(payload.data.dispute_status).toBe('DISPUTE_APPROVED');
      expect(payload.data.compensation.amount).toBe(150000);
      expect(payload.data.adjustment.amount).toBe(150000);

      // Verify envelope conformity against official TikTok webhook JSON schema
      expect(conformErrors('webhook-envelope.json', payload)).toEqual([]);
    });

    it('transitions DISPUTE_PENDING_REVIEW -> DISPUTE_REJECTED without compensation webhook', async () => {
      // 1. Initial review
      await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_003',
          order_id: 'order_789',
          status: 'DISPUTE_PENDING_REVIEW',
        })
        .expect(200);

      const beforeCount = await prisma.webhookJob.count({ where: { topic: 'DISPUTE_STATUS_CHANGE' } });

      // 2. Reject
      const res = await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_003',
          order_id: 'order_789',
          status: 'DISPUTE_REJECTED',
          reason: 'Seller delivered item according to carrier tracking',
        })
        .expect(200);

      expect(res.body.code).toBe(0);
      expect(res.body.data.dispute_status).toBe('DISPUTE_REJECTED');
      expect(res.body.data.webhook_dispatched).toBe(false);

      const afterCount = await prisma.webhookJob.count({ where: { topic: 'DISPUTE_STATUS_CHANGE' } });
      expect(afterCount).toBe(beforeCount);
    });

    it('enforces terminal state: DISPUTE_APPROVED cannot be transitioned to DISPUTE_REJECTED', async () => {
      // Approve dispute
      await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_004',
          status: 'DISPUTE_APPROVED',
        })
        .expect(200);

      // Try to reject approved dispute -> rejected with 400
      const res = await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_004',
          status: 'DISPUTE_REJECTED',
        })
        .expect(400);

      expect(res.body.message).toContain('already in DISPUTE_APPROVED state');
    });

    it('enforces terminal state: DISPUTE_REJECTED cannot be transitioned to DISPUTE_APPROVED', async () => {
      // Reject dispute
      await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_005',
          status: 'DISPUTE_REJECTED',
        })
        .expect(200);

      // Try to approve rejected dispute -> rejected with 400
      const res = await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_005',
          status: 'DISPUTE_APPROVED',
        })
        .expect(400);

      expect(res.body.message).toContain('already in DISPUTE_REJECTED state');
    });

    it('handles idempotent triggers gracefully when status remains the same', async () => {
      await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_006',
          status: 'DISPUTE_APPROVED',
          compensation_amount: 50000,
        })
        .expect(200);

      // Re-triggering APPROVED on already APPROVED dispute succeeds idempotently
      const res = await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_006',
          status: 'DISPUTE_APPROVED',
        })
        .expect(200);

      expect(res.body.code).toBe(0);
      expect(res.body.data.dispute_status).toBe('DISPUTE_APPROVED');
    });

    it('rejects invalid status values with 400 Bad Request', async () => {
      const res = await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_test_invalid',
          status: 'SOME_UNKNOWN_STATUS',
        })
        .expect(400);

      expect(res.status).toBe(400);
      expect(res.body.message).toBe('Validation failed');
    });
  });

  describe('Dispute Querying', () => {
    it('lists all simulated disputes and returns single dispute by id', async () => {
      await http
        .post('/api/v2/simulator/dispute/trigger')
        .send({
          dispute_id: 'disp_list_001',
          status: 'DISPUTE_PENDING_REVIEW',
        })
        .expect(200);

      const listRes = await http.get('/api/v2/simulator/dispute').expect(200);
      expect(listRes.body.code).toBe(0);
      expect(Array.isArray(listRes.body.data.disputes)).toBe(true);
      expect(listRes.body.data.disputes.some((d: any) => d.disputeId === 'disp_list_001')).toBe(true);

      const detailRes = await http.get('/api/v2/simulator/dispute/disp_list_001').expect(200);
      expect(detailRes.body.data.disputeId).toBe('disp_list_001');
      expect(detailRes.body.data.status).toBe('DISPUTE_PENDING_REVIEW');

      // Non-existent dispute returns 404
      await http.get('/api/v2/simulator/dispute/non_existent_id_999').expect(404);
    });
  });
});
