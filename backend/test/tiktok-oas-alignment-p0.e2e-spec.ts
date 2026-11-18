import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { SeedService } from '../src/seed/seed.service';
import { cleanDb, createApp } from './helpers';
import { TiktokTestClient } from './tiktok-client';

describe('OAS alignment P0: catalog metadata, brands, categories, query params', () => {
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

  describe('P0-1 category attributes / rules', () => {
    it('serves attributes for a leaf category with OAS field names', async () => {
      const r = await t.call('GET', '/product/202309/categories/100002/attributes', token).expect(200);
      expect(r.body.code).toBe(0);
      const attr = r.body.data.attributes[0];
      expect(attr).toEqual(expect.objectContaining({ id: expect.any(String), type: expect.any(String), is_requried: expect.any(Boolean), values: expect.any(Array) }));
      expect(attr).not.toHaveProperty('is_required');
    });

    it('serves rules for a leaf category, VN supports COD, no EU fields', async () => {
      const r = await t.call('GET', '/product/202309/categories/100002/rules', token, { query: { locale: 'vi-VN' } }).expect(200);
      expect(r.body.data.cod.is_supported).toBe(true);
      expect(r.body.data.package_dimension).toEqual({ is_required: false });
      expect(r.body.data).not.toHaveProperty('manufacturer');
      expect(r.body.data).not.toHaveProperty('responsible_person');
    });

    it('rejects non-leaf, unknown category and malformed locale with invalid_input', async () => {
      for (const path of ['/product/202309/categories/100001/attributes', '/product/202309/categories/999/rules']) {
        const r = await t.call('GET', path, token).expect(400);
        expect(r.body.simulator_fault.kind).toBe('invalid_input');
      }
      await t.call('GET', '/product/202309/categories/100002/attributes', token, { query: { locale: 'not a locale' } }).expect(400);
    });

    it('rejects an invalid access token', async () => {
      await t.call('GET', '/product/202309/categories/100002/attributes', 'not-a-token').expect((res) => {
        if (res.status < 400) throw new Error(`expected an error, got ${res.status}`);
      });
    });

    it('old non-OAS paths answer 501 unsupported_operation', async () => {
      for (const path of ['/product/202309/attributes', '/product/202309/rules']) {
        const r = await t.call('GET', path, token).expect(501);
        expect(r.body.simulator_fault.kind).toBe('unsupported_operation');
      }
    });
  });

  describe('P0-2 brands', () => {
    it('requires page_size in [1, 100]', async () => {
      await t.call('GET', '/product/202309/brands', token).expect(400);
      await t.call('GET', '/product/202309/brands', token, { query: { page_size: '0' } }).expect(400);
      await t.call('GET', '/product/202309/brands', token, { query: { page_size: '101' } }).expect(400);
    });

    it('paginates with page_token and reports total_count', async () => {
      const first = await t.call('GET', '/product/202309/brands', token, { query: { page_size: '2' } }).expect(200);
      expect(first.body.data.brands).toHaveLength(2);
      expect(first.body.data.total_count).toBe(5);
      expect(first.body.data.next_page_token).not.toBe('');
      const second = await t.call('GET', '/product/202309/brands', token, { query: { page_size: '10', page_token: first.body.data.next_page_token } }).expect(200);
      expect(second.body.data.brands).toHaveLength(3);
      expect(second.body.data.next_page_token).toBe('');
      await t.call('GET', '/product/202309/brands', token, { query: { page_size: '2', page_token: 'garbage' } }).expect(400);
    });

    it('filters by brand_name prefix and is_authorized; category adds brand_status', async () => {
      const byName = await t.call('GET', '/product/202309/brands', token, { query: { page_size: '10', brand_name: 'sam' } }).expect(200);
      expect(byName.body.data.brands.map((b: any) => b.name)).toEqual(['Samsung']);
      const authorized = await t.call('GET', '/product/202309/brands', token, { query: { page_size: '10', is_authorized: 'true', category_id: '100002' } }).expect(200);
      expect(authorized.body.data.brands.length).toBeGreaterThan(0);
      for (const b of authorized.body.data.brands) {
        expect(b.authorized_status).toBe('AUTHORIZED');
        expect(b.brand_status).toBe('AVAILABLE');
      }
      await t.call('GET', '/product/202309/brands', token, { query: { page_size: '10', category_id: 'nope' } }).expect(400);
    });
  });

  describe('P0-3 categories', () => {
    it('returns OAS fields and hides restricted categories by default', async () => {
      const r = await t.call('GET', '/product/202309/categories', token).expect(200);
      const cats = r.body.data.categories as any[];
      expect(cats[0]).toEqual(expect.objectContaining({ id: expect.any(String), parent_id: expect.any(String), local_name: expect.any(String), is_leaf: expect.any(Boolean), permission_statuses: expect.any(Array) }));
      expect(cats.some((c) => c.permission_statuses.includes('INVITE_ONLY'))).toBe(false);
      const all = await t.call('GET', '/product/202309/categories', token, { query: { include_prohibited_categories: 'true' } }).expect(200);
      expect(all.body.data.categories.some((c: any) => c.permission_statuses.includes('INVITE_ONLY'))).toBe(true);
    });

    it('filters by keyword on local_name and validates booleans', async () => {
      const r = await t.call('GET', '/product/202309/categories', token, { query: { keyword: 'áo' } }).expect(200);
      expect(r.body.data.categories.map((c: any) => c.id).sort()).toEqual(['100002', '100004']);
      await t.call('GET', '/product/202309/categories', token, { query: { include_prohibited_categories: 'maybe' } }).expect(400);
    });
  });

  describe('P0-4 query params on existing routes', () => {
    it('product detail accepts draft/under-review flags and locale, rejects bad values', async () => {
      const list = await t.call('POST', '/product/202502/products/search', token, { query: { page_size: '1' }, body: {} }).expect(200);
      const id = list.body.data.products[0].id as string;
      await t.call('GET', `/product/202309/products/${id}`, token, { query: { return_draft_version: 'true', return_under_review_version: 'false', locale: 'vi-VN' } }).expect(200);
      await t.call('GET', `/product/202309/products/${id}`, token, { query: { return_draft_version: 'x' } }).expect(400);
      await t.call('GET', `/product/202309/products/${id}`, token, { query: { locale: '!!' } }).expect(400);
    });

    it('conversation list and messages accept locale and reject a malformed one', async () => {
      await t.call('GET', '/customer_service/202309/conversations', token, { query: { page_size: '5', locale: 'vi-VN' } }).expect(200);
      await t.call('GET', '/customer_service/202309/conversations', token, { query: { page_size: '5', locale: '!!' } }).expect(400);
    });
  });
});
