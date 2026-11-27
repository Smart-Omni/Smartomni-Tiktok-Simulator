import { PathsFragment, Param, arr, bool, envelope, int, obj, op, str } from './helpers';

/** Common signed-call query params (TiktokApiGuard). The access token itself travels in the `x-tts-access-token` header. */
const SIGNED: Param[] = [
  { name: 'app_key', required: true, description: 'App key of the app the access token was issued to.', example: 'sim_app_key' },
  { name: 'timestamp', required: true, description: 'Unix SECONDS (digits only, max 12). Stale or future values outside the signature window are rejected (401 stale_timestamp).', schema: { type: 'string', pattern: '^\\d{1,12}$' }, example: '1700000000' },
  { name: 'sign', required: true, description: 'HMAC signature over path + sorted query + raw body (contracts/signing).', example: '3f2a9c...' },
  { name: 'shop_cipher', required: false, description: "Optional; when sent it must equal the shop cipher of the access token's shop, else 403 shop_cipher_mismatch." },
];

const SIGNED_ERRORS: Record<number, string> = {
  400: 'invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp.',
  401: 'unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.',
  403: 'token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.',
};

const PAGE_SIZE: Param = { name: 'page_size', required: true, description: 'Required integer in [1, 100] (validated against /^\\d{1,4}$/ then range).', schema: { type: 'integer', minimum: 1, maximum: 100 }, example: 20 };
const PAGE_TOKEN: Param = { name: 'page_token', description: 'Opaque cursor (base64url JSON) from a previous response `next_page_token`; any other value gives 400 invalid_input.' };

const tokenData = obj(
  {
    access_token: str(),
    access_token_expire_in: int('ABSOLUTE Unix seconds of access token expiry (not a TTL; unconfirmed vs TikTok).'),
    refresh_token: str(),
    refresh_token_expire_in: int('ABSOLUTE Unix seconds of refresh token expiry.'),
    open_id: str(),
    granted_scopes: arr(str()), // Scopes granted to this token (what the API guard enforces); simulator-defined `sim.` placeholders.
  },
  ['access_token', 'access_token_expire_in', 'refresh_token', 'refresh_token_expire_in'],
);
const tokenExample = {
  code: 0,
  message: 'success',
  request_id: 'TEST-REQ-0101',
  data: { access_token: 'test_access_token_not_real', access_token_expire_in: 1700086400, refresh_token: 'test_refresh_token_not_real', refresh_token_expire_in: 1707776000, open_id: 'test_open_id', granted_scopes: ['sim.order.read'] },
};
const appCreds: Param[] = [
  { name: 'app_key', required: true, example: 'sim_app_key' },
  { name: 'app_secret', required: true, example: 'sim_app_secret' },
  { name: 'grant_type', description: 'Accepted but NOT enforced (contract does not pin its value).', example: 'authorized_code' },
];
const tokenErrorBase: Record<number, string> = {
  400: 'invalid_input (missing credentials, or any query parameter not a plain string; repeated params are arrays).',
  401: 'invalid_app_credentials: app_key/app_secret rejected.',
};

const skuInventory = arr(obj({ warehouse_id: str(), quantity: int() }, ['warehouse_id', 'quantity']));
const productSkuProps = {
  id: str(),
  seller_sku: str(),
  price: obj({ currency: str(), sale_price: str('Amount as string (VND has no minor units)') }),
  inventory: skuInventory,
  status_info: obj({ status: str() }),
};
const productSku = obj(productSkuProps, ['id']);
const PRODUCT_STATUSES = ['DRAFT', 'PENDING', 'FAILED', 'ACTIVATE', 'SELLER_DEACTIVATED', 'PLATFORM_DEACTIVATED', 'FREEZE', 'DELETED'];
const productBase = {
  id: str(),
  title: str(),
  status: str('Product status', { enum: PRODUCT_STATUSES }),
  audit: obj({ status: str('Derived from status: ACTIVATE->APPROVED, PENDING->AUDITING, FAILED->FAILED, else NONE', { enum: ['NONE', 'AUDITING', 'FAILED', 'PRE_APPROVED', 'APPROVED'] }) }),
  has_draft: bool(),
  is_not_for_sale: bool(),
  create_time: int('Unix seconds'),
  update_time: int('Unix seconds'),
};
const skuExample = { id: '1729000000000000101', seller_sku: 'TEE-BLK-M', price: { currency: 'VND', sale_price: '199000' }, inventory: [{ warehouse_id: '7000000000000000001', quantity: 25 }], status_info: { status: 'NORMAL' } };

