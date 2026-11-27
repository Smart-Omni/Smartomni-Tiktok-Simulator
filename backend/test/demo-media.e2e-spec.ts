import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { APP_CONFIG, AppConfig } from '../src/config/config';
import { imageInfo } from '../src/media/image-info';
import { PrismaService } from '../src/prisma/prisma.service';
import { computeApiSignature } from '../src/tiktok/signature';
import { createApp, resetToSeed } from './helpers';
import { jpegBytes, pngBytes, webpBytes } from './images';
import { TiktokTestClient } from './tiktok-client';

describe('Product images stored in PostgreSQL (/demo media)', () => {
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

  async function sellerSessions() {
    const ids = (await http.get('/demo/identities').expect(200)).body;
    const [a, b] = ids.sellers as { id: string; email: string; shops: { id: string }[] }[];
    const sa = (await http.post('/demo/sessions').send({ role: 'SELLER', email: a.email, password: '123' }).expect(201)).body;
    const sb = (await http.post('/demo/sessions').send({ role: 'SELLER', email: b.email, password: '123' }).expect(201)).body;
    const buyer = (await http.post('/demo/sessions').send({ role: 'BUYER', email: ids.buyers[0].email, password: '123' }).expect(201)).body;
    return { sa, sb, buyer };
  }

  it('reads the format and size from the bytes', () => {
    expect(imageInfo(pngBytes(640, 480))).toEqual({ mimeType: 'image/png', width: 640, height: 480 });
    expect(imageInfo(jpegBytes(1024, 768))).toEqual({ mimeType: 'image/jpeg', width: 1024, height: 768 });
    expect(imageInfo(webpBytes(300, 200))).toEqual({ mimeType: 'image/webp', width: 300, height: 200 });
    expect(imageInfo(Buffer.from('GIF89a........'))).toBeUndefined();
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff]))).toBeUndefined();
  });

  it('stores an upload and serves the same bytes publicly with its content type', async () => {
    const { sa } = await sellerSessions();
    const bytes = pngBytes(800, 600, 2048);
    const up = await http
      .post(`/demo/shops/${sa.shopId}/media/images`)
      .set('x-demo-session', sa.sessionToken)
      .attach('file', bytes, { filename: 'photo.png', contentType: 'image/png' })
      .expect(201);
    expect(up.body).toMatchObject({ width: 800, height: 600, mimeType: 'image/png', sizeBytes: bytes.length });
    expect(up.body.uri).toMatch(/^sim-media\/[0-9a-f-]{36}$/);
    const id = up.body.uri.slice('sim-media/'.length);
    expect(up.body.url).toMatch(new RegExp(`/demo/media/images/${id}$`));

    const got = await http.get(`/demo/media/images/${id}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cache-control']).toContain('max-age');
    expect(Buffer.compare(got.body as Buffer, bytes)).toBe(0);

    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
    expect(row.shopId).toBe(sa.shopId);
  });

  it('trusts the bytes, not the declared type or file name', async () => {
    const { sa } = await sellerSessions();
    const up = await http
      .post(`/demo/shops/${sa.shopId}/media/images`)
      .set('x-demo-session', sa.sessionToken)
      .attach('file', jpegBytes(120, 90), { filename: 'x.png', contentType: 'image/png' })
      .expect(201);
    expect(up.body.mimeType).toBe('image/jpeg');

    const fake = await http
      .post(`/demo/shops/${sa.shopId}/media/images`)
      .set('x-demo-session', sa.sessionToken)
      .attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { filename: '../../evil.png', contentType: 'image/png' })
      .expect(400);
    expect(fake.body.message).toMatch(/JPEG, PNG or WebP/);
    expect(await prisma.mediaAsset.count()).toBe(1);
  });

  it('rejects a missing file, a file over 5 MB, another shop and a buyer', async () => {
    const { sa, sb, buyer } = await sellerSessions();
    await http.post(`/demo/shops/${sa.shopId}/media/images`).set('x-demo-session', sa.sessionToken).field('note', 'no file').expect(400);
    await http
      .post(`/demo/shops/${sa.shopId}/media/images`)
      .set('x-demo-session', sa.sessionToken)
      .attach('file', pngBytes(10, 10, 5 * 1024 * 1024), { filename: 'big.png', contentType: 'image/png' })
      .expect(413);
    await http.post(`/demo/shops/${sa.shopId}/media/images`).set('x-demo-session', sb.sessionToken).attach('file', pngBytes(10, 10), 'a.png').expect(403);
    await http.post(`/demo/shops/${buyer.shopId}/media/images`).set('x-demo-session', buyer.sessionToken).attach('file', pngBytes(10, 10), 'a.png').expect(403);
    await http.post(`/demo/shops/${sa.shopId}/media/images`).attach('file', pngBytes(10, 10), 'a.png').expect(401);
    expect(await prisma.mediaAsset.count()).toBe(0);
  });

  it('TikTok Upload Product Image stores a real picture; a request without one keeps the placeholder answer', async () => {
    const cfg = app.get<AppConfig>(APP_CONFIG);
    const t = new TiktokTestClient(http, cfg);
    const { seller, accessToken } = await t.connect(0);
    const path = '/product/202309/images/upload';
    // multipart bodies are not part of the signature (no raw JSON body), as for the other upload operations
    const q: Record<string, string> = { app_key: cfg.seed.appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
    q.sign = computeApiSignature(cfg.seed.appSecret, path, q, '');
    const bytes = webpBytes(500, 500);
    const up = await http.post(path).query(q).set('x-tts-access-token', accessToken).field('use_case', 'MAIN_IMAGE').attach('data', bytes, 'a.webp').expect(200);
    expect(up.body.code).toBe(0);
    expect(up.body.data).toMatchObject({ width: 500, height: 500, use_case: 'MAIN_IMAGE' });
    const id = up.body.data.uri.slice('sim-media/'.length);
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id } })).shopId).toBe(seller.shopId);
    await http.get(new URL(up.body.data.url).pathname).expect(200).expect('content-type', 'image/webp');

    const legacy = await t.call('POST', path, accessToken, { body: { image_data: 'base64-data' } }).expect(200);
    expect(legacy.body.data.url).toBeDefined();
    expect(await prisma.mediaAsset.count()).toBe(1);
  });

  it('answers 404 for a malformed or unknown id', async () => {
    await http.get('/demo/media/images/not-a-uuid').expect(404);
    await http.get('/demo/media/images/00000000-0000-4000-8000-000000000000').expect(404);
  });
});
