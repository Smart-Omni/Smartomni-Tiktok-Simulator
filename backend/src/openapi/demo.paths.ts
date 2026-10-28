import { Json, PathsFragment, arr, bool, int, obj, op, str } from './helpers';

/**
 * Demo router (`/demo/*`), derived from backend/src/demo/*.ts and the services they call.
 * Every error body is the Nest default (`NestError`). OrderRuleError/ChatRuleError/CouponRuleError extend BadRequestException and are thrown
 * with an object `{code, message}`, so their 400 body is that object (a stable machine `code` plus `message`) rather than the plain Nest shape.
 */

const SESSION = ['DemoSession'];
const shopId = { name: 'shopId', description: 'Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403.', example: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11' };
const UNAUTH = 'Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).';
const CROSS_SHOP = 'The path `shopId` is not the shop of the session (assertOwnShop).';
const VALIDATION = 'Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`).';
const NOT_BUYER = 'The session is not a BUYER session (buyerOf).';
const NOT_SELLER = 'The session is not a SELLER session.';
const base: Record<number, string> = { 401: UNAUTH, 403: CROSS_SHOP };

const idStr = (d: string, example?: string): Json => ({ ...str(d), ...(example ? { example } : {}) });

const OrderStatus: Json = str('Order status (OAS values).', { enum: ['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED'] });

const Recipient: Json = obj(
  {
    name: str('1-200 chars (trimmed)'),
    phone: str('5-30 chars (trimmed)'),
    addressLine: str('1-300 chars'),
    district: str('1-100 chars'),
    city: str('1-100 chars'),
    postalCode: str('max 20 chars', { nullable: true }),
  },
  ['name', 'phone', 'addressLine', 'district', 'city'],
);

const OrderView: Json = obj(
  {
    id: idStr('Marketplace order id (externalId).', '576011223344556677'),
    status: OrderStatus,
    createdAt: str(undefined, { format: 'date-time' }),
    updatedAt: str(undefined, { format: 'date-time' }),
    paidAt: str(undefined, { format: 'date-time', nullable: true }),
    releaseAt: str('End of the ON_HOLD period (business clock).', { format: 'date-time', nullable: true }),
    cancelReason: str(undefined, { nullable: true }),
    buyerRequestedCancel: bool('True while a buyer cancel request is awaiting the seller.'),
    recipient: obj({ name: str(), phone: str(), addressLine: str(), district: str(), city: str() }),
    buyer: obj({ id: str(), name: str() }),
    amounts: obj({
      currency: str(undefined, { example: 'VND' }),
      productTotalVnd: int(),
      sellerDiscountVnd: int(),
      platformDiscountVnd: int(),
      subTotalVnd: int('productTotal - sellerDiscount - platformDiscount'),
      shippingFeeVnd: int(),
      taxVnd: int(),
      totalVnd: int('subTotal + shipping + tax'),
    }),
    items: arr(obj({ skuId: str(), productId: str(), productName: str(), skuName: str(), sellerSku: str(), unitPriceVnd: int(), quantity: int('Units of this SKU in the order') })),
  },
  ['id', 'status', 'amounts', 'items'],
);

const orderExample = {
  id: '576011223344556677',
  status: 'UNPAID',
  createdAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
  paidAt: null,
  releaseAt: null,
  cancelReason: null,
  buyerRequestedCancel: false,
  recipient: { name: 'Nguyen Van A', phone: '0901234567', addressLine: '12 Le Loi', district: 'District 1', city: 'Ho Chi Minh City' },
  buyer: { id: '7400000000000001', name: 'Nguyen Van A' },
  amounts: { currency: 'VND', productTotalVnd: 250000, sellerDiscountVnd: 0, platformDiscountVnd: 0, subTotalVnd: 250000, shippingFeeVnd: 15000, taxVnd: 0, totalVnd: 265000 },
  items: [{ skuId: '751000000000001', productId: '750000000000001', productName: 'Ao thun', skuName: 'Size M', sellerSku: 'TSHIRT-M', unitPriceVnd: 125000, quantity: 2 }],
};

const CartItem: Json = obj(
  { skuId: str('SKU marketplace id'), productId: str(), productTitle: str(), skuName: str(), sellerSku: str(), quantity: int(), unitPriceVnd: int(), lineTotalVnd: int(), available: bool('Product on sale, SKU NORMAL and stock >= quantity') },
  ['skuId', 'quantity'],
);
const CartResponse: Json = obj({ currency: str(undefined, { example: 'VND' }), items: arr(CartItem), totalVnd: int() }, ['items', 'totalVnd']);

const SkuSeller: Json = obj({
  id: str('Row id (use this in PATCH /catalog/skus/{skuId})'),
  externalId: str('Marketplace SKU id'),
  sellerSku: str(),
  name: str(),
  attributeName: str(),
  priceVnd: int(),
  status: str(undefined, { enum: ['NORMAL', 'DEACTIVATED'] }),
  stock: arr(obj({ warehouseId: str('Warehouse external id'), warehouseName: str(), quantity: int() })),
  totalStock: int(),
});
const ProductSeller: Json = obj({
  id: str('Row id (UUID) used in the catalog PATCH/DELETE/skus paths'),
  externalId: str('Marketplace product id'),
  title: str(),
  description: str(),
  status: str(undefined, { enum: ['DRAFT', 'ACTIVATE', 'SELLER_DEACTIVATED', 'DELETED', 'PLATFORM_DEACTIVATED', 'FREEZE'] }),
  isNotForSale: bool(),
  createdAt: str(undefined, { format: 'date-time' }),
  updatedAt: str(undefined, { format: 'date-time' }),
  skus: arr(SkuSeller),
});
const productSellerExample = {
  id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  externalId: '7500123456789012',
  title: 'Ao thun co tron',
  description: 'Cotton 100%',
  status: 'ACTIVATE',
  isNotForSale: false,
  createdAt: '2026-10-15T08:00:00.000Z',
  updatedAt: '2026-10-15T08:00:00.000Z',
  skus: [
    {
      id: '5b1d7c9e-2f3a-4b5c-8d6e-7f8091a2b3c4',
      externalId: '7510123456789013',
      sellerSku: 'TSHIRT-M',
      name: 'Size M',
      attributeName: 'Kich thuoc',
      priceVnd: 125000,
      status: 'NORMAL',
      stock: [{ warehouseId: '7300000000000001', warehouseName: 'Main warehouse', quantity: 40 }],
      totalStock: 40,
    },
  ],
};

const StockMap: Json = { type: 'object', additionalProperties: int(undefined, { minimum: 0, maximum: 99999 }), description: 'Map of warehouse external id to quantity (0..99999). Unknown warehouse id => 400 `Unknown warehouse <id>`.', example: { '7300000000000001': 40 } };
const SkuInput: Json = obj(
  {
    sellerSku: str('1-100 chars (trimmed)'),
    name: str('1-200 chars (trimmed)'),
    attributeName: str('1-100 chars; defaults to "Phân loại"'),
    priceVnd: int('1..2,000,000,000', { minimum: 1, maximum: 2000000000 }),
    stock: StockMap,
  },
  ['sellerSku', 'name', 'priceVnd'],
);

const CouponSeller: Json = obj({
  id: str('Marketplace coupon id'),
  title: str(),
  promoCode: str('Upper-cased'),
  status: str('Derived from deactivated flag and business clock', { enum: ['NOT_START', 'ONGOING', 'EXPIRED', 'DEACTIVATED'] }),
  discountType: str(undefined, { enum: ['AMOUNT_OFF', 'PERCENT_OFF'] }),
  amountOffVnd: int(undefined, { nullable: true }),
  percentage: int(undefined, { nullable: true }),
  maxDiscountVnd: int(undefined, { nullable: true }),
  discountText: str(undefined, { example: '10% off (max 30000 VND)' }),
  minSpendVnd: int(undefined, { nullable: true }),
  startAt: str(undefined, { format: 'date-time' }),
  endAt: str(undefined, { format: 'date-time' }),
  redemptionLimit: int(undefined, { nullable: true }),
  redeemedCount: int(),
  audience: str(undefined, { enum: ['ALL', 'NEW'] }),
});
const couponExample = {
  id: '7700123456789012',
  title: 'Giam 10%',
  promoCode: 'SALE10',
  status: 'ONGOING',
  discountType: 'PERCENT_OFF',
  amountOffVnd: null,
  percentage: 10,
  maxDiscountVnd: 30000,
  discountText: '10% off (max 30000 VND)',
  minSpendVnd: 100000,
  startAt: '2026-10-15T00:00:00.000Z',
  endAt: '2026-12-31T00:00:00.000Z',
  redemptionLimit: 100,
  redeemedCount: 0,
  audience: 'ALL',
};

const AftersaleView: Json = obj({
  id: str('Marketplace request id (cancel_id / return_id)'),
  orderId: str(),
  kind: str(undefined, { enum: ['CANCELLATION', 'RETURN'] }),
  type: str('BUYER_CANCEL / CANCEL for cancellations; REFUND or RETURN_AND_REFUND for returns'),
  status: str('OAS status, e.g. CANCELLATION_REQUEST_PENDING, RETURN_OR_REFUND_REQUEST_PENDING, AWAITING_BUYER_SHIP, BUYER_SHIPPED_ITEM, RETURN_OR_REFUND_REQUEST_SUCCESS, REFUND_OR_RETURN_REQUEST_REJECT, REJECT_RECEIVE_PACKAGE, RETURN_OR_REFUND_REQUEST_CANCEL, ..._COMPLETE'),
  reason: str(),
  role: str('Who opened the request', { enum: ['BUYER', 'SELLER', 'SYSTEM'] }),
  rejectReason: str(undefined, { nullable: true }),
  returnTrackingNumber: str(undefined, { nullable: true }),
  buyer: obj({ id: str(), name: str() }),
  refund: obj({ subtotalVnd: int(), shippingVnd: int(), totalVnd: int() }),
  createdAt: str(undefined, { format: 'date-time' }),
  updatedAt: str(undefined, { format: 'date-time' }),
  items: arr(obj({ skuId: str(), productName: str(), skuName: str(), quantity: int() })),
});
const aftersaleExample = {
  id: '57900123456789',
  orderId: '576011223344556677',
  kind: 'RETURN',
  type: 'REFUND',
  status: 'RETURN_OR_REFUND_REQUEST_PENDING',
  reason: 'DAMAGED_ITEM',
  role: 'BUYER',
  rejectReason: null,
  returnTrackingNumber: null,
  buyer: { id: '7400000000000001', name: 'Nguyen Van A' },
  refund: { subtotalVnd: 125000, shippingVnd: 0, totalVnd: 125000 },
  createdAt: '2026-10-20T08:00:00.000Z',
  updatedAt: '2026-10-20T08:00:00.000Z',
  items: [{ skuId: '751000000000001', productName: 'Ao thun', skuName: 'Size M', quantity: 1 }],
};
const reqResp = (what: string): { description: string; schema: Json; example: unknown } => ({ description: what, schema: obj({ request: AftersaleView }, ['request']), example: { request: aftersaleExample } });
const decisionResp = (what: string): { description: string; schema: Json; example: unknown } => ({
  description: what,
  schema: obj({ changed: bool('false when the request was already in the target state (idempotent repeat)'), request: AftersaleView }, ['changed', 'request']),
  example: { changed: true, request: aftersaleExample },
});

const ChatMessageView: Json = obj({
  id: str('Marketplace message id'),
  index: int('Per-conversation order'),
  type: str(undefined, { example: 'TEXT' }),
  role: str(undefined, { enum: ['BUYER', 'SHOP', 'CUSTOMER_SERVICE', 'SYSTEM', 'ROBOT'] }),
  roleLabel: str(undefined, { example: 'Buyer' }),
  nickname: str(),
  at: str(undefined, { format: 'date-time' }),
  text: str('Null for unsupported types', { nullable: true }),
  supported: bool(),
  visible: bool(),
});
const chatMessageExample = { id: '5800123456789', index: 1, type: 'TEXT', role: 'BUYER', roleLabel: 'Buyer', nickname: 'Nguyen Van A', at: '2026-10-15T09:00:00.000Z', text: 'Con size L khong shop?', supported: true, visible: true };
const ConversationSummary: Json = obj({
  id: str('Row id (UUID); this is what `{conversationId}` in the demo chat paths expects'),
  externalId: str('Marketplace conversation id'),
  buyerNickname: str(),
  agentJoined: bool(),
  canSendMessage: bool(),
  unread: int('Buyer messages since the last non-buyer reply'),
  latest: { ...ChatMessageView, nullable: true },
  updatedAt: str(undefined, { format: 'date-time' }),
});
const TextBody: Json = obj({ text: str('1..2000 chars (the service additionally rejects whitespace-only text with 400 `invalid_text`)', { minLength: 1, maxLength: 2000 }) }, ['text']);

const FulfillmentView: Json = obj({
  orderId: str(),
  orderStatus: OrderStatus,
  package: {
    nullable: true,
    ...obj({ id: str('Package marketplace id'), status: str('TO_FULFILL, PROCESSING, FULFILLING, COMPLETED or CANCELLED'), trackingNumber: str(undefined, { nullable: true }), provider: str(), canArrange: bool('Only present in the seller view') }),
  },
  canArrange: bool('true only for a seller session when the order is AWAITING_SHIPMENT'),
  blockedReason: str('order_on_hold, order_unpaid or null', { nullable: true }),
  tracking: arr(obj({ status: str(), description: str(), at: str(undefined, { format: 'date-time' }) })),
});
const fulfillmentExample = {
  orderId: '576011223344556677',
  orderStatus: 'AWAITING_COLLECTION',
  package: { id: '5762123456789', status: 'PROCESSING', trackingNumber: 'SIM12345678901', provider: 'Simulator Express (fake carrier)', canArrange: false },
  canArrange: false,
  blockedReason: null,
  tracking: [{ status: 'PROCESSING', description: 'Seller has arranged the shipment. Waiting for the carrier to collect the parcel.', at: '2026-10-16T08:00:00.000Z' }],
};

const orderIdParam = { name: 'orderId', description: 'Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID.', example: '576011223344556677' };

export const paths: PathsFragment = {
  // ---------------------------------------------------------------- Demo Session
  '/demo/identities': {
    get: op({
      tag: 'Demo Session',
      summary: 'List sellers and buyers available for sign-in',
      description: 'Public. Reads all sellers (with their shops) and all buyers from the database, ordered by name; returns names and ids only, no tokens or contact data. Feeds the "sign in as" picker of the demo UIs.',
      handler: 'DemoController.identities',
      security: [],
      ok: {
        description: 'Sellers with shops, and buyers.',
        schema: obj(
          {
            sellers: arr(obj({ id: str(), name: str(), shops: arr(obj({ id: str(), name: str() })) })),
            buyers: arr(obj({ id: str(), name: str(), shopId: str() })),
          },
          ['sellers', 'buyers'],
        ),
        example: {
          sellers: [{ id: 'seller_1', name: 'Seller One', shops: [{ id: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11', name: 'Demo Shop VN' }] }],
          buyers: [{ id: 'buyer_1', name: 'Nguyen Van A', shopId: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11' }],
        },
      },
      errorShape: 'nest',
    }),
  },
  '/demo/sessions': {
    post: op({
      tag: 'Demo Session',
      summary: 'Create a demo session (sign in as seller or buyer)',
      description:
        'Public. Body is a zod union on `role`. SELLER: looks up the seller (404 if unknown) and picks `shopId` if given, else the seller\'s first shop (400 if the seller has no such shop). BUYER: looks up the buyer (404) and uses the buyer\'s shop. Stores only the SHA-256 hash of a random 32-byte token; the raw `sessionToken` is returned once. TTL comes from DEMO_SESSION_TTL_MS (default 8 h).',
      handler: 'DemoController.createSession',
      security: [],
      body: {
        schema: {
          oneOf: [
            obj({ role: str(undefined, { enum: ['SELLER'] }), sellerId: str('min 1 char'), shopId: str('optional; must belong to the seller') }, ['role', 'sellerId']),
            obj({ role: str(undefined, { enum: ['BUYER'] }), buyerId: str('min 1 char') }, ['role', 'buyerId']),
          ],
        },
        example: { role: 'SELLER', sellerId: 'seller_1' },
      },
      ok: {
        description: 'Session created. Send `sessionToken` as `x-demo-session` on later calls.',
        schema: obj({ sessionToken: str('64 hex chars, shown once'), role: str(undefined, { enum: ['SELLER', 'BUYER'] }), shopId: str(), buyerId: str(undefined, { nullable: true }), expiresAt: str(undefined, { format: 'date-time' }) }, ['sessionToken', 'role', 'shopId', 'expiresAt']),
        example: { sessionToken: '9f2c4e7a1b3d5f6089a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b', role: 'SELLER', shopId: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11', buyerId: null, expiresAt: '2026-10-15T16:00:00.000Z' },
      },
      status: 201,
      errors: { 400: `${VALIDATION} Also: the seller has no such shop.`, 404: 'Unknown seller (`Unknown seller`) or buyer (`Unknown buyer`).' },
      errorShape: 'nest',
    }),
  },
  '/demo/sessions/current': {
    delete: op({
      tag: 'Demo Session',
      summary: 'End the current session',
      description: 'Deletes the DemoSession row of the calling token (log out).',
      handler: 'DemoController.endSession',
      security: SESSION,
      ok: { description: 'Session deleted.', schema: obj({ ended: bool() }, ['ended']), example: { ended: true } },
      errors: { 401: UNAUTH },
      errorShape: 'nest',
    }),
  },
  '/demo/me': {
    get: op({
      tag: 'Demo Session',
      summary: 'Who am I',
      description: 'Returns the role and shop of the session, and the buyer profile for BUYER sessions (buyer is null for SELLER).',
      handler: 'DemoController.me',
      security: SESSION,
      ok: {
        description: 'Principal.',
        schema: obj({ role: str(undefined, { enum: ['SELLER', 'BUYER'] }), shop: obj({ id: str(), name: str(), region: str(), currency: str(), status: str() }), buyer: { nullable: true, ...obj({ id: str(), name: str(), city: str() }) } }, ['role', 'shop']),
        example: { role: 'BUYER', shop: { id: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11', name: 'Demo Shop VN', region: 'VN', currency: 'VND', status: 'ACTIVE' }, buyer: { id: 'buyer_1', name: 'Nguyen Van A', city: 'Ho Chi Minh City' } },
      },
      errors: { 401: UNAUTH },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}': {
    get: op({
      tag: 'Demo Session',
      summary: 'Shop profile with warehouses',
      description: 'Own shop only (assertOwnShop). Available to both roles.',
      handler: 'DemoController.shop',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Shop with its warehouses.',
        schema: obj({ id: str(), name: str(), region: str(), currency: str(), status: str(), warehouses: arr(obj({ id: str(), code: str(), name: str(), city: str() })) }),
        example: { id: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11', name: 'Demo Shop VN', region: 'VN', currency: 'VND', status: 'ACTIVE', warehouses: [{ id: 'w-uuid', code: 'WH-HCM', name: 'Main warehouse', city: 'Ho Chi Minh City' }] },
      },
      errors: base,
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/products': {
    get: op({
      tag: 'Demo Session',
      summary: 'Simple product list (id, title, SKUs with price)',
      description: 'Own shop only, either role. Plain list of every product of the shop ordered by title (including non-active ones) with SKUs ordered by seller SKU. For the seller catalog with stock use GET /demo/shops/{shopId}/catalog; for the buyer view use /storefront/products.',
      handler: 'DemoController.products',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Products.',
        schema: obj({ items: arr(obj({ id: str('Row id'), title: str(), description: str(), status: str(), skus: arr(obj({ id: str(), sellerSku: str(), name: str(), priceVnd: int() })) })), currency: str(undefined, { example: 'VND' }) }),
        example: { items: [{ id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', title: 'Ao thun co tron', description: 'Cotton 100%', status: 'ACTIVATE', skus: [{ id: '5b1d7c9e-2f3a-4b5c-8d6e-7f8091a2b3c4', sellerSku: 'TSHIRT-M', name: 'Size M', priceVnd: 125000 }] }], currency: 'VND' },
      },
      errors: base,
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/buyers': {
    get: op({
      tag: 'Demo Session',
      summary: 'List buyers of the shop (seller only)',
      description: 'Own shop and SELLER role required. Lists buyers of the shop ordered by name.',
      handler: 'DemoController.buyers',
      security: SESSION,
      pathParams: [shopId],
      ok: { description: 'Buyers.', schema: obj({ items: arr(obj({ id: str(), name: str(), city: str() })) }), example: { items: [{ id: 'buyer_1', name: 'Nguyen Van A', city: 'Ho Chi Minh City' }] } },
      errors: { ...base, 403: `${CROSS_SHOP} Or ${NOT_SELLER} (\`Only a seller session can list buyers\`).` },
      errorShape: 'nest',
    }),
  },
  '/demo/authorization/consent': {
    get: op({
      tag: 'Demo Session',
      summary: 'Seller consent page data',
      description:
        'SELLER session required (guarded, not public). The shop comes from the session. Calls OAuthService.consentContext: 400 if `app_key` is unknown, if `redirect_uri` is not exactly one of the app\'s registered URIs (or the app has none), or if `state` is longer than 512 chars / contains control characters. Without `redirect_uri` the first registered URI is used. Returns what the consent page displays; nothing secret.',
      handler: 'DemoController.consent',
      security: SESSION,
      query: [
        { name: 'app_key', required: true, schema: str(undefined, { minLength: 1, maxLength: 200 }), example: 'sim_app_key' },
        { name: 'redirect_uri', schema: str(undefined, { maxLength: 2000 }), example: 'https://smartomni.local/tiktok/callback' },
        { name: 'state', schema: str(undefined, { maxLength: 512 }), example: 'xyz123' },
      ],
      ok: {
        description: 'Consent context.',
        schema: obj({ app: obj({ appKey: str(), name: str() }), shop: obj({ id: str(), name: str(), region: str(), currency: str() }), scopes: arr(str()), redirectUri: str(), state: str(undefined, { nullable: true }) }),
        example: { app: { appKey: 'sim_app_key', name: 'SmartOmni' }, shop: { id: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11', name: 'Demo Shop VN', region: 'VN', currency: 'VND' }, scopes: ['order.read', 'product.read'], redirectUri: 'https://smartomni.local/tiktok/callback', state: 'xyz123' },
      },
      errors: { 400: `${VALIDATION} Also: unknown app_key, unregistered redirect_uri, invalid state.`, 401: UNAUTH, 403: NOT_SELLER },
      errorShape: 'nest',
    }),
    post: op({
      tag: 'Demo Session',
      summary: 'Accept or deny the app authorization',
      description:
        'SELLER session required. Validates app_key/redirect_uri/state like the GET, then on `accept` stores a single-use authorization code (hashed, TTL from config) for the session\'s shop and builds the redirect URL with `code` (+ echoed `state`); on `deny` the URL carries `error=access_denied`. The caller then sends the browser to `redirectUrl`; the app exchanges the code through the TikTok-router token endpoint.',
      handler: 'DemoController.decide',
      security: SESSION,
      body: {
        schema: obj(
          { app_key: str(undefined, { minLength: 1, maxLength: 200 }), redirect_uri: str(undefined, { maxLength: 2000 }), state: str(undefined, { maxLength: 512 }), decision: str(undefined, { enum: ['accept', 'deny'] }) },
          ['app_key', 'decision'],
        ),
        example: { app_key: 'sim_app_key', redirect_uri: 'https://smartomni.local/tiktok/callback', state: 'xyz123', decision: 'accept' },
      },
      ok: { description: 'Decision recorded.', schema: obj({ decision: str(undefined, { enum: ['accept', 'deny'] }), redirectUrl: str() }, ['decision', 'redirectUrl']), example: { decision: 'accept', redirectUrl: 'https://smartomni.local/tiktok/callback?code=sim_ac_abc123&state=xyz123' } },
      status: 201,
      errors: { 400: `${VALIDATION} Also: unknown app_key, unregistered redirect_uri, invalid state.`, 401: UNAUTH, 403: NOT_SELLER },
      errorShape: 'nest',
    }),
  },

  '/demo/catalog': {
    get: op({
      tag: 'Demo Catalog',
      summary: 'Public marketplace product catalog',
      description: 'Public, browsable by anyone. Returns active products across all active shops on the marketplace.',
      handler: 'CatalogDemoController.marketplaceCatalog',
      security: [],
      query: [
        { name: 'q', description: 'Search term for product title or description.', example: 'ao thun' },
        { name: 'shopId', description: 'Filter products by shop id.', example: '3f6c1d0e-8a54-4a52-9c7e-0d2b6f1a9b11' },
        { name: 'limit', description: 'Maximum products to return (1-100, default 20).', example: '20' },
        { name: 'cursor', description: 'Monotonic listing sequence cursor for keyset pagination.', example: '10' },
      ],
      ok: {
        description: 'Marketplace products.',
        schema: obj({
          currency: str(),
          items: arr(
            obj({
              id: str('Marketplace product id'),
              title: str(),
              description: str(),
              imageUrl: str('Relative URL of GET /demo/media/products/{file}'),
              minPriceVnd: int(),
              maxPriceVnd: int(),
              skus: arr(obj({ id: str('Marketplace SKU id'), name: str(), attributeName: str(), priceVnd: int(), available: bool(), stock: int() })),
              shop: obj({ id: str(), name: str() }),
            }),
          ),
          nextCursor: str(undefined, { nullable: true }),
        }),
      },
      errorShape: 'nest',
    }),
  },
  '/demo/catalog/{shopId}/{productId}': {
    get: op({
      tag: 'Demo Catalog',
      summary: 'Public marketplace product detail',
      description: 'Public. Returns product detail with shop information.',
      handler: 'CatalogDemoController.marketplaceProductDetail',
      security: [],
      pathParams: [shopId, { name: 'productId', description: 'Marketplace product id (externalId) or row UUID.', example: '7500123456789012' }],
      ok: {
        description: 'Product detail with shop info.',
        schema: obj({
          currency: str(),
          shop: obj({ id: str(), name: str() }),
          product: obj({ id: str(), title: str(), description: str(), imageUrl: str(), minPriceVnd: int(), maxPriceVnd: int(), skus: arr(obj({ id: str(), name: str(), attributeName: str(), priceVnd: int(), available: bool(), stock: int() })) }),
        }),
      },
      errors: { 404: 'Product not available.' },
      errorShape: 'nest',
    }),
  },

  // ---------------------------------------------------------------- Demo Catalog
  '/demo/shops/{shopId}/catalog': {
    get: op({
      tag: 'Demo Catalog',
      summary: 'Seller catalog with stock per warehouse',
      description: 'Own shop and SELLER role required. Returns all products (including DELETED ones, soft-deleted) in creation order with SKUs and per-warehouse stock, plus the shop\'s warehouses.',
      handler: 'CatalogDemoController.sellerList',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Catalog.',
        schema: obj({ currency: str(), warehouses: arr(obj({ externalId: str(), name: str(), city: str(), isDefault: bool() })), items: arr(ProductSeller) }),
        example: { currency: 'VND', warehouses: [{ externalId: '7300000000000001', name: 'Main warehouse', city: 'Ho Chi Minh City', isDefault: true }], items: [productSellerExample] },
      },
      errors: { 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER} (\`Only a seller session can change the catalog\`).` },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/catalog/products': {
    post: op({
      tag: 'Demo Catalog',
      summary: 'Create a product with SKUs',
      description: 'Own shop, SELLER only. In one transaction creates the product (new marketplace id) and each SKU, with one inventory row per shop warehouse (quantity from `stock`, default 0). Timestamps use the business clock. Any unknown warehouse key in `stock` => 400 and nothing is created.',
      handler: 'CatalogDemoController.create',
      security: SESSION,
      pathParams: [shopId],
      body: {
        schema: obj(
          {
            title: str('1-500 chars (trimmed)'),
            description: str('max 10000; default ""'),
            status: str('default ACTIVATE', { enum: ['DRAFT', 'ACTIVATE', 'SELLER_DEACTIVATED', 'DELETED'] }),
            skus: { type: 'array', items: SkuInput, minItems: 1, maxItems: 100 },
          },
          ['title', 'skus'],
        ),
        example: { title: 'Ao thun co tron', description: 'Cotton 100%', status: 'ACTIVATE', skus: [{ sellerSku: 'TSHIRT-M', name: 'Size M', attributeName: 'Kich thuoc', priceVnd: 125000, stock: { '7300000000000001': 40 } }] },
      },
      ok: { description: 'Created product.', schema: ProductSeller, example: productSellerExample },
      status: 201,
      errors: { 400: `${VALIDATION} Also: unknown warehouse in \`stock\`.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}` },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/catalog/products/{productId}': {
    patch: op({
      tag: 'Demo Catalog',
      summary: 'Edit product fields',
      description: 'Own shop, SELLER only. Product is found by its row id within the shop (another shop\'s product is reported as unknown, 404). A DELETED product cannot be edited (400). Body fields are all optional but at least one is required.',
      handler: 'CatalogDemoController.update',
      security: SESSION,
      pathParams: [shopId, { name: 'productId', description: 'Product row id (`id` in catalog responses, UUID), not the marketplace externalId.', example: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }],
      body: {
        schema: obj({ title: str('1-500'), description: str('max 10000'), status: str(undefined, { enum: ['DRAFT', 'ACTIVATE', 'SELLER_DEACTIVATED', 'DELETED'] }), isNotForSale: bool() }, [], { minProperties: 1 }),
        example: { status: 'SELLER_DEACTIVATED' },
      },
      ok: { description: 'Updated product.', schema: ProductSeller, example: { ...productSellerExample, status: 'SELLER_DEACTIVATED' } },
      errors: { 400: `${VALIDATION} Also: the product is DELETED.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown product (`Unknown product`).' },
      errorShape: 'nest',
    }),
    delete: op({
      tag: 'Demo Catalog',
      summary: 'Soft-delete a product',
      description: 'Own shop, SELLER only. Sets the status to DELETED (the row stays and remains visible to the TikTok Search Products). Repeating it is accepted.',
      handler: 'CatalogDemoController.remove',
      security: SESSION,
      pathParams: [shopId, { name: 'productId', description: 'Product row id (UUID).', example: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }],
      ok: { description: 'Product with status DELETED.', schema: ProductSeller, example: { ...productSellerExample, status: 'DELETED' } },
      errors: { 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown product.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/catalog/products/{productId}/skus': {
    post: op({
      tag: 'Demo Catalog',
      summary: 'Add a SKU to a product',
      description: 'Own shop, SELLER only. 404 for an unknown product, 400 if the product is DELETED, already has 100 SKUs, or `stock` names an unknown warehouse. Creates the SKU with an inventory row for every warehouse.',
      handler: 'CatalogDemoController.addSku',
      security: SESSION,
      pathParams: [shopId, { name: 'productId', description: 'Product row id (UUID).', example: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }],
      body: { schema: SkuInput, example: { sellerSku: 'TSHIRT-L', name: 'Size L', priceVnd: 130000, stock: { '7300000000000001': 25 } } },
      ok: { description: 'Product including the new SKU.', schema: ProductSeller, example: productSellerExample },
      status: 201,
      errors: { 400: `${VALIDATION} Also: deleted product, >100 SKUs, unknown warehouse.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown product.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/catalog/skus/{skuId}': {
    patch: op({
      tag: 'Demo Catalog',
      summary: 'Edit one SKU (price, name, status, stock)',
      description: 'Own shop, SELLER only. Changes only this SKU. Stock keys are warehouse external ids (unknown => 400); each changed warehouse row is locked, an inventory-history entry (source SELLER) is logged and the level upserted. Product `updatedAt` is bumped. 404 if the SKU is not in the shop; 400 if its product is DELETED.',
      handler: 'CatalogDemoController.updateSku',
      security: SESSION,
      pathParams: [shopId, { name: 'skuId', description: 'SKU row id (`skus[].id` in catalog responses, UUID).', example: '5b1d7c9e-2f3a-4b5c-8d6e-7f8091a2b3c4' }],
      body: {
        schema: obj(
          {
            sellerSku: str('1-100'),
            name: str('1-200'),
            attributeName: str('1-100'),
            priceVnd: int('1..2,000,000,000', { minimum: 1, maximum: 2000000000 }),
            status: str(undefined, { enum: ['NORMAL', 'DEACTIVATED'] }),
            stock: StockMap,
          },
          [],
          { minProperties: 1 },
        ),
        example: { priceVnd: 99000, stock: { '7300000000000001': 55 } },
      },
      ok: { description: 'The parent product with all its SKUs.', schema: ProductSeller, example: productSellerExample },
      errors: { 400: `${VALIDATION} Also: deleted product, unknown warehouse.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown SKU (`Unknown SKU`).' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/storefront/products': {
    get: op({
      tag: 'Demo Catalog',
      summary: 'Buyer storefront product list',
      description: 'Own shop, either role (no role check in the code). Only products with status ACTIVATE and not `isNotForSale`, in creation order. Each SKU shows `available` (SKU NORMAL and total stock > 0) and total `stock`, without the warehouse breakdown. `imageUrl` points to the public media endpoint.',
      handler: 'CatalogDemoController.storefront',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Storefront products.',
        schema: obj({
          currency: str(),
          items: arr(
            obj({
              id: str('Marketplace product id'),
              title: str(),
              description: str(),
              imageUrl: str('Relative URL of GET /demo/media/products/{file}'),
              minPriceVnd: int(),
              maxPriceVnd: int(),
              skus: arr(obj({ id: str('Marketplace SKU id'), name: str(), attributeName: str(), priceVnd: int(), available: bool(), stock: int() })),
            }),
          ),
        }),
        example: {
          currency: 'VND',
          items: [{ id: '7500123456789012', title: 'Ao thun co tron', description: 'Cotton 100%', imageUrl: '/demo/media/products/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.svg', minPriceVnd: 125000, maxPriceVnd: 130000, skus: [{ id: '7510123456789013', name: 'Size M', attributeName: 'Kich thuoc', priceVnd: 125000, available: true, stock: 40 }] }],
        },
      },
      errors: base,
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/storefront/products/{productId}': {
    get: op({
      tag: 'Demo Catalog',
      summary: 'Buyer storefront product detail',
      description: 'Own shop, either role. Looks the product up by MARKETPLACE id (externalId) so a link built from a catalog externalProductId works. 404 when it does not exist in the shop, is not ACTIVATE, or is `isNotForSale`.',
      handler: 'CatalogDemoController.storefrontDetail',
      security: SESSION,
      pathParams: [shopId, { name: 'productId', description: 'Marketplace product id (externalId).', example: '7500123456789012' }],
      ok: {
        description: 'Product (same shape as one storefront list item).',
        schema: obj({
          currency: str(),
          product: obj({ id: str(), title: str(), description: str(), imageUrl: str(), minPriceVnd: int(), maxPriceVnd: int(), skus: arr(obj({ id: str(), name: str(), attributeName: str(), priceVnd: int(), available: bool(), stock: int() })) }),
        }),
        example: { currency: 'VND', product: { id: '7500123456789012', title: 'Ao thun co tron', description: 'Cotton 100%', imageUrl: '/demo/media/products/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.svg', minPriceVnd: 125000, maxPriceVnd: 125000, skus: [{ id: '7510123456789013', name: 'Size M', attributeName: 'Kich thuoc', priceVnd: 125000, available: true, stock: 40 }] } },
      },
      errors: { ...base, 404: 'Product not available (`This product is not available`).' },
      errorShape: 'nest',
    }),
  },
  '/demo/media/products/{file}': {
    get: op({
      tag: 'Demo Catalog',
      summary: 'Placeholder product image (SVG)',
      description: 'Public (no guard; an <img> cannot send the session header). `file` is the product ROW id (UUID, 36 chars of [0-9a-f-]) with an optional `.svg` suffix; anything else is 404. Generates a 600x600 SVG whose colour and text derive from the title (first 28 chars). Sent with `Content-Type: image/svg+xml` and `Cache-Control: no-store`.',
      handler: 'CatalogDemoController.image',
      security: [],
      pathParams: [{ name: 'file', description: 'Product row id, optionally followed by `.svg`.', example: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.svg' }],
      ok: {
        description: 'SVG image.',
        contentType: 'image/svg+xml',
        schema: str('SVG markup', { format: 'binary' }),
        example: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="hsl(210,45%,86%)"/><text x="300" y="310" font-family="sans-serif" font-size="34" text-anchor="middle" fill="hsl(210,40%,25%)">Ao thun co tron</text></svg>',
      },
      errors: { 404: 'Malformed id or unknown product.' },
      errorShape: 'nest',
    }),
  },

  '/demo/cart': {
    get: op({
      tag: 'Demo Orders',
      summary: 'Marketplace buyer cart grouped by shop',
      description: 'BUYER only. Returns all items currently in the buyer\'s cart grouped by shop.',
      handler: 'OrdersDemoController.marketplaceCart',
      security: SESSION,
      ok: {
        description: 'Cart grouped by shop.',
        schema: obj({
          currency: str(),
          shops: arr(
            obj({
              shop: obj({ id: str(), name: str() }),
              items: arr(
                obj({
                  skuId: str(),
                  productId: str(),
                  productTitle: str(),
                  skuName: str(),
                  sellerSku: str(),
                  quantity: int(),
                  unitPriceVnd: int(),
                  lineTotalVnd: int(),
                  available: bool(),
                }),
              ),
              shopTotalVnd: int(),
            }),
          ),
          totalVnd: int(),
          itemCount: int(),
        }),
      },
      errors: { 401: UNAUTH, 403: NOT_BUYER },
      errorShape: 'nest',
    }),
  },
  '/demo/buyer/orders': {
    get: op({
      tag: 'Demo Orders',
      summary: 'Marketplace buyer orders across all shops',
      description: 'BUYER only. Returns all orders placed by the buyer across all shops with shop details.',
      handler: 'OrdersDemoController.marketplaceBuyerOrders',
      security: SESSION,
      ok: {
        description: 'Buyer orders.',
        schema: obj({ items: arr(OrderView) }),
      },
      errors: { 401: UNAUTH, 403: NOT_BUYER },
      errorShape: 'nest',
    }),
  },

  // ---------------------------------------------------------------- Demo Orders
  '/demo/shops/{shopId}/cart': {
    get: op({
      tag: 'Demo Orders',
      summary: 'Buyer cart',
      description: 'BUYER session only (buyerOf => 403 for sellers). Reads the buyer\'s cart lines via OrdersService.cart and totals them.',
      handler: 'OrdersDemoController.cart',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Cart.',
        schema: CartResponse,
        example: { currency: 'VND', items: [{ skuId: '7510123456789013', productId: '7500123456789012', productTitle: 'Ao thun co tron', skuName: 'Size M', sellerSku: 'TSHIRT-M', quantity: 2, unitPriceVnd: 125000, lineTotalVnd: 250000, available: true }], totalVnd: 250000 },
      },
      errors: { 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}` },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/cart/items': {
    put: op({
      tag: 'Demo Orders',
      summary: 'Set the quantity of a cart line',
      description: 'BUYER only. Upserts the buyer\'s cart line for the SKU (marketplace id, looked up within the session shop); `quantity` 0 removes the line. Responds with the updated cart. Stock is not checked here (only at checkout).',
      handler: 'OrdersDemoController.setCartItem',
      security: SESSION,
      pathParams: [shopId],
      body: { schema: obj({ skuId: str('SKU marketplace id (1-100 chars)'), quantity: int('0..20; 0 removes', { minimum: 0, maximum: 20 }) }, ['skuId', 'quantity']), example: { skuId: '7510123456789013', quantity: 2 } },
      ok: { description: 'Updated cart.', schema: CartResponse },
      errors: { 400: VALIDATION, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}`, 404: 'Unknown SKU in this shop.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/checkout': {
    post: op({
      tag: 'Demo Orders',
      summary: 'Checkout (create an UNPAID order)',
      description:
        'BUYER only. Items come from `items` or, if omitted, from the cart (cart is cleared only for a non-replayed cart checkout). Recipient defaults to the buyer\'s saved address. Idempotent per (buyer, checkoutKey): a repeat returns the original order with `replayed: true`. OrdersService.checkout merges quantities, then in one transaction validates SKUs/ACTIVATE status, picks ONE enabled warehouse that can fill every item (default warehouse first), decrements stock, optionally redeems `couponCode`, and creates the order UNPAID. Rule violations are 400 with `{code, message}` codes: invalid_quantity, empty_order, too_many_units (>50 units total), unknown_sku, not_for_sale, insufficient_stock, and coupon_not_found/deactivated/not_started/expired/min_spend/not_eligible/no_discount/exhausted.',
      handler: 'OrdersDemoController.checkout',
      security: SESSION,
      pathParams: [shopId],
      body: {
        schema: obj(
          {
            checkoutKey: str('Client-generated idempotency key, 8-100 chars', { minLength: 8, maxLength: 100 }),
            items: { type: 'array', maxItems: 50, items: obj({ skuId: str('SKU marketplace id'), quantity: int('1..20', { minimum: 1, maximum: 20 }) }, ['skuId', 'quantity']), description: 'If omitted the cart is used.' },
            recipient: Recipient,
            buyerMessage: str('max 500'),
            couponCode: str('1-20 chars; case-insensitive', { minLength: 1, maxLength: 20 }),
          },
          ['checkoutKey'],
        ),
        example: { checkoutKey: 'co-7f3a9c21-0001', items: [{ skuId: '7510123456789013', quantity: 2 }], couponCode: 'SALE10' },
      },
      ok: { description: 'The order (new or replayed).', schema: obj({ replayed: bool(), order: OrderView }, ['replayed', 'order']), example: { replayed: false, order: orderExample } },
      errors: { 400: `${VALIDATION} Or an order/coupon rule error (see description).`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}` },
      errorShape: 'nest',
      status: 201,
    }),
  },
  '/demo/shops/{shopId}/orders/{orderId}/pay': {
    post: op({
      tag: 'Demo Orders',
      summary: 'Fake payment',
      description: 'BUYER only, own order. UNPAID -> ON_HOLD with `paidAt` and `releaseAt` (business clock + configured hold minutes); the lifecycle worker later moves it to AWAITING_SHIPMENT. Any status other than UNPAID returns the order unchanged with `replayed: true`, except CANCELLED which is 400 `order_cancelled`. Not a TikTok API.',
      handler: 'OrdersDemoController.pay',
      security: SESSION,
      pathParams: [shopId, orderIdParam],
      ok: { description: 'Order after payment.', schema: obj({ replayed: bool(), order: OrderView }, ['replayed', 'order']), example: { replayed: false, order: { ...orderExample, status: 'ON_HOLD', paidAt: '2026-10-15T08:05:00.000Z', releaseAt: '2026-10-15T08:20:00.000Z' } } },
      status: 201,
      errors: { 400: 'Order is CANCELLED (`order_cancelled`).', 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}`, 404: 'Unknown order (or not this buyer\'s).' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/orders/{orderId}/cancel': {
    post: op({
      tag: 'Demo Orders',
      summary: 'Cancel an order (buyer cancel / request, or seller cancel)',
      description:
        'Both roles. BUYER (own order): UNPAID or ON_HOLD cancels immediately (stock and coupon redemption released); AWAITING_SHIPMENT does NOT cancel but opens an aftersale cancellation request that the seller must approve (the returned order shows `buyerRequestedCancel: true`); an already CANCELLED order is returned as is; any other status is 400 `cancel_not_allowed`. SELLER: transitions the order to CANCELLED through the state machine (invalid transition => 400 `invalid_transition`, e.g. already CANCELLED, IN_TRANSIT, DELIVERED or COMPLETED). Body is optional; `reason` defaults to "no reason given".',
      handler: 'OrdersDemoController.cancel',
      security: SESSION,
      pathParams: [shopId, orderIdParam],
      body: { required: false, schema: obj({ reason: str('1-300 chars; default "no reason given"', { minLength: 1, maxLength: 300 }) }), example: { reason: 'Changed my mind' } },
      ok: { description: 'Order after the cancel (or after the request was recorded).', schema: obj({ order: OrderView }, ['order']), example: { order: { ...orderExample, status: 'CANCELLED', cancelReason: 'Changed my mind' } } },
      status: 201,
      errors: { 400: `${VALIDATION} Or cancel_not_allowed / invalid_transition.`, 401: UNAUTH, 403: CROSS_SHOP, 404: 'Unknown order (buyer: not own order; seller: not in this shop).' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/orders': {
    get: op({
      tag: 'Demo Orders',
      summary: 'List orders',
      description: 'Buyer: own orders (OrdersService.listForBuyer). Seller: orders of the shop (listForShop, default take 100, no query parameters).',
      handler: 'OrdersDemoController.list',
      security: SESSION,
      pathParams: [shopId],
      ok: { description: 'Orders.', schema: obj({ items: arr(OrderView) }, ['items']), example: { items: [orderExample] } },
      errors: base,
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/orders/{orderId}': {
    get: op({
      tag: 'Demo Orders',
      summary: 'Order detail with status history',
      description: 'Seller: any order of the shop. Buyer: only own orders (others are 404, never 403). `history` is the OrderAudit trail.',
      handler: 'OrdersDemoController.detail',
      security: SESSION,
      pathParams: [shopId, orderIdParam],
      ok: {
        description: 'Order and its transitions.',
        schema: obj({ order: OrderView, history: arr(obj({ from: str(undefined, { nullable: true }), to: str(), actor: str(), note: str(), at: str(undefined, { format: 'date-time' }) })) }, ['order', 'history']),
        example: { order: orderExample, history: [{ from: null, to: 'UNPAID', actor: 'BUYER', note: 'checkout', at: '2026-10-15T08:00:00.000Z' }] },
      },
      errors: { ...base, 404: 'Unknown order.' },
      errorShape: 'nest',
    }),
  },

  // ---------------------------------------------------------------- Demo Fulfillment
  '/demo/shops/{shopId}/orders/{orderId}/arrange-shipment': {
    post: op({
      tag: 'Demo Fulfillment',
      summary: 'Arrange shipment (seller)',
      description: 'SELLER only. FulfillmentService.arrangeShipment: UNPAID/ON_HOLD => 400 `order_on_hold`, CANCELLED => 400 `order_cancelled`, AWAITING_SHIPMENT => moves to AWAITING_COLLECTION (creating tracking number and tracking event), already shipped orders return the existing package (repeat is a no-op); other statuses 400 `order_not_shippable`. Responds with the fulfillment view.',
      handler: 'FulfillmentDemoController.arrange',
      security: SESSION,
      pathParams: [shopId, orderIdParam],
      ok: { description: 'Fulfillment view.', schema: FulfillmentView, example: fulfillmentExample },
      status: 201,
      errors: { 400: 'order_on_hold / order_cancelled / order_not_shippable.', 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown order.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/orders/{orderId}/advance-shipment': {
    post: op({
      tag: 'Demo Fulfillment',
      summary: 'Advance one carrier step (seller)',
      description: 'SELLER only. Simulates the carrier: AWAITING_COLLECTION -> IN_TRANSIT -> DELIVERED. Any other order status is 400 `nothing_to_advance`. DELIVERED is not COMPLETED.',
      handler: 'FulfillmentDemoController.advance',
      security: SESSION,
      pathParams: [shopId, orderIdParam],
      ok: { description: 'Fulfillment view after the step.', schema: FulfillmentView, example: { ...fulfillmentExample, orderStatus: 'IN_TRANSIT', package: { ...fulfillmentExample.package, status: 'FULFILLING' } } },
      status: 201,
      errors: { 400: 'nothing_to_advance.', 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown order.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/orders/{orderId}/fulfillment': {
    get: op({
      tag: 'Demo Fulfillment',
      summary: 'Package and tracking of an order',
      description: 'Both roles. Buyer: only own orders (otherwise 404) and no seller-only fields (`package.canArrange` omitted, `canArrange` false). Seller: any order of the shop. `package` is null until a package exists (created when the order reaches AWAITING_SHIPMENT). `blockedReason` is order_on_hold, order_unpaid or null.',
      handler: 'FulfillmentDemoController.fulfillmentOf',
      security: SESSION,
      pathParams: [shopId, orderIdParam],
      ok: { description: 'Fulfillment view.', schema: FulfillmentView, example: fulfillmentExample },
      errors: { ...base, 404: 'Unknown order.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/orders/{orderId}/shipping-label': {
    post: op({
      tag: 'Demo Fulfillment',
      summary: 'Get/generate a shipping document URL (seller)',
      description: 'SELLER only. 404 if the order or its package does not exist. FulfillmentService.documentFor generates (once per package+type, idempotent) a fake PDF stamped "TEST DATA" and returns its public URL; 400 `package_not_arranged` when the package has no tracking number yet. Body optional; `documentType` defaults to SHIPPING_LABEL.',
      handler: 'FulfillmentDemoController.label',
      security: SESSION,
      pathParams: [shopId, orderIdParam],
      body: { required: false, schema: obj({ documentType: str('default SHIPPING_LABEL', { enum: ['SHIPPING_LABEL', 'PACKING_SLIP', 'SHIPPING_LABEL_AND_PACKING_SLIP'] }) }), example: { documentType: 'SHIPPING_LABEL' } },
      ok: {
        description: 'Document location.',
        schema: obj({ documentType: str(), trackingNumber: str(), url: str('Absolute URL (PUBLIC_API_BASE_URL) of GET /demo/files/shipping-documents/{file}') }, ['documentType', 'trackingNumber', 'url']),
        example: { documentType: 'SHIPPING_LABEL', trackingNumber: 'SIM12345678901', url: 'http://localhost:3000/demo/files/shipping-documents/3f9a1c5e7b2d4086a1c3e5f7091b2d4f6a8c0e1d3b5f7a92.pdf' },
      },
      status: 201,
      errors: { 400: `${VALIDATION} Or package_not_arranged.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown order, or the order has no package yet.' },
      errorShape: 'nest',
    }),
  },
  '/demo/files/shipping-documents/{file}': {
    get: op({
      tag: 'Demo Fulfillment',
      summary: 'Download a shipping document (PDF)',
      description: 'Public (no guard): the 48-hex-char token in the URL is the capability. `.pdf` suffix is stripped; a malformed or unknown token, or an unreadable file, is 404. Streams the stored PDF with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="shipping-document-TEST.pdf"` and `Cache-Control: no-store`. Content is test data only.',
      handler: 'FulfillmentDemoController.file',
      security: [],
      pathParams: [{ name: 'file', description: '48 lowercase hex chars, optional `.pdf` suffix (from the `url` returned by shipping-label).', example: '3f9a1c5e7b2d4086a1c3e5f7091b2d4f6a8c0e1d3b5f7a92.pdf' }],
      ok: { description: 'PDF bytes.', contentType: 'application/pdf', schema: str('PDF file', { format: 'binary' }) },
      errors: { 404: 'Unknown token or file missing.' },
      errorShape: 'nest',
    }),
  },

  // ---------------------------------------------------------------- Demo Aftersale
  '/demo/shops/{shopId}/aftersale': {
    get: op({
      tag: 'Demo Aftersale',
      summary: 'List aftersale requests',
      description: 'Both roles. Seller: the latest 200 requests (cancellations and returns) of the shop, newest first. Buyer: only requests on own orders. Also returns the reason pick-lists.',
      handler: 'AftersaleDemoController.list',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Requests and reason lists.',
        schema: obj({ items: arr(AftersaleView), requestReasons: arr(str()), rejectReasons: arr(obj({ name: str(), text: str() })) }, ['items']),
        example: {
          items: [aftersaleExample],
          requestReasons: ['CHANGED_MIND', 'DAMAGED_ITEM', 'NOT_AS_DESCRIBED', 'WRONG_ITEM', 'OTHER'],
          rejectReasons: [{ name: 'ITEM_AS_DESCRIBED', text: 'The item matches its description' }, { name: 'RETURN_WINDOW_EXPIRED', text: 'The request is outside the return window' }, { name: 'ITEM_USED_OR_DAMAGED', text: 'The returned item is used or damaged' }, { name: 'ALREADY_SHIPPED', text: 'The order has already been handed to the carrier' }, { name: 'OTHER', text: 'Other reason' }],
        },
      },
      errors: base,
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/aftersale/returns': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Buyer: request a return/refund',
      description: 'BUYER only. AftersaleService.createReturn: the order must be the buyer\'s (404) and DELIVERED/COMPLETED inside the return window (business clock) => else 400 `return_not_allowed` / `return_window_closed`; picks the requested number of units per SKU that are not already in an active request (400 `units_unavailable`; DB unique-index race => 409 `unit_already_requested`). Refund = what was paid for those units. The order status is not changed.',
      handler: 'AftersaleDemoController.createReturn',
      security: SESSION,
      pathParams: [shopId],
      body: {
        schema: obj(
          {
            orderId: str('Order marketplace id (1-100)'),
            items: { type: 'array', minItems: 1, maxItems: 50, items: obj({ skuId: str('SKU marketplace id'), quantity: int('1..50', { minimum: 1, maximum: 50 }) }, ['skuId', 'quantity']) },
            returnType: str(undefined, { enum: ['REFUND', 'RETURN_AND_REFUND'] }),
            reason: str('1-300 chars; default OTHER. Suggested: CHANGED_MIND, DAMAGED_ITEM, NOT_AS_DESCRIBED, WRONG_ITEM, OTHER (not enforced)'),
          },
          ['orderId', 'items', 'returnType'],
        ),
        example: { orderId: '576011223344556677', items: [{ skuId: '751000000000001', quantity: 1 }], returnType: 'REFUND', reason: 'DAMAGED_ITEM' },
      },
      ok: reqResp('Created request (status RETURN_OR_REFUND_REQUEST_PENDING).'),
      status: 201,
      errors: { 400: `${VALIDATION} Or return_not_allowed / return_window_closed / units_unavailable.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}`, 404: 'Unknown order (not this buyer\'s).', 409: 'A unit is already in an active aftersale request (`unit_already_requested`).' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/aftersale/cancellations': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Buyer: request cancellation of a paid order',
      description: 'BUYER only. For an AWAITING_SHIPMENT order creates a CANCELLATION request (pending seller approval) and flags the order `buyerRequestedCancel`; repeating while one is pending returns the same request. Other order statuses => 400 `cancel_not_allowed`; unknown/foreign order => 404. UNPAID/ON_HOLD orders are cancelled directly with POST .../orders/{orderId}/cancel instead.',
      handler: 'AftersaleDemoController.createCancellation',
      security: SESSION,
      pathParams: [shopId],
      body: { schema: obj({ orderId: str('1-100'), reason: str('1-300 chars; default CHANGED_MIND') }, ['orderId']), example: { orderId: '576011223344556677', reason: 'CHANGED_MIND' } },
      ok: reqResp('Pending cancellation request.'),
      status: 201,
      errors: { 400: `${VALIDATION} Or cancel_not_allowed.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}`, 404: 'Unknown order.', 409: 'A unit is already in an active aftersale request (`unit_already_requested`).' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/aftersale/{id}/cancel': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Buyer: withdraw a return request',
      description: 'BUYER only. Applies to RETURN requests only (a cancellation id is 404). Moves PENDING or AWAITING_BUYER_SHIP -> RETURN_OR_REFUND_REQUEST_CANCEL and frees the units; already cancelled is returned unchanged; other statuses 400 `invalid_decision`.',
      handler: 'AftersaleDemoController.buyerCancel',
      security: SESSION,
      pathParams: [shopId, { name: 'id', description: 'Aftersale request marketplace id (`id` of an aftersale view).', example: '57900123456789' }],
      ok: reqResp('Request after withdrawal.'),
      status: 201,
      errors: { 400: 'invalid_decision (request not in a cancellable status).', 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}`, 404: 'Unknown return request (or not on this buyer\'s order).' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/aftersale/{id}/ship-back': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Buyer: hand the approved return to the carrier',
      description: 'BUYER only, RETURN requests only. AWAITING_BUYER_SHIP -> BUYER_SHIPPED_ITEM and assigns a fake `SIMRET...` return tracking number; already shipped is returned unchanged; other statuses 400 `invalid_decision`.',
      handler: 'AftersaleDemoController.shipBack',
      security: SESSION,
      pathParams: [shopId, { name: 'id', description: 'Aftersale request marketplace id.', example: '57900123456789' }],
      ok: reqResp('Request after shipping back.'),
      status: 201,
      errors: { 400: 'invalid_decision (request is not AWAITING_BUYER_SHIP).', 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_BUYER}`, 404: 'Unknown return request.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/aftersale/{id}/approve': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Seller: approve a cancellation or return',
      description:
        'SELLER only. Looks the request up by id in the shop (404). CANCELLATION: PENDING -> cancels the order (stock restored) and the request becomes SUCCESS; already SUCCESS/COMPLETE => `changed: false`; other statuses 400 `invalid_decision`. RETURN: `decision` optional (inferred from type/status); supported APPROVE_REFUND (REFUND, PENDING->SUCCESS), APPROVE_RETURN (RETURN_AND_REFUND, PENDING->AWAITING_BUYER_SHIP), APPROVE_RECEIVED_PACKAGE (RETURN_AND_REFUND, BUYER_SHIPPED_ITEM->SUCCESS); others 400 `unsupported_decision`, mismatched type 400 `invalid_decision`. Repeating a decision that is already in effect returns `changed: false`. Stock is never added back for returns by the simulator.',
      handler: 'AftersaleDemoController.approve',
      security: SESSION,
      pathParams: [shopId, { name: 'id', description: 'Aftersale request marketplace id.', example: '57900123456789' }],
      body: { required: false, schema: obj({ decision: str('max 60; returns only', { enum: ['APPROVE_REFUND', 'APPROVE_RETURN', 'APPROVE_RECEIVED_PACKAGE'] }) }), example: { decision: 'APPROVE_REFUND' } },
      ok: decisionResp('Decision applied (or already in effect).'),
      status: 201,
      errors: { 400: `${VALIDATION} Or invalid_decision / unsupported_decision.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown aftersale request.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/aftersale/{id}/reject': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Seller: reject a cancellation or return',
      description:
        'SELLER only. `reason` must be one of the reject reasons (ITEM_AS_DESCRIBED, RETURN_WINDOW_EXPIRED, ITEM_USED_OR_DAMAGED, ALREADY_SHIPPED, OTHER) else 400 `invalid_reject_reason`. CANCELLATION: PENDING -> CANCELLATION_REQUEST_CANCELLED (order flag cleared). RETURN: `decision` inferred (REJECT_REFUND / REJECT_RETURN from PENDING, REJECT_RECEIVED_PACKAGE from BUYER_SHIPPED_ITEM); wrong state 400 `invalid_decision`, unknown decision 400 `unsupported_decision`. Repeating an applied rejection returns `changed: false`.',
      handler: 'AftersaleDemoController.reject',
      security: SESSION,
      pathParams: [shopId, { name: 'id', description: 'Aftersale request marketplace id.', example: '57900123456789' }],
      body: {
        schema: obj({ reason: str('1-100 chars; must be a reject-reason name', { enum: ['ITEM_AS_DESCRIBED', 'RETURN_WINDOW_EXPIRED', 'ITEM_USED_OR_DAMAGED', 'ALREADY_SHIPPED', 'OTHER'] }), comment: str('max 500'), decision: str('max 60; returns only', { enum: ['REJECT_REFUND', 'REJECT_RETURN', 'REJECT_RECEIVED_PACKAGE'] }) }, ['reason']),
        example: { reason: 'ITEM_AS_DESCRIBED', comment: 'Item matches the listing photos.' },
      },
      ok: decisionResp('Rejection applied (or already in effect).'),
      status: 201,
      errors: { 400: `${VALIDATION} Or invalid_reject_reason / invalid_decision / unsupported_decision.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown aftersale request.' },
      errorShape: 'nest',
    }),
  },

  // ---------------------------------------------------------------- Demo Chat
  '/demo/shops/{shopId}/chat/conversations': {
    get: op({
      tag: 'Demo Chat',
      summary: 'List conversations',
      description: 'Both roles. Buyer: only the buyer\'s own conversation(s); seller: every conversation of the shop, ordered by creation. `supportedTypes` lists message types the simulator renders (TEXT only); `unsupported` describes the rest.',
      handler: 'ChatDemoController.conversations',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Conversations with unread count and latest message.',
        schema: obj({ supportedTypes: arr(str()), unsupported: str(), items: arr(ConversationSummary) }, ['items']),
        example: {
          supportedTypes: ['TEXT'],
          unsupported: 'IMAGE, VIDEO, PRODUCT_CARD, ORDER_CARD, RETURN_REFUND_CARD, COUPON_CARD, LOGISTICS_CARD (uploads and cards are not simulated)',
          items: [{ id: '9d8c7b6a-5e4f-4a3b-9c2d-1e0f9a8b7c6d', externalId: '5900123456789', buyerNickname: 'Nguyen Van A', agentJoined: false, canSendMessage: true, unread: 1, latest: chatMessageExample, updatedAt: '2026-10-15T09:00:00.000Z' }],
        },
      },
      errors: base,
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/chat/conversations/{conversationId}/messages': {
    get: op({
      tag: 'Demo Chat',
      summary: 'Read messages of a conversation',
      description: 'Both roles. ChatService.assertParticipant: conversation looked up by ROW id within the shop (404 otherwise); a buyer who is not the conversation owner gets 403. Returns up to 500 visible messages by ascending `index`.',
      handler: 'ChatDemoController.messages',
      security: SESSION,
      pathParams: [shopId, { name: 'conversationId', description: 'Conversation ROW id (`id` of a conversation summary, UUID), not the marketplace externalId.', example: '9d8c7b6a-5e4f-4a3b-9c2d-1e0f9a8b7c6d' }],
      ok: { description: 'Conversation and messages.', schema: obj({ conversation: ConversationSummary, items: arr(ChatMessageView) }, ['conversation', 'items']), example: { conversation: { id: '9d8c7b6a-5e4f-4a3b-9c2d-1e0f9a8b7c6d', externalId: '5900123456789', buyerNickname: 'Nguyen Van A', agentJoined: false, canSendMessage: true, unread: 1, latest: chatMessageExample, updatedAt: '2026-10-15T09:00:00.000Z' }, items: [chatMessageExample] } },
      errors: { ...base, 403: `${CROSS_SHOP} Or the conversation belongs to another buyer.`, 404: 'Unknown conversation.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/chat/messages': {
    post: op({
      tag: 'Demo Chat',
      summary: 'Buyer: send a message to the shop',
      description: 'BUYER only. Gets or creates the buyer\'s single conversation with the shop (ChatService.conversationForBuyer), then posts a TEXT message with role BUYER; the message and its NEW_MESSAGE webhook event are written in one transaction. Whitespace-only text => 400 `invalid_text`.',
      handler: 'ChatDemoController.buyerSend',
      security: SESSION,
      pathParams: [shopId],
      body: { schema: TextBody, example: { text: 'Con size L khong shop?' } },
      ok: { description: 'Stored message.', schema: obj({ message: ChatMessageView }, ['message']), example: { message: chatMessageExample } },
      status: 201,
      errors: { 400: `${VALIDATION} Or invalid_text.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or only a buyer session can start a conversation.` },
      errorShape: 'nest',
    }),
  },
};

// Seller reply (and buyer continuation) share the path of the GET above.
paths['/demo/shops/{shopId}/chat/conversations/{conversationId}/messages'].post = op({
  tag: 'Demo Chat',
  summary: 'Reply in a conversation (seller, or buyer continuing)',
  description: 'Both roles. assertParticipant as for the GET (404 unknown, 403 another buyer\'s conversation). A SELLER is refused with 400 `cannot_send_message` when the conversation has `canSendMessage = false`. Posts a TEXT message with role SHOP (seller) or BUYER, plus its NEW_MESSAGE event, in one transaction.',
  handler: 'ChatDemoController.reply',
  security: SESSION,
  pathParams: [shopId, { name: 'conversationId', description: 'Conversation ROW id (UUID).', example: '9d8c7b6a-5e4f-4a3b-9c2d-1e0f9a8b7c6d' }],
  body: { schema: TextBody, example: { text: 'Dạ shop còn size L ạ.' } },
  ok: { description: 'Stored message.', schema: obj({ message: ChatMessageView }, ['message']), example: { message: { ...chatMessageExample, id: '5800123456790', index: 2, role: 'SHOP', roleLabel: 'Shop', nickname: 'Demo Shop VN', text: 'Dạ shop còn size L ạ.' } } },
  status: 201,
  errors: { 400: `${VALIDATION} Or invalid_text / cannot_send_message.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or the conversation belongs to another buyer.`, 404: 'Unknown conversation.' },
  errorShape: 'nest',
});

Object.assign(paths, {
  // ---------------------------------------------------------------- Demo Coupons
  '/demo/shops/{shopId}/coupons': {
    get: op({
      tag: 'Demo Coupons',
      summary: 'List coupons',
      description: 'Both roles. Seller: every coupon of the shop with status, counters and discount details. Buyer: only coupons usable right now (ONGOING on the business clock, not exhausted, and for audience NEW only if the buyer has no earlier non-cancelled order), with the code shown so it can be typed at checkout.',
      handler: 'CouponsDemoController.list',
      security: SESSION,
      pathParams: [shopId],
      ok: {
        description: 'Seller view (full) or buyer view (usable only); the `items` shape differs by role.',
        schema: obj({
          items: arr({
            oneOf: [
              CouponSeller,
              obj({ id: str(), title: str(), promoCode: str(), discountText: str(), minSpendVnd: int(undefined, { nullable: true }), endAt: str(undefined, { format: 'date-time' }) }),
            ],
          }),
        }, ['items']),
        example: { items: [couponExample] },
      },
      errors: base,
      errorShape: 'nest',
    }),
    post: op({
      tag: 'Demo Coupons',
      summary: 'Create a coupon (seller)',
      description: 'SELLER only. Stores a coupon (code upper-cased; `startAt` defaults to the current business time). Not a TikTok API: simulator data setup. Duplicate code in the shop => 409. `endAt` must be after `startAt` when both are given.',
      handler: 'CouponsDemoController.create',
      security: SESSION,
      pathParams: [shopId],
      body: {
        schema: obj(
          {
            title: str('1-100 chars'),
            promoCode: str('6-12 letters or digits', { pattern: '^[A-Za-z0-9]{6,12}$' }),
            discount: {
              oneOf: [
                obj({ type: str(undefined, { enum: ['AMOUNT_OFF'] }), amountVnd: int('1..2,000,000,000') }, ['type', 'amountVnd']),
                obj({ type: str(undefined, { enum: ['PERCENT_OFF'] }), percentage: int('1..100', { minimum: 1, maximum: 100 }), maxDiscountVnd: int('1..2,000,000,000; cap') }, ['type', 'percentage']),
              ],
            },
            minSpendVnd: int('1..2,000,000,000'),
            startAt: str('ISO datetime (business clock)', { format: 'date-time' }),
            endAt: str('ISO datetime', { format: 'date-time' }),
            redemptionLimit: int('1..1,000,000'),
            audience: str('default ALL (REPEAT_CUSTOMERS is not modelled)', { enum: ['ALL', 'NEW'] }),
          },
          ['title', 'promoCode', 'discount', 'endAt'],
        ),
        example: { title: 'Giam 10%', promoCode: 'SALE10', discount: { type: 'PERCENT_OFF', percentage: 10, maxDiscountVnd: 30000 }, minSpendVnd: 100000, endAt: '2026-12-31T00:00:00.000Z', redemptionLimit: 100, audience: 'ALL' },
      },
      ok: { description: 'Created coupon.', schema: CouponSeller, example: couponExample },
      status: 201,
      errors: { 400: VALIDATION, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 409: 'This promo code already exists in the shop.' },
      errorShape: 'nest',
    }),
  },
  '/demo/shops/{shopId}/coupons/{couponId}': {
    patch: op({
      tag: 'Demo Coupons',
      summary: 'Edit a coupon (seller)',
      description: 'SELLER only. The code and the discount are immutable (orders may carry a snapshot). Updatable: title, startAt, endAt, redemptionLimit (nullable = unlimited), minSpendVnd (nullable), deactivated. 404 unknown coupon (by marketplace id); 400 if the resulting start >= end or redemptionLimit is below the redemptions already used.',
      handler: 'CouponsDemoController.update',
      security: SESSION,
      pathParams: [shopId, { name: 'couponId', description: 'Coupon marketplace id (`id` of a coupon view).', example: '7700123456789012' }],
      body: {
        schema: obj(
          {
            title: str('1-100'),
            startAt: str(undefined, { format: 'date-time' }),
            endAt: str(undefined, { format: 'date-time' }),
            redemptionLimit: int('1..1,000,000, or null', { nullable: true }),
            minSpendVnd: int('1..2,000,000,000, or null', { nullable: true }),
            deactivated: bool(),
          },
          [],
          { minProperties: 1 },
        ),
        example: { deactivated: true },
      },
      ok: { description: 'Updated coupon.', schema: CouponSeller, example: { ...couponExample, status: 'DEACTIVATED' } },
      errors: { 400: `${VALIDATION} Or endAt not after startAt / redemptionLimit below redeemed count.`, 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER}`, 404: 'Unknown coupon.' },
      errorShape: 'nest',
    }),
  },

  // ---------------------------------------------------------------- Demo Inventory
  '/demo/shops/{shopId}/inventory/history': {
    get: op({
      tag: 'Demo Inventory',
      summary: 'Stock change history and inventory-update API attempts (seller)',
      description: 'SELLER only, own shop. Returns the newest `limit` InventoryChange rows (before/after per SKU and warehouse, with source such as SELLER, ORDER or API) and the newest `limit` inventory-update attempts (including ones that never got an answer). `limit` is parsed leniently: non-numeric/0 => 50, clamped to 1..200.',
      handler: 'InventoryDemoController.history',
      security: SESSION,
      pathParams: [shopId],
      query: [{ name: 'limit', description: 'Rows per list; default 50, clamped to 1..200.', schema: int(undefined, { default: 50, minimum: 1, maximum: 200 }), example: 50 }],
      ok: {
        description: 'Changes and attempts, newest first.',
        schema: obj({
          changes: arr(obj({ seq: int(), sku: str('SKU marketplace id'), sellerSku: str(), warehouse: str('Warehouse external id'), warehouseName: str(), before: int(), after: int(), source: str('e.g. SELLER, ORDER, API'), noop: bool(), requestId: str(undefined, { nullable: true }), note: str(undefined, { nullable: true }), at: str(undefined, { format: 'date-time' }) })),
          attempts: arr(obj({ seq: int(), product: str(undefined, { nullable: true }), outcome: str(), itemsTotal: int(), itemsApplied: int(), itemsFailed: int(), requestId: str(undefined, { nullable: true }), at: str(undefined, { format: 'date-time' }) })),
        }),
        example: {
          changes: [{ seq: 12, sku: '7510123456789013', sellerSku: 'TSHIRT-M', warehouse: '7300000000000001', warehouseName: 'Main warehouse', before: 40, after: 38, source: 'ORDER', noop: false, requestId: null, note: 'checkout reservation', at: '2026-10-15T08:00:00.000Z' }],
          attempts: [{ seq: 3, product: '7500123456789012', outcome: 'SUCCESS', itemsTotal: 1, itemsApplied: 1, itemsFailed: 0, requestId: 'req_abc123', at: '2026-10-15T07:30:00.000Z' }],
        },
      },
      errors: { 401: UNAUTH, 403: `${CROSS_SHOP} Or ${NOT_SELLER} (\`Only a seller session can read the inventory history\`).` },
      errorShape: 'nest',
    }),
  },
});