// The OAS values. ON_HOLD stays documented (a valid `order_status` filter that matches nothing); the simulator never returns it (DECISIONS H5).
const ORDER_STATUS_ENUM = ['UNPAID', 'ON_HOLD', 'AWAITING_SHIPMENT', 'PARTIALLY_SHIPPING', 'AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'CANCELLED'];
const orderItemSchema = obj(
  {
    id: str(),
    status: str('Order status', { enum: ORDER_STATUS_ENUM }),
    create_time: int('Unix seconds'),
    update_time: int('Unix seconds'),
    paid_time: int(),
    rts_sla_time: int('Latest shipping time: paid_time + 48 hours (Unix seconds)'),
    rts_time: int(),
    collection_time: int(),
    delivery_time: int(),
    cancel_time: int(),
    cancel_reason: str(),
    cancellation_initiator: str(),
    is_buyer_request_cancel: bool(),
    is_on_hold_order: bool(),
    user_id: str(),
    buyer_nickname: str(),
    buyer_message: str(),
    payment_method_name: str(),
    warehouse_id: str(),
    payment: obj({
      currency: str(),
      original_total_product_price: str(),
      seller_discount: str(),
      platform_discount: str(),
      sub_total: str(),
      original_shipping_fee: str(),
      shipping_fee: str(),
      shipping_fee_platform_discount: str(),
      shipping_fee_seller_discount: str(),
      product_tax: str(),
      tax: str(),
      total_amount: str(),
    }),
    recipient_address: obj({ name: str(), phone_number: str(), address_detail: str(), address_line1: str(), full_address: str(), postal_code: str(), region_code: str() }, [], { description: 'Omitted when status is UNPAID (the simulator never produces ON_HOLD).' }),
    line_items: arr(
      obj({ id: str(), product_id: str(), product_name: str(), sku_id: str(), sku_name: str(), seller_sku: str(), currency: str(), original_price: str(), sale_price: str(), seller_discount: str(), platform_discount: str(), package_id: str(), display_status: str() }),
    ),
    packages: arr(obj({ id: str() })),
  },
  ['id', 'status'],
  { description: 'Fields with undefined values are dropped from the JSON; money values are strings.' },
);
const orderExample = {
  id: '5770000000000000001',
  status: 'AWAITING_SHIPMENT',
  create_time: 1700000000,
  update_time: 1700000300,
  paid_time: 1700000100,
  rts_sla_time: 1700172900,
  is_buyer_request_cancel: false,
  is_on_hold_order: false,
  user_id: '7100000000000000001',
  buyer_nickname: 'Nguyen Van A',
  buyer_message: '',
  payment_method_name: 'COD',
  warehouse_id: '7000000000000000001',
  payment: { currency: 'VND', original_total_product_price: '398000', seller_discount: '0', platform_discount: '0', sub_total: '398000', original_shipping_fee: '25000', shipping_fee: '25000', shipping_fee_platform_discount: '0', shipping_fee_seller_discount: '0', product_tax: '0', tax: '0', total_amount: '423000' },
  recipient_address: { name: 'Nguyen Van A', phone_number: '0900000000', address_detail: '1 Le Loi', address_line1: '1 Le Loi', full_address: '1 Le Loi, District 1, Ho Chi Minh', postal_code: '700000', region_code: 'VN' },
  line_items: [{ id: '5770000000000000101', product_id: '1729000000000000001', product_name: 'Basic Tee', sku_id: '1729000000000000101', sku_name: 'Black / M', seller_sku: 'TEE-BLK-M', currency: 'VND', original_price: '199000', sale_price: '199000', seller_discount: '0', platform_discount: '0', display_status: 'AWAITING_SHIPMENT' }],
  packages: [],
};

const EVENT_TOPICS = [
  'ORDER_STATUS_CHANGE', 'RECIPIENT_ADDRESS_UPDATE', 'PACKAGE_UPDATE', 'PRODUCT_STATUS_CHANGE', 'SELLER_DEAUTHORIZATION', 'UPCOMING_AUTHORIZATION_EXPIRATION',
  'CANCELLATION_STATUS_CHANGE', 'RETURN_STATUS_CHANGE', 'NEW_CONVERSATION', 'NEW_MESSAGE', 'PRODUCT_INFORMATION_CHANGE', 'PRODUCT_CREATION', 'PRODUCT_CATEGORY_CHANGE',
  'NEW_MESSAGE_LISTENER', 'INVOICE_STATUS_CHANGE', 'PRODUCT_AUDIT_STATUS_CHANGE', 'REVERSE_STATUS_UPDATE',
];
const eventTypeSchema = str('Webhook topic documented in the official OAS', { enum: EVENT_TOPICS });
const emptyOk = { code: 0, message: 'Success', request_id: 'TEST-REQ-0301', data: {} };

export const paths: PathsFragment = {
  '/api/v2/token/get': {
    get: op({
      tag: 'TikTok Auth',
      summary: 'Exchange auth_code for tokens',
      description:
        'Authenticates the app with app_key/app_secret (OAuthService.authenticateApp) then calls OAuthService.exchangeCode with `auth_code`, returning a new access/refresh token pair. Shapes are provisional (contracts/schemas/token-response.json, unverified).',
      handler: 'TokenController.get',
      security: ['TiktokAppCredentials'],
      query: [...appCreds, { name: 'auth_code', required: true, description: 'One-time authorization code issued for this app.', example: 'test_auth_code' }],
      ok: { description: 'Token pair.', schema: envelope(tokenData), example: tokenExample },
      errors: { ...tokenErrorBase, 400: 'invalid_input, auth_code_invalid (unknown or other app), auth_code_used, auth_code_expired.' },
      errorShape: 'tiktok',
    }),
  },
  '/api/v2/token/refresh': {
    get: op({
      tag: 'TikTok Auth',
      summary: 'Refresh tokens',
      description: 'Authenticates the app, then OAuthService.refresh rotates the refresh token (single use) and issues a new token pair.',
      handler: 'TokenController.refresh',
      security: ['TiktokAppCredentials'],
      query: [...appCreds, { name: 'refresh_token', required: true, example: 'test_refresh_token_not_real' }],
      ok: { description: 'New token pair.', schema: envelope(tokenData), example: tokenExample },
      errors: { ...tokenErrorBase, 400: 'invalid_input, refresh_token_invalid (unknown, other app, or already used), authorization_revoked, refresh_token_expired.' },
      errorShape: 'tiktok',
    }),
  },

  '/authorization/202309/shops': {
    get: op({
      tag: 'TikTok Shops',
      summary: 'Get authorized shops',
      description: 'Returns only the shop bound to the presented access token (from the guard principal). `region: VN` and `seller_type: LOCAL` for seeded shops are unverified.',
      handler: 'ShopsController.shops',
      security: ['TiktokSignedApi'],
      scope: 'sim.authorized_shops.read',
      query: SIGNED,
      ok: {
        description: 'Single-element shop list.',
        schema: envelope(obj({ shops: arr(obj({ cipher: str(), code: str(), id: str(), name: str(), region: str(), seller_type: str() }, ['cipher', 'id'])) }, ['shops'])),
        example: { code: 0, message: 'Success', request_id: 'TEST-auth.shops-vn', data: { shops: [{ cipher: 'TEST_cipher', code: 'SIMSHOP1', id: '7000000000000000001', name: 'Sim Fashion Store', region: 'VN', seller_type: 'LOCAL' }] } },
      },
      errors: SIGNED_ERRORS,
      errorShape: 'tiktok',
    }),
  },

  '/product/202502/products/search': {
    post: op({
      tag: 'TikTok Products',
      summary: 'Search products',
      description:
        'Keyset-paginated product list of the token shop (ordered by internal seq). page_size/page_token come from the query string; filters from the JSON body. Body fields not implemented (audit_status, category_version, listing_platforms, listing_quality_tiers, return_draft_version, sns_filter) or unknown fields are rejected with 400 rather than ignored.',
      handler: 'ProductsController.search',
      security: ['TiktokSignedApi'],
      scope: 'sim.product.read',
      query: [...SIGNED, PAGE_SIZE, PAGE_TOKEN],
      body: {
        required: false,
        schema: obj({
          status: str('Default ALL', { enum: ['ALL', ...PRODUCT_STATUSES], default: 'ALL' }),
          seller_skus: { ...arr(str()), maxItems: 100, description: 'Each 1-200 chars' },
          sku_ids: { ...arr(str()), maxItems: 100, description: 'Each 1-200 chars' },
          create_time_ge: int('Unix seconds, inclusive'),
          create_time_le: int('Unix seconds, inclusive'),
          update_time_ge: int('Unix seconds, inclusive'),
          update_time_le: int('Unix seconds, inclusive'),
        }),
        example: { status: 'ACTIVATE', seller_skus: ['TEE-BLK-M'] },
      },
      ok: {
        description: 'Page of products. `next_page_token` is "" on the last page.',
        schema: envelope(obj({ next_page_token: str(), products: arr(obj({ ...productBase, skus: arr(productSku) }, ['id'])), total_count: int('Total matches ignoring the cursor') }, ['products', 'total_count'])),
        example: { code: 0, message: 'Success', request_id: 'TEST-REQ-0201', data: { next_page_token: '', total_count: 1, products: [{ id: '1729000000000000001', title: 'Basic Tee', status: 'ACTIVATE', audit: { status: 'APPROVED' }, has_draft: false, is_not_for_sale: false, create_time: 1700000000, update_time: 1700000000, skus: [skuExample] }] } },
      },
      errors: { ...SIGNED_ERRORS, 400: `${SIGNED_ERRORS[400]} Also invalid_input: page_size missing/out of [1,100], bad page_token, body not an object, unsupported/unknown filter, bad status/seller_skus/sku_ids/time values.` },
      errorShape: 'tiktok',
    }),
  },
  '/product/202309/products/{productId}': {
    get: op({
      tag: 'TikTok Products',
      summary: 'Get product detail',
      description: 'Looks up the product by (shop, external id) via Prisma and maps it with productDetail(). A product of another shop is indistinguishable from an unknown id.',
      handler: 'ProductsController.detail',
      security: ['TiktokSignedApi'],
      scope: 'sim.product.read',
      pathParams: [{ name: 'productId', description: 'External product id.', example: '1729000000000000001' }],
      query: SIGNED,
      ok: {
        description: 'Product detail (superset of the search item).',
        schema: envelope(
          obj(
            {
              ...productBase,
              description: str(),
              main_images: arr(obj({ uri: str(), urls: arr(str()), thumb_urls: arr(str()), width: int(), height: int() })),
              skus: arr(obj({ ...productSkuProps, sales_attributes: arr(obj({ id: str(), name: str(), value_id: str(), value_name: str() })) }, ['id'])),
            },
            ['id'],
          ),
        ),
        example: {
          code: 0,
          message: 'Success',
          request_id: 'TEST-REQ-0202',
          data: {
            id: '1729000000000000001',
            title: 'Basic Tee',
            description: 'Cotton tee',
            status: 'ACTIVATE',
            audit: { status: 'APPROVED' },
            has_draft: false,
            is_not_for_sale: false,
            create_time: 1700000000,
            update_time: 1700000000,
            main_images: [{ uri: 'sim/product/abc', urls: ['http://localhost:3000/demo/media/products/abc.svg'], thumb_urls: ['http://localhost:3000/demo/media/products/abc.svg'], width: 600, height: 600 }],
            skus: [{ ...skuExample, sales_attributes: [{ id: 'attr-1729000000000000001', name: 'Size', value_id: 'val-1729000000000000101', value_name: 'M' }] }],
          },
        },
      },
      errors: { ...SIGNED_ERRORS, 404: 'product_not_found: unknown id or product of another shop.' },
      errorShape: 'tiktok',
    }),
  },
  '/logistics/202309/warehouses': {
    get: op({
      tag: 'TikTok Products',
      summary: 'Get warehouse list',
      description: 'Lists warehouses of the token shop (default first, then by code); no pagination. Uses scope sim.product.read.',
      handler: 'ProductsController.warehouses',
      security: ['TiktokSignedApi'],
      scope: 'sim.product.read',
      query: SIGNED,
      ok: {
        description: 'Warehouses.',
        schema: envelope(obj({ warehouses: arr(obj({ id: str(), name: str(), effect_status: str(), is_default: bool(), type: str('Always SALES_WAREHOUSE'), sub_type: str('Always DOMESTIC_WAREHOUSE'), address: obj({ city: str(), region: str(), region_code: str(), full_address: str() }) }, ['id'])) }, ['warehouses'])),
        example: { code: 0, message: 'Success', request_id: 'TEST-REQ-0203', data: { warehouses: [{ id: '7000000000000000001', name: 'Main Warehouse', effect_status: 'ENABLED', is_default: true, type: 'SALES_WAREHOUSE', sub_type: 'DOMESTIC_WAREHOUSE', address: { city: 'Ho Chi Minh', region: 'VN', region_code: 'VN', full_address: 'Main Warehouse, Ho Chi Minh' } }] } },
      },
      errors: SIGNED_ERRORS,
      errorShape: 'tiktok',
    }),
  },

  '/product/202309/products/{productId}/inventory/update': {
    post: op({
      tag: 'TikTok Inventory',
      summary: 'Update inventory',
      description:
        'Absolute (idempotent) stock replacement per SKU, one DB transaction per SKU; failing SKUs are listed in data.errors inside a code-0 HTTP 200 (valid SKUs are still applied). Every warehouse assigned to a SKU must be listed (warehouse_id optional only if exactly one is assigned); quantity integer in [0, 99999]; FREEZE/DELETED products are rejected per SKU. Test-fault rules TIMEOUT_BEFORE_WRITE/TIMEOUT_AFTER_WRITE destroy the socket without a response, and APP_ERROR_200 returns HTTP 200 with code -1 and nothing written.',
      handler: 'InventoryController.update',
      security: ['TiktokSignedApi'],
      scope: 'sim.inventory.write',
      pathParams: [{ name: 'productId', example: '1729000000000000001' }],
      query: SIGNED,
      body: {
        schema: obj(
          {
            skus: {
              ...arr(obj({ id: str('SKU id, 1-200 chars'), inventory: { ...arr(obj({ warehouse_id: str(), quantity: int('Integer 0..99999', { minimum: 0, maximum: 99999 }) }, ['quantity'])), minItems: 1, maxItems: 50 } }, ['id', 'inventory'])),
              minItems: 1,
              maxItems: 100,
            },
          },
          ['skus'],
        ),
        example: { skus: [{ id: '1729000000000000101', inventory: [{ warehouse_id: '7000000000000000001', quantity: 30 }] }] },
      },
      ok: {
        description: 'Code 0 with per-SKU errors (empty when all applied). With a fault rule the body may instead be code -1 (APP_ERROR_200) or the connection is dropped (no response).',
        schema: envelope(obj({ errors: arr(obj({ code: int('12052990 (OAS example value, meaning unverified)'), message: str(), detail: obj({ sku_id: str(), extra_errors: arr(obj({ code: int('12052097 (OAS example value)'), message: str(), warehouse_id: str() })) }) })) }, ['errors'])),
        example: { code: 0, message: 'Success', request_id: 'TEST-REQ-0401', data: { errors: [{ code: 12052990, message: 'the inventory of this SKU was not updated', detail: { sku_id: '1729000000000000101', extra_errors: [{ code: 12052097, message: 'quantity must be an integer in [0, 99999]', warehouse_id: '7000000000000000001' }] } }] } },
      },
      errors: { ...SIGNED_ERRORS, 400: `${SIGNED_ERRORS[400]} Also invalid_input: body not an object, skus not an array of 1-100, skus[].id invalid, inventory not a non-empty array (max 50), warehouse_id not a string.`, 404: 'product_not_found: unknown id or product of another shop.' },
      errorShape: 'tiktok',
    }),
  },

  '/order/202309/orders/search': {
    post: op({
      tag: 'TikTok Orders',
      summary: 'Search orders',
      description:
        'Keyset-paginated order list of the token shop, sorted by sort_field/sort_order with seq as tiebreaker; a page_token issued for a different sort is rejected. Time filters: *_ge inclusive, *_lt exclusive. Filter `shipping_type` and unknown body fields are rejected with 400.',
      handler: 'OrdersController.search',
      security: ['TiktokSignedApi'],
      scope: 'sim.order.read',
      query: [
        ...SIGNED,
        PAGE_SIZE,
        PAGE_TOKEN,
        { name: 'sort_field', schema: { type: 'string', enum: ['create_time', 'update_time'], default: 'create_time' } },
        { name: 'sort_order', schema: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' } },
      ],
      body: {
        required: false,
        schema: obj({
          order_status: str(undefined, { enum: ORDER_STATUS_ENUM }),
          buyer_user_id: str(),
          is_buyer_request_cancel: bool(),
          warehouse_ids: { ...arr(str()), maxItems: 100 },
          create_time_ge: int('Unix seconds, inclusive'),
          create_time_lt: int('Unix seconds, exclusive'),
          update_time_ge: int('Unix seconds, inclusive'),
          update_time_lt: int('Unix seconds, exclusive'),
        }),
        example: { order_status: 'AWAITING_SHIPMENT', create_time_ge: 1700000000 },
      },
      ok: {
        description: 'Page of orders; `next_page_token` is "" on the last page.',
        schema: envelope(obj({ next_page_token: str(), orders: arr(orderItemSchema), total_count: int('Matches ignoring the cursor') }, ['orders', 'total_count'])),
        example: { code: 0, message: 'Success', request_id: 'TEST-REQ-0501', data: { next_page_token: '', total_count: 1, orders: [orderExample] } },
      },
      errors: { ...SIGNED_ERRORS, 400: `${SIGNED_ERRORS[400]} Also invalid_input: page_size missing/out of [1,100], bad sort_field/sort_order/page_token, unsupported or unknown filter, wrong types.` },
      errorShape: 'tiktok',
    }),
  },
  '/order/202507/orders': {
    get: op({
      tag: 'TikTok Orders',
      summary: 'Get order detail',
      description: "Looks up orders by external id within the token shop (ids de-duplicated, max 50). Unknown ids and other shops' ids are simply absent from the result (unverified behaviour).",
      handler: 'OrdersController.detail',
      security: ['TiktokSignedApi'],
      scope: 'sim.order.read',
      query: [...SIGNED, { name: 'ids', required: true, description: 'Comma-separated order ids, 1 to 50.', example: '5770000000000000001,5770000000000000002' }],
      ok: { description: 'Matching orders (ordered by seq).', schema: envelope(obj({ orders: arr(orderItemSchema) }, ['orders'])), example: { code: 0, message: 'Success', request_id: 'TEST-REQ-0502', data: { orders: [orderExample] } } },
      errors: { ...SIGNED_ERRORS, 400: `${SIGNED_ERRORS[400]} Also invalid_input: ids missing or more than 50.` },
      errorShape: 'tiktok',
    }),
  },

  '/event/202309/webhooks': {
    get: op({
      tag: 'TikTok Webhooks',
      summary: 'List webhook subscriptions',
      description: 'Lists WebhookSubscription rows for (token shop, token app), ordered by event type.',
      handler: 'EventsController.list',
      security: ['TiktokSignedApi'],
      scope: 'sim.event.manage',
      query: SIGNED,
      ok: {
        description: 'Subscriptions.',
        schema: envelope(obj({ total_count: int(), webhooks: arr(obj({ address: str(), create_time: int('Unix seconds'), event_type: eventTypeSchema, update_time: int('Unix seconds') }, ['address', 'event_type'])) }, ['total_count', 'webhooks'])),
        example: { code: 0, message: 'Success', request_id: 'TEST-REQ-0301', data: { total_count: 1, webhooks: [{ address: 'http://smartomni.local/hooks/tiktok', create_time: 1700000000, event_type: 'ORDER_STATUS_CHANGE', update_time: 1700000000 }] } },
      },
      errors: SIGNED_ERRORS,
      errorShape: 'tiktok',
    }),
    put: op({
      tag: 'TikTok Webhooks',
      summary: 'Create or update a webhook subscription',
      description: 'Upserts the subscription for (shop, app, event_type) with the given address and business-clock timestamps. Any documented topic is accepted and stored, but the simulator may not emit all of them (ORDER_STATUS_CHANGE is the Phase 05 topic).',
      handler: 'EventsController.put',
      security: ['TiktokSignedApi'],
      scope: 'sim.event.manage',
      query: SIGNED,
      body: {
        schema: obj({ event_type: eventTypeSchema, address: str('Absolute http(s) URL, max 255 chars', { maxLength: 255, format: 'uri' }) }, ['event_type', 'address']),
        example: { event_type: 'ORDER_STATUS_CHANGE', address: 'http://smartomni.local/hooks/tiktok' },
      },
      ok: { description: 'Stored; empty data.', schema: envelope(obj({})), example: emptyOk },
      errors: { ...SIGNED_ERRORS, 400: `${SIGNED_ERRORS[400]} Also invalid_input: event_type not a documented topic; address missing, over 255 chars, not an absolute URL or not http(s).` },
      errorShape: 'tiktok',
    }),
    delete: op({
      tag: 'TikTok Webhooks',
      summary: 'Delete a webhook subscription',
      description: 'deleteMany for (shop, app, event_type); succeeds even if no subscription existed. event_type is read from the JSON body of the DELETE request.',
      handler: 'EventsController.remove',
      security: ['TiktokSignedApi'],
      scope: 'sim.event.manage',
      query: SIGNED,
      body: { schema: obj({ event_type: eventTypeSchema }, ['event_type']), example: { event_type: 'ORDER_STATUS_CHANGE' } },
      ok: { description: 'Deleted (or nothing to delete); empty data.', schema: envelope(obj({})), example: emptyOk },
      errors: { ...SIGNED_ERRORS, 400: `${SIGNED_ERRORS[400]} Also invalid_input: event_type not a documented topic.` },
      errorShape: 'tiktok',
    }),
  },
};
