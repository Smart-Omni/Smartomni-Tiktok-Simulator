import request from 'supertest';
import { AppConfig } from '../src/config/config';
import { computeApiSignature } from '../src/tiktok/signature';

/** Test helpers that drive the simulator the way SmartOmni (and the Seller/Buyer UIs) would: only over HTTP. */
export class TiktokTestClient {
  constructor(
    readonly http: ReturnType<typeof request>,
    readonly cfg: AppConfig,
  ) {}

  private isShopA = (x: { shops: { name: string }[] }) => x.shops.some((sh) => sh.name.includes('Mộc Lan'));

  async sellerSession(index: 0 | 1) {
    const ids = (await this.http.get('/demo/identities')).body;
    const seller = index === 0 ? ids.sellers.find(this.isShopA) : ids.sellers.find((x: any) => x.shops.some((sh: any) => sh.name.includes('Bát Tràng')));
    const sess = (await this.http.post('/demo/sessions').send({ role: 'SELLER', email: seller.email, password: '123' }).expect(201)).body;
    return { token: sess.sessionToken as string, shopId: sess.shopId as string };
  }

  async buyerSession(index: 0 | 1, buyerIndex = 0) {
    const ids = (await this.http.get('/demo/identities')).body;
    const seller = await this.sellerSession(index);
    const buyers = ids.buyers.filter((b: any) => b.shopId === seller.shopId);
    const sess = (await this.http.post('/demo/sessions').send({ role: 'BUYER', email: buyers[buyerIndex].email, password: '123' }).expect(201)).body;
    return { token: sess.sessionToken as string, shopId: sess.shopId as string, buyerId: buyers[buyerIndex].id as string };
  }

  /** Consent + token exchange for the shop at `index`; returns the raw access token. */
  async connect(index: 0 | 1) {
    const seller = await this.sellerSession(index);
    const res = await this.http
      .post('/demo/authorization/consent')
      .set('x-demo-session', seller.token)
      .send({ app_key: this.cfg.seed.appKey, decision: 'accept', state: 's' })
      .expect(201);
    const code = new URL(res.body.redirectUrl).searchParams.get('code')!;
    const tok = await this.http.get('/api/v2/token/get').query({ app_key: this.cfg.seed.appKey, app_secret: this.cfg.seed.appSecret, auth_code: code, grant_type: 'authorized_code' }).expect(200);
    return { seller, accessToken: tok.body.data.access_token as string, refreshToken: tok.body.data.refresh_token as string };
  }

  /** Signed call, the body is signed exactly as sent. */
  call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, accessToken: string, opts: { query?: Record<string, string>; body?: unknown; rawBody?: string; secret?: string } = {}) {
    const q: Record<string, string> = { app_key: this.cfg.seed.appKey, timestamp: String(Math.floor(Date.now() / 1000)), ...(opts.query ?? {}) };
    const raw = opts.rawBody ?? (opts.body === undefined ? '' : JSON.stringify(opts.body));
    q.sign = computeApiSignature(opts.secret ?? this.cfg.seed.appSecret, path, q, raw);
    const r = { GET: () => this.http.get(path), POST: () => this.http.post(path), PUT: () => this.http.put(path), DELETE: () => this.http.delete(path) }[method]();
    r.query(q).set('x-tts-access-token', accessToken).set('content-type', 'application/json');
    return method === 'GET' ? r : r.send(raw);
  }

  /** Buyer checkout through /demo for a SKU of the buyer's shop. */
  checkout(buyer: { token: string; shopId: string }, items: { skuId: string; quantity: number }[], checkoutKey: string) {
    return this.http.post(`/demo/shops/${buyer.shopId}/checkout`).set('x-demo-session', buyer.token).send({ checkoutKey, items });
  }

  pay(buyer: { token: string; shopId: string }, orderId: string) {
    return this.http.post(`/demo/shops/${buyer.shopId}/orders/${orderId}/pay`).set('x-demo-session', buyer.token).send({});
  }
}
