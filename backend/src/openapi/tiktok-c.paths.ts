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

const PR = 'TikTok Product';
const strArr = { type: 'array', items: str() };
const errorsData = obj({ errors: { type: 'array', items: obj({ code: { type: 'integer', description: '-1 simulator sentinel' }, message: str(), detail: obj({ product_id: str() }) }) } });

Object.assign(paths, {
  '/product/202309/products/{productId}/prices/update': {
    post: sop({
      tag: PR,
      summary: 'Update Price (202309)',
      description: 'Updates SKU prices of an ACTIVATE product in one transaction (a bad SKU rejects the whole batch). VND integer amounts; existing orders keep their snapshot prices.',
      handler: 'ProductsController.updatePrice',
      scope: 'sim.product.write',
      pathParams: [{ name: 'productId' }],
      body: obj({ skus: { type: 'array', items: loose } }),
    }),
  },
  '/product/202309/inventory/search': {
    post: sop({
      tag: PR,
      summary: 'Inventory Search (202309)',
      description: 'Inventory by product_ids (max 100) or sku_ids (max 600; wins when both are sent). Ids of other shops are ignored. total_committed_quantity counts units of open orders (UNPAID to AWAITING_COLLECTION).',
      handler: 'ProductsController.inventorySearch',
      scope: 'sim.product.read',
      body: obj({ product_ids: strArr, sku_ids: strArr }),
      data: obj({ inventory: { type: 'array', items: loose } }),
    }),
  },
});
(paths['/product/202309/products'] ??= {}).delete = sop({
  tag: PR,
  summary: 'Delete Products (202309)',
  description: 'Soft delete (status DELETED, still visible to Search Products with that status). FREEZE and unknown ids are returned in errors; valid ids are still processed. Carts of the deleted SKUs are emptied.',
  handler: 'ProductsController.deleteProducts',
  scope: 'sim.product.write',
  body: obj({ product_ids: strArr }),
  data: errorsData,
});
paths['/product/202309/products/recover'] = {
  post: sop({
    tag: PR,
    summary: 'Recover Products (202309)',
    description: 'DELETED -> SELLER_DEACTIVATED. Other states are returned in errors.',
    handler: 'ProductsController.recoverProducts',
    scope: 'sim.product.write',
    body: obj({ product_ids: strArr }),
    data: errorsData,
  }),
};

const FU = 'TikTok Fulfillment';
const CS = 'TikTok Conversations';
const errorsPkg = obj({ errors: { type: 'array', items: obj({ code: { type: 'integer', description: '-1 simulator sentinel' }, message: str(), detail: obj({ package_id: str() }) }) } });
Object.assign(paths, {
  '/fulfillment/202309/packages/search': {
    post: sop({
      tag: FU,
      summary: 'Search Package (202309)',
      description: 'Keyset pagination on (create or update time, id). page_size [1, 50] is required. Status values are the package statuses the simulator stores (TO_FULFILL before shipment is arranged, then PROCESSING, FULFILLING, COMPLETED, CANCELLED).',
      handler: 'FulfillmentController.search',
      scope: 'sim.fulfillment.read',
      query: [
        { name: 'page_size', required: true, schema: { type: 'integer', minimum: 1, maximum: 50 }, example: 20 },
        { name: 'page_token' },
        { name: 'sort_field', description: 'create_time (default) or update_time.' },
        { name: 'sort_order', description: 'DESC (default) or ASC.' },
      ],
      body: obj({ create_time_ge: { type: 'integer' }, create_time_lt: { type: 'integer' }, update_time_ge: { type: 'integer' }, update_time_lt: { type: 'integer' }, package_status: str() }),
      data: obj({ packages: { type: 'array', items: loose }, next_page_token: str(), total_count: { type: 'integer' } }),
    }),
  },
  '/fulfillment/202309/packages/ship': {
    post: sop({
      tag: FU,
      summary: 'Batch Ship Packages (202309)',
      description: 'Arranges each package like Ship Package, one transaction per package. Failures (unknown package, wrong state, self_shipment) are listed in errors and never block the other packages.',
      handler: 'FulfillmentController.batchShip',
      scope: 'sim.fulfillment.write',
      body: obj({ packages: { type: 'array', items: loose } }),
      data: errorsPkg,
    }),
  },
  '/customer_service/202309/conversations': {
    post: sop({
      tag: CS,
      summary: 'Create Conversation (202309)',
      description: 'Returns the buyer\'s conversation with the shop, creating it when missing. NEW_CONVERSATION is emitted only on creation.',
      handler: 'ConversationsController.create',
      scope: 'sim.conversation.write',
      body: obj({ buyer_user_id: str() }),
      data: obj({ conversation_id: str() }),
    }),
  },
  '/customer_service/202309/conversations/{conversationId}/messages/read': {
    post: sop({
      tag: CS,
      summary: 'Read Message (202309)',
      description: 'Marks every buyer message as read; unread_count becomes 0 until the buyer writes again.',
      handler: 'ConversationsController.read',
      scope: 'sim.conversation.write',
      pathParams: [{ name: 'conversationId' }],
    }),
  },
});
