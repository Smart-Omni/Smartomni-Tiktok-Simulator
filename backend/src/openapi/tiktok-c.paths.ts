import { Json, Param, PathsFragment, envelope, obj, op, str } from './helpers';

/** Operations added by the OAS 0.1.7 alignment (docs/tts-toolkit-alignment.md). Compact builder: every one is a signed TikTok route. */
const COMMON_QUERY: Param[] = [
  { name: 'app_key', required: true, description: 'App key of the calling app.', example: 'sim_app_key' },
  { name: 'timestamp', required: true, description: 'Unix SECONDS (1-12 digits); stale and future values are rejected (401 stale_timestamp).', example: '1760000000' },
  { name: 'sign', required: true, description: 'HMAC signature over path + sorted query + raw body.', example: 'c0ffee…' },
  { name: 'shop_cipher', required: false, description: 'Optional; when sent it must equal the shop cipher of the access token (else 403 shop_cipher_mismatch).' },
];
const GUARD_ERRORS: Record<number, string> = {
  400: 'invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.',
  401: 'unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.',
  403: 'token_invalid, missing_scope or shop_cipher_mismatch.',
};

export interface SignedOp {
  tag: string;
  summary: string;
  description?: string;
  handler: string;
  scope: string;
  pathParams?: Param[];
  query?: Param[];
  body?: Json;
  data?: Json;
  errors?: Record<number, string>;
}

export const sop = (i: SignedOp): Json =>
  op({
    tag: i.tag,
    summary: i.summary,
    description: i.description,
    handler: i.handler,
    security: ['TiktokSignedApi'],
    scope: i.scope,
    pathParams: i.pathParams,
    query: [...COMMON_QUERY, ...(i.query ?? [])],
    ...(i.body ? { body: { schema: i.body, required: false } } : {}),
    ok: { description: 'Success envelope.', schema: envelope(i.data ?? obj({})) },
    errors: { ...GUARD_ERRORS, ...(i.errors ?? {}) },
    errorShape: 'tiktok',
  });

const AF = 'TikTok Aftersale';
const loose = obj({}, [], { additionalProperties: true });

export const paths: PathsFragment = {
  '/return_refund/202309/cancellations': {
    post: sop({
      tag: AF,
      summary: 'Seller Cancel Order (202309)',
      description: 'Cancels a whole order on behalf of the seller. Allowed in UNPAID, ON_HOLD and AWAITING_SHIPMENT without a package; partial lines are rejected (VN). Repeating the call returns the same cancel_id.',
      handler: 'AftersaleController.sellerCancel',
      scope: 'sim.aftersale.write',
      body: obj({ order_id: str(), cancel_reason: str(), order_line_item_ids: { type: 'array', items: str() }, skus: { type: 'array', items: loose } }),
      data: obj({ cancel_id: str(), cancel_status: str() }),
      errors: { 404: 'aftersale_not_found / order not in this shop.' },
    }),
  },
  '/return_refund/202309/returns': {
    post: sop({
      tag: AF,
      summary: 'Create Return (202309)',
      description: 'Creates a return on behalf of the buyer (role SELLER) for a DELIVERED/COMPLETED order in the return window. `idempotency_key` query: a repeat returns the same return_id. refund_total must not exceed the refundable amount.',
      handler: 'AftersaleController.createReturn',
      scope: 'sim.aftersale.write',
      query: [{ name: 'idempotency_key', description: '1-100 characters.' }],
      body: obj({ order_id: str(), return_type: str('REFUND | RETURN_AND_REFUND'), return_reason: str(), order_line_item_ids: { type: 'array', items: str() }, skus: { type: 'array', items: loose }, refund_total: str('VND integer string'), currency: str('VND') }),
      data: obj({ return_id: str(), return_status: str() }),
      errors: { 404: 'order not in this shop.' },
    }),
  },
  '/return_refund/202309/refunds/calculate': {
    post: sop({
      tag: AF,
      summary: 'Calculate Refund (202309)',
      description: 'Pure read: refund_subtotal = sum of what was paid per free unit; shipping refunded for CANCEL or the whole order; tax 0 (VN). Amounts are strings.',
      handler: 'AftersaleController.calculateRefund',
      scope: 'sim.aftersale.read',
      body: obj({ order_id: str(), request_type: str('CANCEL | REFUND | RETURN_AND_REFUND'), order_line_item_ids: { type: 'array', items: str() }, skus: { type: 'array', items: loose } }),
      data: obj({ order_refund_amount: obj({ currency: str(), refund_subtotal: str(), refund_shipping_fee: str(), refund_tax: str(), refund_total: str() }) }),
    }),
  },
};
