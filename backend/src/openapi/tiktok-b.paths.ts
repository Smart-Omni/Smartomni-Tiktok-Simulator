import { Json, Param, PathsFragment, arr, bool, envelope, int, obj, op, str } from './helpers';

const COMMON_QUERY: Param[] = [
  { name: 'app_key', required: true, description: 'App key of the calling app.', example: 'sim_app_key' },
  { name: 'timestamp', required: true, description: 'Unix SECONDS (1-12 digits); stale and future values outside the signature window are rejected (401 stale_timestamp).', example: '1760000000' },
  { name: 'sign', required: true, description: 'HMAC signature over path + sorted query + raw body.', example: 'c0ffee…' },
  { name: 'shop_cipher', required: false, description: 'Optional; when sent it must equal the shop cipher of the access token (else 403 shop_cipher_mismatch).' },
];

const PAGE_TOKEN: Param = { name: 'page_token', description: 'Opaque cursor returned as `next_page_token` (base64url JSON issued by this API). A malformed token or one issued for a different sort gives 400 invalid_input.' };

const GUARD_ERRORS: Record<number, string> = {
  400: 'invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint.',
  401: 'unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.',
  403: 'token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.',
};
const errs = (extra: Record<number, string> = {}): Record<number, string> => {
  const out: Record<number, string> = { ...GUARD_ERRORS };
  for (const [k, v] of Object.entries(extra)) out[Number(k)] = k in GUARD_ERRORS ? `${GUARD_ERRORS[Number(k)]} Also: ${v}` : v;
  return out;
};

const TAG_A = 'TikTok Aftersale';
const TAG_C = 'TikTok Conversations';
const TAG_P = 'TikTok Coupons';
const TAG_F = 'TikTok Fulfillment';
const SEC = ['TiktokSignedApi'];

const emptyData = (): Json => envelope(obj({}, [], { description: 'Empty object `{}`.' }));
const emptyOk = { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: {} };

const money = obj({ currency: str(), refund_subtotal: str('integer amount as string'), refund_shipping_fee: str(), refund_tax: str('always "0"'), refund_total: str() }, ['currency', 'refund_subtotal', 'refund_shipping_fee', 'refund_tax', 'refund_total']);
const lineItem = (idName: string): Json =>
  obj(
    {
      [idName]: str(),
      order_line_item_id: str(),
      product_name: str(),
      sku_id: str(),
      sku_name: str(),
      seller_sku: str(),
      refund_amount: money,
    },
    [idName, 'order_line_item_id', 'refund_amount'],
  );
const refundExample = { currency: 'VND', refund_subtotal: '250000', refund_shipping_fee: '15000', refund_tax: '0', refund_total: '265000' };

const returnFilters = obj({
  buyer_user_ids: arr(str()),
  create_time_ge: int('Unix seconds, >= 0'),
  create_time_lt: int('Unix seconds'),
  locale: str('accepted, not used for filtering'),
  order_ids: arr(str()),
  return_ids: arr(str()),
  return_status: arr(str('', { enum: ['RETURN_OR_REFUND_REQUEST_PENDING', 'REFUND_OR_RETURN_REQUEST_REJECT', 'AWAITING_BUYER_SHIP', 'BUYER_SHIPPED_ITEM', 'REJECT_RECEIVE_PACKAGE', 'RETURN_OR_REFUND_REQUEST_SUCCESS', 'RETURN_OR_REFUND_REQUEST_CANCEL', 'RETURN_OR_REFUND_REQUEST_COMPLETE'] })),
  return_types: arr(str('', { enum: ['REFUND', 'RETURN_AND_REFUND', 'REPLACEMENT'] })),
  update_time_ge: int(),
  update_time_lt: int(),
}, [], { description: 'All fields optional; each array holds up to 100 non-empty strings (<=200 chars). Unknown fields -> 400. `arbitration_status` and `seller_proposed_return_type` are documented by TikTok but rejected with 400 (not implemented).', additionalProperties: false });

const cancelFilters = obj({
  buyer_user_ids: arr(str()),
  cancel_ids: arr(str()),
  cancel_status: arr(str('', { enum: ['CANCELLATION_REQUEST_PENDING', 'CANCELLATION_REQUEST_SUCCESS', 'CANCELLATION_REQUEST_CANCELLED', 'CANCELLATION_REQUEST_COMPLETE'] })),
  cancel_types: arr(str('', { enum: ['CANCEL', 'BUYER_CANCEL'] })),
  create_time_ge: int('Unix seconds, >= 0'),
  create_time_lt: int(),
  locale: str(),
  order_ids: arr(str()),
  update_time_ge: int(),
  update_time_lt: int(),
}, [], { description: 'All fields optional; arrays hold up to 100 non-empty strings. Unknown fields -> 400.', additionalProperties: false });

const searchQuery = (min: number): Param[] => [
  { name: 'page_size', schema: int('', { minimum: min, maximum: 50, default: 10 }), description: `Integer in [${min}, 50], default 10.` },
  PAGE_TOKEN,
  { name: 'sort_field', schema: str('', { enum: ['create_time', 'update_time'], default: 'create_time' }) },
  { name: 'sort_order', schema: str('', { enum: ['ASC', 'DESC'], default: 'ASC' }) },
];

const returnItemSchema = obj(
  {
    return_id: str(),
    order_id: str(),
    return_status: str(),
    return_type: str('REFUND | RETURN_AND_REFUND'),
    role: str(),
    return_reason: str(),
    return_reason_text: str(),
    create_time: int('Unix seconds'),
    update_time: int('Unix seconds'),
    refund_amount: money,
    return_tracking_number: str('only once the buyer shipped the item back'),
    return_line_items: arr(lineItem('return_line_item_id')),
  },
  ['return_id', 'order_id', 'return_status', 'return_type', 'create_time', 'update_time', 'refund_amount', 'return_line_items'],
);
const cancelItemSchema = obj(
  {
    cancel_id: str(),
    order_id: str(),
    cancel_status: str(),
    cancel_type: str(),
    role: str(),
    cancel_reason: str(),
    cancel_reason_text: str(),
    create_time: int('Unix seconds'),
    update_time: int('Unix seconds'),
    refund_amount: money,
    cancel_line_items: arr(lineItem('cancel_line_item_id')),
  },
  ['cancel_id', 'order_id', 'cancel_status', 'cancel_type', 'create_time', 'update_time', 'refund_amount', 'cancel_line_items'],
);

const returnIdParam = { name: 'returnId', description: 'External return id (as returned in `return_id`).', example: '5790123456789012345' };
const cancelIdParam = { name: 'cancelId', description: 'External cancellation id (as returned in `cancel_id`).', example: '5780123456789012345' };
const notFoundAftersale = '404 aftersale_not_found: the id does not exist in the token\'s shop (another shop\'s id is indistinguishable).';

const messageSchema = obj(
  {
    id: str(),
    index: str('integer as string'),
    type: str('simulator only creates TEXT'),
    content: str('JSON-serialized string, e.g. {"content":"hi"}'),
    create_time: int('Unix seconds'),
    is_visible: bool(),
    sender: obj({ role: str(), im_user_id: str(), nickname: str(), avatar: str() }),
    data: str('only present when need_data=true; always empty string'),
  },
  ['id', 'index', 'type', 'content', 'create_time'],
);
const participantSchema = obj({ role: str('BUYER | SHOP | CUSTOMER_SERVICE'), user_id: str(), im_user_id: str(), nickname: str(), avatar: str() });
const participantsExample = [
  { role: 'BUYER', user_id: 'buyer_1', im_user_id: 'im_buyer_1', nickname: 'Linh', avatar: '' },
  { role: 'SHOP', user_id: 'im_shop_1', im_user_id: 'im_shop_1', nickname: 'Demo Shop', avatar: '' },
];
const messageExample = { id: '7000000000000000001', index: '1', type: 'TEXT', content: '{"content":"Hello"}', create_time: 1760000000, is_visible: true, sender: { role: 'BUYER', im_user_id: 'im_buyer_1', nickname: 'Linh', avatar: '' } };

const money2 = obj({ amount: str('integer VND as string'), currency: str('VND') });
const couponItem = obj(
  {
    id: str(),
    title: str(),
    status: str('', { enum: ['NOT_START', 'ONGOING', 'EXPIRED', 'DEACTIVATED'] }),
    creation_source: str('always SELLER_CENTER'),
    display_type: str('', { enum: ['REGULAR', 'LIVE', 'CREATOR_EXCLUSIVE', 'CHAT', 'PROMO_CODE'] }),
    promo_code: str(),
    product_scope: str('always FULL_SHOP'),
    target_buyer_segment: str('ALL | NEW'),
    create_time: int(),
    update_time: int(),
    discount: obj({ type: str('AMOUNT_OFF | PERCENT_OFF'), reduction_amount: money2, percentage: str(), max_discount: money2 }, ['type']),
    threshold: obj({ type: str('MIN_SPEND | NONE'), min_spend: money2 }, ['type']),
    claim_duration: obj({ start_time: int(), end_time: int() }),
    redemption_duration: obj({ type: str('always ABSOLUTE'), start_time: int(), end_time: int() }),
    usage_limits: obj({ redemption_limit: int('present only when a limit is set') }),
  },
  ['id', 'title', 'status', 'display_type', 'discount', 'threshold'],
);
const couponExample = {
  id: '7100000000000000001',
  title: 'Welcome 10%',
  status: 'ONGOING',
  creation_source: 'SELLER_CENTER',
  display_type: 'PROMO_CODE',
  promo_code: 'WELCOME10',
  product_scope: 'FULL_SHOP',
  target_buyer_segment: 'ALL',
  create_time: 1759000000,
  update_time: 1759000000,
  discount: { type: 'PERCENT_OFF', percentage: '10', max_discount: { amount: '50000', currency: 'VND' } },
  threshold: { type: 'MIN_SPEND', min_spend: { amount: '200000', currency: 'VND' } },
  claim_duration: { start_time: 1759000000, end_time: 1769000000 },
  redemption_duration: { type: 'ABSOLUTE', start_time: 1759000000, end_time: 1769000000 },
  usage_limits: { redemption_limit: 100 },
};

const address = obj({ name: str(), phone_number: str(), address_detail: str(), address_line1: str(), full_address: str(), postal_code: str(), region_code: str('VN') });

const returnSearchItemExample = {
  return_id: '5790123456789012345',
  order_id: '5770123456789012345',
  return_status: 'RETURN_OR_REFUND_REQUEST_PENDING',
  return_type: 'RETURN_AND_REFUND',
  role: 'BUYER',
  return_reason: 'DAMAGED_ITEM',
  return_reason_text: 'DAMAGED_ITEM',
  create_time: 1760000000,
  update_time: 1760000000,
  refund_amount: refundExample,
  return_line_items: [
    { return_line_item_id: '5791000000000000001', order_line_item_id: '5771000000000000001', product_name: 'Cotton T-shirt', sku_id: '1729000000000000001', sku_name: 'Black / M', seller_sku: 'TSHIRT-BLK-M', refund_amount: { ...refundExample, refund_shipping_fee: '0', refund_total: '250000' } },
  ],
};

export const paths: PathsFragment = {
  // ===================================================== Aftersale
  '/return_refund/202309/returns/search': {
    post: op({
      tag: TAG_A,
      summary: 'Search Returns (202309)',
      description:
        'Filters live in the JSON body, paging/sorting in the query. Queries AftersaleRequest rows of kind RETURN for the token\'s shop with a (sort key, seq) cursor and maps rows with `returnItem`. `total_count` ignores the cursor. Search Returns stays 202309; `return.rma_202604` is not served.',
      handler: 'AftersaleController.searchReturns',
      security: SEC,
      scope: 'sim.aftersale.read',
      query: [...COMMON_QUERY, ...searchQuery(10)],
      body: { schema: returnFilters, required: false, example: { return_status: ['RETURN_OR_REFUND_REQUEST_PENDING'], create_time_ge: 1759000000 } },
      ok: {
        description: 'Page of returns.',
        schema: envelope(obj({ next_page_token: str('empty string on the last page'), return_orders: arr(returnItemSchema), total_count: int() }, ['next_page_token', 'return_orders', 'total_count'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { next_page_token: '', return_orders: [returnSearchItemExample], total_count: 1 } },
      },
      errors: errs({ 400: 'page_size outside [10, 50] or non-integer, bad sort_field/sort_order, bad/foreign page_token, unknown or unsupported body field, non-array filter, status/type outside the documented enum, negative or non-integer time.' }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202309/returns/{returnId}/records': {
    get: op({
      tag: TAG_A,
      summary: 'Get Return Records (202309)',
      description: 'Verifies the return belongs to the shop (`mustOwn`), then returns its AftersaleRecord history oldest first via `AftersaleService.records` and `recordItem`.',
      handler: 'AftersaleController.records',
      security: SEC,
      scope: 'sim.aftersale.read',
      pathParams: [returnIdParam],
      query: COMMON_QUERY,
      ok: {
        description: 'Status history.',
        schema: envelope(obj({ records: arr(obj({ create_time: int(), description: str('"<from> -> <to>"'), event: str('always ORDER_RETURN'), note: str(), reason_text: str(), role: str('actor') })) }, ['records'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { records: [{ create_time: 1760000000, description: 'NEW -> RETURN_OR_REFUND_REQUEST_PENDING', event: 'ORDER_RETURN', note: 'return requested', reason_text: 'return requested', role: 'BUYER' }] } },
      },
      errors: errs({ 404: notFoundAftersale }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202309/returns/{returnId}/approve': {
    post: op({
      tag: TAG_A,
      summary: 'Approve Return (202309)',
      description:
        'Calls `AftersaleService.approveReturn` as SELLER. If `decision` is omitted it is inferred (REFUND -> APPROVE_REFUND; RETURN_AND_REFUND -> APPROVE_RECEIVED_PACKAGE when BUYER_SHIPPED_ITEM else APPROVE_RETURN). Only APPROVE_REFUND, APPROVE_RETURN and APPROVE_RECEIVED_PACKAGE are modelled. `buyer_keep_item` and `partial_refund` are refused. Repeats may be deduplicated by `idempotency_key` (query, 1-100 chars); exact dedup semantics live in `decide()` and were not verified here.',
      handler: 'AftersaleController.approveReturn',
      security: SEC,
      scope: 'sim.aftersale.write',
      pathParams: [returnIdParam],
      query: [...COMMON_QUERY, { name: 'idempotency_key', description: '1-100 characters.' }],
      body: {
        required: false,
        schema: obj({ decision: str('max 500 chars', { enum: ['APPROVE_REFUND', 'APPROVE_RETURN', 'APPROVE_RECEIVED_PACKAGE'] }), buyer_keep_item: { description: 'Not modelled: any non-null value gives 400.' }, partial_refund: { description: 'Not modelled: any non-null value gives 400.' } }, [], { additionalProperties: false }),
        example: { decision: 'APPROVE_RETURN' },
      },
      ok: { description: 'Approved (or already in the target state).', schema: emptyData(), example: emptyOk },
      errors: errs({
        400: 'invalid_decision (decision does not match return type or status is not the required source status) or invalid_input (unsupported_decision, unknown field, buyer_keep_item/partial_refund set, bad idempotency_key).',
        404: notFoundAftersale,
      }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202309/returns/{returnId}/reject': {
    post: op({
      tag: TAG_A,
      summary: 'Reject Return (202309)',
      description:
        'Requires `reject_reason` (one of the names from Get Reject Reasons). Calls `AftersaleService.rejectReturn` as SELLER; `decision` is inferred when omitted (REJECT_RECEIVED_PACKAGE if BUYER_SHIPPED_ITEM, else REJECT_REFUND / REJECT_RETURN by type). `images` is accepted by the field allow-list but ignored.',
      handler: 'AftersaleController.rejectReturn',
      security: SEC,
      scope: 'sim.aftersale.write',
      pathParams: [returnIdParam],
      query: [...COMMON_QUERY, { name: 'idempotency_key', description: '1-100 characters.' }],
      body: {
        schema: obj(
          {
            decision: str('REJECT_REFUND | REJECT_RETURN | REJECT_RECEIVED_PACKAGE (max 500 chars)', { enum: ['REJECT_REFUND', 'REJECT_RETURN', 'REJECT_RECEIVED_PACKAGE'] }),
            reject_reason: str('required', { enum: ['ITEM_AS_DESCRIBED', 'RETURN_WINDOW_EXPIRED', 'ITEM_USED_OR_DAMAGED', 'ALREADY_SHIPPED', 'OTHER'], maxLength: 500 }),
            comment: str('', { maxLength: 500 }),
            images: arr(obj({}, [], { additionalProperties: true })),
          },
          ['reject_reason'],
          { additionalProperties: false },
        ),
        example: { reject_reason: 'ITEM_AS_DESCRIBED', comment: 'Item matches the listing' },
      },
      ok: { description: 'Rejected.', schema: emptyData(), example: emptyOk },
      errors: errs({
        400: 'invalid_input (reject_reason missing or not one of the simulator names, unsupported_decision, unknown field) or invalid_decision (wrong type/status for the decision).',
        404: notFoundAftersale,
      }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202309/reject_reasons': {
    get: op({
      tag: TAG_A,
      summary: 'Get Reject Reasons (202309)',
      description: 'Checks `return_or_cancel_id` exists in the shop (either kind) and returns the static REJECT_REASONS list. The names are simulator choices, not TikTok values.',
      handler: 'AftersaleController.rejectReasons',
      security: SEC,
      scope: 'sim.aftersale.read',
      query: [...COMMON_QUERY, { name: 'return_or_cancel_id', required: true, description: 'Return or cancellation id.' }],
      ok: {
        description: 'Reject reasons.',
        schema: envelope(obj({ reasons: arr(obj({ name: str(), text: str() }, ['name', 'text'])) }, ['reasons'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { reasons: [{ name: 'ITEM_AS_DESCRIBED', text: 'The item matches its description' }, { name: 'RETURN_WINDOW_EXPIRED', text: 'The request is outside the return window' }, { name: 'ITEM_USED_OR_DAMAGED', text: 'The returned item is used or damaged' }, { name: 'ALREADY_SHIPPED', text: 'The order has already been handed to the carrier' }, { name: 'OTHER', text: 'Other reason' }] } },
      },
      errors: errs({ 400: 'return_or_cancel_id missing.', 404: notFoundAftersale }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202512/orders/{orderId}/aftersale_eligibility': {
    get: op({
      tag: TAG_A,
      summary: 'Get Aftersale Eligibility (202512)',
      description: 'Calls `AftersaleService.eligibility` for the shop\'s order and groups units by SKU. CANCEL is eligible only for AWAITING_SHIPMENT orders; REFUND/RETURN_AND_REFUND only for DELIVERED/COMPLETED orders inside the business-clock return window, and only for units without an active aftersale request. `ineligible_code` -1 is a simulator sentinel.',
      handler: 'AftersaleController.eligibility',
      security: SEC,
      scope: 'sim.aftersale.read',
      pathParams: [{ name: 'orderId', description: 'External order id.', example: '5770123456789012345' }],
      query: [
        ...COMMON_QUERY,
        { name: 'initiate_aftersale_user', schema: str('', { enum: ['SELLER', 'BUYER'] }), description: 'Validated but does not change the result.' },
        { name: 'request_types', description: 'Comma-separated subset of CANCEL, REFUND, RETURN_AND_REFUND. Default: all three.', example: 'CANCEL,REFUND' },
      ],
      ok: {
        description: 'Per-SKU eligibility.',
        schema: envelope(
          obj({
            sku_eligibility: arr(
              obj({
                sku_id: str(),
                line_item_eligibility: arr(obj({ request_type: str(), eligible: bool(), order_line_items_ids: arr(str()), available_reason_names: arr(str()), ineligible_code: int('-1 sentinel; only when not eligible'), ineligible_reason: str('only when not eligible') }, ['request_type', 'eligible', 'order_line_items_ids', 'available_reason_names'])),
              }),
            ),
          }),
        ),
        example: {
          code: 0,
          message: 'Success',
          request_id: '202610150000000000000000000000AB',
          data: {
            sku_eligibility: [
              {
                sku_id: '1729000000000000001',
                line_item_eligibility: [
                  { request_type: 'CANCEL', eligible: true, order_line_items_ids: ['5771000000000000001'], available_reason_names: ['CHANGED_MIND', 'DAMAGED_ITEM', 'NOT_AS_DESCRIBED', 'WRONG_ITEM', 'OTHER'] },
                  { request_type: 'REFUND', eligible: false, order_line_items_ids: [], available_reason_names: [], ineligible_code: -1, ineligible_reason: 'order is AWAITING_SHIPMENT, only DELIVERED/COMPLETED orders can be returned' },
                ],
              },
            ],
          },
        },
      },
      errors: errs({ 400: 'initiate_aftersale_user not SELLER/BUYER, or request_types empty/contains a value outside CANCEL, REFUND, RETURN_AND_REFUND.', 404: 'order_not_found: order does not exist in this shop.' }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202309/cancellations/search': {
    post: op({
      tag: TAG_A,
      summary: 'Search Cancellations (202309)',
      description: 'Same mechanism as Search Returns but for kind CANCELLATION, mapped with `cancellationItem`; page_size range is [1, 50].',
      handler: 'AftersaleController.searchCancellations',
      security: SEC,
      scope: 'sim.aftersale.read',
      query: [...COMMON_QUERY, ...searchQuery(1)],
      body: { schema: cancelFilters, required: false, example: { cancel_status: ['CANCELLATION_REQUEST_PENDING'] } },
      ok: {
        description: 'Page of cancellations.',
        schema: envelope(obj({ next_page_token: str(), cancellations: arr(cancelItemSchema), total_count: int() }, ['next_page_token', 'cancellations', 'total_count'])),
        example: {
          code: 0,
          message: 'Success',
          request_id: '202610150000000000000000000000AB',
          data: {
            next_page_token: '',
            cancellations: [
              {
                cancel_id: '5780123456789012345',
                order_id: '5770123456789012345',
                cancel_status: 'CANCELLATION_REQUEST_PENDING',
                cancel_type: 'BUYER_CANCEL',
                role: 'BUYER',
                cancel_reason: 'CHANGED_MIND',
                cancel_reason_text: 'CHANGED_MIND',
                create_time: 1760000000,
                update_time: 1760000000,
                refund_amount: refundExample,
                cancel_line_items: [{ cancel_line_item_id: '5791000000000000002', order_line_item_id: '5771000000000000001', product_name: 'Cotton T-shirt', sku_id: '1729000000000000001', sku_name: 'Black / M', seller_sku: 'TSHIRT-BLK-M', refund_amount: { ...refundExample, refund_shipping_fee: '0', refund_total: '250000' } }],
              },
            ],
            total_count: 1,
          },
        },
      },
      errors: errs({ 400: 'page_size outside [1, 50], bad sort/page_token, unknown body field, status/type outside enum, bad time or list values.' }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202309/cancellations/{cancelId}/approve': {
    post: op({
      tag: TAG_A,
      summary: 'Approve Cancellation (202309)',
      description: 'Calls `AftersaleService.approveCancellation` as SELLER: transitions the ORDER to CANCELLED (stock restored by the order service). Already SUCCESS/COMPLETE is a no-op success. The request body is not read.',
      handler: 'AftersaleController.approveCancellation',
      security: SEC,
      scope: 'sim.aftersale.write',
      pathParams: [cancelIdParam],
      query: COMMON_QUERY,
      ok: { description: 'Approved.', schema: emptyData(), example: emptyOk },
      errors: errs({ 400: 'invalid_decision: the cancellation is in a state that cannot be approved (e.g. CANCELLED), or invalid_input for other order rule errors.', 404: notFoundAftersale }),
      errorShape: 'tiktok',
    }),
  },
  '/return_refund/202309/cancellations/{cancelId}/reject': {
    post: op({
      tag: TAG_A,
      summary: 'Reject Cancellation (202309)',
      description: 'Requires `reject_reason` (simulator reject-reason name). Calls `AftersaleService.rejectCancellation` as SELLER: PENDING -> CANCELLED, clears the order\'s buyerRequestedCancel flag. Already CANCELLED is a no-op success. `images` is allowed but ignored.',
      handler: 'AftersaleController.rejectCancellation',
      security: SEC,
      scope: 'sim.aftersale.write',
      pathParams: [cancelIdParam],
      query: COMMON_QUERY,
      body: {
        schema: obj(
          {
            reject_reason: str('required', { enum: ['ITEM_AS_DESCRIBED', 'RETURN_WINDOW_EXPIRED', 'ITEM_USED_OR_DAMAGED', 'ALREADY_SHIPPED', 'OTHER'], maxLength: 500 }),
            comment: str('', { maxLength: 500 }),
            images: arr(obj({}, [], { additionalProperties: true })),
          },
          ['reject_reason'],
          { additionalProperties: false },
        ),
        example: { reject_reason: 'ALREADY_SHIPPED', comment: 'Parcel is with the carrier' },
      },
      ok: { description: 'Rejected.', schema: emptyData(), example: emptyOk },
      errors: errs({ 400: 'reject_reason missing/invalid, unknown field, or invalid_decision (request not PENDING).', 404: notFoundAftersale }),
      errorShape: 'tiktok',
    }),
  },

  // ===================================================== Conversations
  '/customer_service/202309/conversations': {
    get: op({
      tag: TAG_C,
      summary: 'Get Conversation List (202309)',
      description: 'Lists the shop\'s conversations in creation order (`seq` ascending, cursor = last seq). For each, loads the latest message and `ChatService.unreadFor`, mapped with `conversationItem`. `page_size` is required.',
      handler: 'ConversationsController.list',
      security: SEC,
      scope: 'sim.conversation.read',
      query: [...COMMON_QUERY, { name: 'page_size', required: true, schema: int('', { minimum: 1, maximum: 20 }), description: 'Integer in [1, 20].' }, PAGE_TOKEN],
      ok: {
        description: 'Page of conversations.',
        schema: envelope(
          obj({
            conversations: arr(obj({ id: str(), create_time: int(), can_send_message: bool(), participant_count: int('3 when a customer-service agent joined, else 2'), participants: arr(participantSchema), unread_count: int(), latest_message: messageSchema }, ['id', 'create_time', 'can_send_message', 'participant_count', 'participants', 'unread_count'])),
            next_page_token: str('empty on the last page'),
          }),
        ),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { conversations: [{ id: '7200000000000000001', create_time: 1760000000, can_send_message: true, participant_count: 2, participants: participantsExample, unread_count: 1, latest_message: messageExample }], next_page_token: '' } },
      },
      errors: errs({ 400: 'page_size missing, non-integer or outside [1, 20]; malformed page_token.' }),
      errorShape: 'tiktok',
    }),
  },
  '/customer_service/202309/conversations/{conversationId}/messages': {
    get: op({
      tag: TAG_C,
      summary: 'Get Conversation Messages (202309)',
      description: 'Verifies the conversation belongs to the shop (`ChatService.ownedByShop`), then pages ChatMessage rows by (create_time or index, seq) with a cursor bound to the chosen sort. `need_data=true` adds an empty `data` string to each message.',
      handler: 'ConversationsController.messages',
      security: SEC,
      scope: 'sim.conversation.read',
      pathParams: [{ name: 'conversationId', example: '7200000000000000001' }],
      query: [
        ...COMMON_QUERY,
        { name: 'page_size', required: true, schema: int('', { minimum: 1, maximum: 10 }), description: 'Integer in [1, 10].' },
        PAGE_TOKEN,
        { name: 'sort_field', schema: str('', { enum: ['create_time', 'index'], default: 'create_time' }) },
        { name: 'sort_order', schema: str('', { enum: ['ASC', 'DESC'], default: 'DESC' }) },
        { name: 'need_data', schema: str('', { enum: ['true', 'false'] }), description: 'Only the literal "true" enables `data`.' },
      ],
      ok: {
        description: 'Page of messages.',
        schema: envelope(obj({ messages: arr(messageSchema), next_page_token: str(), unsupported_msg_tips: str('constant hint text') }, ['messages', 'next_page_token'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { messages: [messageExample], next_page_token: '', unsupported_msg_tips: 'This message type is not supported by the simulator; check it in the simulator Seller view.' } },
      },
      errors: errs({ 400: 'page_size missing/outside [1, 10], bad sort_field/sort_order, bad page_token or token issued for another sort.', 404: 'conversation_not_found: not in this shop.' }),
      errorShape: 'tiktok',
    }),
    post: op({
      tag: TAG_C,
      summary: 'Send Message (202309)',
      description:
        'TEXT only. `content` is a JSON-serialized string `{"content":"<1-2000 chars>"}` with exactly that one key. Checks `canSendMessage`, then `ChatService.postText(..., \'SHOP\', text)`. NOT idempotent: sending twice stores two messages. If the Test Console `dropSendResponse` flag is set, the message is stored and its event emitted but the socket is destroyed before any response (client sees a connection reset).',
      handler: 'ConversationsController.send',
      security: SEC,
      scope: 'sim.conversation.write',
      pathParams: [{ name: 'conversationId', example: '7200000000000000001' }],
      query: COMMON_QUERY,
      body: {
        schema: obj({ type: str('Other documented types are refused', { enum: ['TEXT', 'IMAGE', 'VIDEO', 'PRODUCT_CARD', 'ORDER_CARD', 'RETURN_REFUND_CARD', 'COUPON_CARD', 'LOGISTICS_CARD'] }), content: str('JSON string, e.g. "{\\"content\\":\\"Hello\\"}"') }, ['type', 'content']),
        example: { type: 'TEXT', content: '{"content":"Your parcel ships tomorrow."}' },
      },
      ok: {
        description: 'Message stored.',
        schema: envelope(obj({ message_id: str() }, ['message_id'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { message_id: '7000000000000000002' } },
      },
      errors: errs({
        400: 'invalid_input (type not documented, non-TEXT type, content not a string / invalid JSON / wrong shape / empty / >2000 chars, chat rule error) or cannot_send_message (can_send_message is false).',
        404: 'conversation_not_found: not in this shop.',
      }),
      errorShape: 'tiktok',
    }),
  },
  '/customer_service/202601/conversations/{conversationId}': {
    get: op({
      tag: TAG_C,
      summary: 'Get Conversation Detail (202601)',
      description: 'Looks the conversation up via `ChatService.ownedByShop` and returns id, creation time, participants and the unread count.',
      handler: 'ConversationsController.detail',
      security: SEC,
      scope: 'sim.conversation.read',
      pathParams: [{ name: 'conversationId', example: '7200000000000000001' }],
      query: COMMON_QUERY,
      ok: {
        description: 'Conversation detail.',
        schema: envelope(obj({ conversation: obj({ id: str(), create_time: int(), participant_count: int(), participants: arr(participantSchema), unread_count: int() }, ['id', 'create_time', 'participant_count', 'participants', 'unread_count']) }, ['conversation'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { conversation: { id: '7200000000000000001', create_time: 1760000000, participant_count: 2, participants: participantsExample, unread_count: 0 } } },
      },
      errors: errs({ 404: 'conversation_not_found: not in this shop.' }),
      errorShape: 'tiktok',
    }),
  },
  '/customer_service/202606/conversations/{conversationId}/messages': {
    post: op({
      tag: TAG_C,
      summary: 'Send Message (202606) - not implemented',
      description: 'Always throws TiktokFault 501 unsupported_operation (no schema snapshot in contracts/). The handler has NO TiktokApiGuard, so it answers 501 before any signature/token check; the body is not read.',
      handler: 'ConversationsController.unsupportedSend202606',
      security: SEC,
      pathParams: [{ name: 'conversationId' }],
      query: COMMON_QUERY,
      body: { required: false, schema: obj({}, [], { additionalProperties: true }) },
      ok: { description: 'Never returned.' },
      errors: { 501: 'unsupported_operation: Send Message 202606 has no verified schema snapshot; use 202309.' },
      errorShape: 'tiktok',
    }),
  },
  '/customer_service/202309/images/upload': {
    post: op({
      tag: TAG_C,
      summary: 'Upload Image (202309) - not implemented',
      description: 'Always throws TiktokFault 501 unsupported_operation because multipart request signing is unverified. The handler reads no body (multipart or otherwise) and has NO TiktokApiGuard, so it answers 501 without authentication.',
      handler: 'ConversationsController.unsupportedImageUpload',
      security: SEC,
      query: COMMON_QUERY,
      body: { required: false, contentType: 'multipart/form-data', schema: obj({ data: str('image file (ignored)', { format: 'binary' }) }) },
      ok: { description: 'Never returned.' },
      errors: { 501: 'unsupported_operation: Upload Image (multipart) is unsupported.' },
      errorShape: 'tiktok',
    }),
  },

  // ===================================================== Coupons
  '/promotion/202406/coupons/search': {
    post: op({
      tag: TAG_P,
      summary: 'Search Coupon List (202406)',
      description: 'Read-only. Builds a Prisma filter from the body (status is derived from the window, deactivation flag and the BUSINESS clock), pages by `seq` ascending, and maps rows with `couponSearchItem`. `total_count` ignores the cursor. There is no create/update route.',
      handler: 'CouponsController.search',
      security: SEC,
      scope: 'sim.promotion.read',
      query: [...COMMON_QUERY, { name: 'page_size', schema: int('', { minimum: 1, maximum: 100, default: 50 }), description: 'Integer in [1, 100], default 50.' }, PAGE_TOKEN],
      body: {
        required: false,
        schema: obj(
          {
            status: arr(str('', { enum: ['NOT_START', 'ONGOING', 'EXPIRED', 'DEACTIVATED'] })),
            display_type: arr(str('', { enum: ['REGULAR', 'LIVE', 'CREATOR_EXCLUSIVE', 'CHAT', 'PROMO_CODE'] })),
            title_keyword: str('case-insensitive substring match on title (simulator choice; the OAS does not say)', { minLength: 1, maxLength: 100 }),
          },
          [],
          { description: 'Arrays hold at most 20 strings. Unknown fields -> 400.', additionalProperties: false },
        ),
        example: { status: ['ONGOING'], title_keyword: 'Welcome' },
      },
      ok: {
        description: 'Page of coupons.',
        schema: envelope(obj({ coupons: arr(couponItem), next_page_token: str('empty on the last page'), total_count: int() }, ['coupons', 'next_page_token', 'total_count'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { coupons: [couponExample], next_page_token: '', total_count: 1 } },
      },
      errors: errs({ 400: 'page_size outside [1, 100], malformed page_token, unknown body field, array >20 items or non-strings, undocumented status/display_type value, title_keyword not 1-100 chars.' }),
      errorShape: 'tiktok',
    }),
  },
  '/promotion/202406/coupons/{couponId}': {
    get: op({
      tag: TAG_P,
      summary: 'Get Coupon (202406)',
      description: 'Finds the coupon by (shop, externalId) and returns `couponDetail` (search item plus display_channels and usage_stats; claimed_count equals redeemed_count in the simulator).',
      handler: 'CouponsController.detail',
      security: SEC,
      scope: 'sim.promotion.read',
      pathParams: [{ name: 'couponId', example: '7100000000000000001' }],
      query: COMMON_QUERY,
      ok: {
        description: 'Coupon detail.',
        schema: envelope(obj({ coupon: { allOf: [couponItem, obj({ display_channels: arr(str('always ["PRIVATE"]')), usage_stats: obj({ claimed_count: int(), redeemed_count: int() }) })] } }, ['coupon'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { coupon: { ...couponExample, display_channels: ['PRIVATE'], usage_stats: { claimed_count: 3, redeemed_count: 3 } } } },
      },
      errors: errs({ 404: 'coupon_not_found: unknown id or a coupon of another shop.' }),
      errorShape: 'tiktok',
    }),
  },

  // ===================================================== Fulfillment
  '/fulfillment/202309/orders/{orderId}/tracking': {
    get: op({
      tag: TAG_F,
      summary: 'Get Order Tracking (202309)',
      description: 'Returns the order\'s TrackingEvent rows (oldest first) from `FulfillmentService.trackingOf`, mapping each to a description and millisecond timestamp.',
      handler: 'FulfillmentController.tracking',
      security: SEC,
      scope: 'sim.fulfillment.read',
      pathParams: [{ name: 'orderId', example: '5770123456789012345' }],
      query: COMMON_QUERY,
      ok: {
        description: 'Tracking events.',
        schema: envelope(obj({ tracking: arr(obj({ description: str(), update_time_millis: int('Unix MILLISECONDS') }, ['description', 'update_time_millis'])) }, ['tracking'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { tracking: [{ description: 'Package picked up by carrier', update_time_millis: 1760000000000 }] } },
      },
      errors: errs({ 404: 'order_not_found: unknown order or order of another shop.' }),
      errorShape: 'tiktok',
    }),
  },
  '/fulfillment/202309/packages/{packageId}/shipping_documents': {
    get: op({
      tag: TAG_F,
      summary: 'Get Package Shipping Document (202309)',
      description: 'Validates document_type/format/size, loads the package, then `FulfillmentService.documentFor` creates (or reuses, idempotent per package+type) a document token; `doc_url` points at a /demo/files PDF. A package whose shipment is not arranged has no label.',
      handler: 'FulfillmentController.documents',
      security: SEC,
      scope: 'sim.fulfillment.read',
      pathParams: [{ name: 'packageId', example: '5780000000000000001' }],
      query: [
        ...COMMON_QUERY,
        { name: 'document_type', required: true, schema: str('', { enum: ['SHIPPING_LABEL', 'PACKING_SLIP', 'SHIPPING_LABEL_AND_PACKING_SLIP'] }) },
        { name: 'document_format', schema: str('', { enum: ['PDF'] }), description: 'Only PDF accepted.' },
        { name: 'document_size', schema: str('', { enum: ['A6', 'A5'] }), description: 'Validated but ignored (simulator renders its own size).' },
      ],
      ok: {
        description: 'Document URL.',
        schema: envelope(obj({ doc_url: str(), tracking_number: str() }, ['doc_url', 'tracking_number'])),
        example: { code: 0, message: 'Success', request_id: '202610150000000000000000000000AB', data: { doc_url: 'http://localhost:3000/demo/files/shipping-documents/abc123.pdf', tracking_number: 'SIM123456789' } },
      },
      errors: errs({ 400: 'invalid_input (document_type missing/unsupported, document_format not PDF, document_size not A6/A5) or package_not_arranged (no tracking number yet).', 404: 'package_not_found: not in this shop.' }),
      errorShape: 'tiktok',
    }),
  },
  '/fulfillment/202309/packages/{packageId}': {
    get: op({
      tag: TAG_F,
      summary: 'Get Package Detail (202309)',
      description: 'Loads the package with its order via `FulfillmentService.packageOf` plus the order warehouse and package lines, and builds the response inline in the controller. shipping_type is always TIKTOK, split_and_combine_tag always DEFAULT, region_code always VN.',
      handler: 'FulfillmentController.detail',
      security: SEC,
      scope: 'sim.fulfillment.read',
      pathParams: [{ name: 'packageId', example: '5780000000000000001' }],
      query: COMMON_QUERY,
      ok: {
        description: 'Package detail.',
        schema: envelope(
          obj(
            {
              package_id: str(),
              package_status: str('e.g. TO_FULFILL before shipment is arranged; other values come from the fulfillment service (not fully enumerated here)'),
              create_time: int('Unix seconds'),
              update_time: int('Unix seconds'),
              tracking_number: str('absent until arranged'),
              shipping_provider_id: str(),
              shipping_provider_name: str(),
              shipping_type: str('always TIKTOK'),
              handover_method: str('PICKUP | DROP_OFF; absent until set'),
              has_multi_skus: bool(),
              split_and_combine_tag: str('always DEFAULT'),
              note_tag: str('', { enum: ['BUYER_NOTED', 'BUYER_UNNOTED'] }),
              order_line_item_ids: arr(str()),
              orders: arr(obj({ id: str() })),
              recipient_address: address,
              sender_address: obj({ name: str(), full_address: str(), address_detail: str(), region_code: str() }),
            },
            ['package_id', 'package_status', 'orders'],
          ),
        ),
        example: {
          code: 0,
          message: 'Success',
          request_id: '202610150000000000000000000000AB',
          data: {
            package_id: '5780000000000000001',
            package_status: 'TO_FULFILL',
            create_time: 1760000000,
            update_time: 1760000000,
            shipping_provider_id: '7000000000000000100',
            shipping_provider_name: 'Sim Express',
            shipping_type: 'TIKTOK',
            has_multi_skus: false,
            split_and_combine_tag: 'DEFAULT',
            note_tag: 'BUYER_UNNOTED',
            order_line_item_ids: ['5771000000000000001'],
            orders: [{ id: '5770123456789012345' }],
            recipient_address: { name: 'Nguyen Linh', phone_number: '0900000000', address_detail: '1 Le Loi', address_line1: '1 Le Loi', full_address: '1 Le Loi, District 1, Ho Chi Minh City', postal_code: '700000', region_code: 'VN' },
            sender_address: { name: 'Main warehouse', full_address: 'Main warehouse, Ho Chi Minh City', address_detail: 'Ho Chi Minh City', region_code: 'VN' },
          },
        },
      },
      errors: errs({ 404: 'package_not_found: not in this shop.' }),
      errorShape: 'tiktok',
    }),
  },
  '/fulfillment/202309/packages/{packageId}/ship': {
    post: op({
      tag: TAG_F,
      summary: 'Ship Package (202309)',
      description: 'Finds the package, then `FulfillmentService.arrangeShipment(shop, orderId, \'SELLER\', requestId, handover_method)`. Works only for an order in AWAITING_SHIPMENT; repeating on an already arranged package succeeds without creating a second package. Empty body is allowed.',
      handler: 'FulfillmentController.ship',
      security: SEC,
      scope: 'sim.fulfillment.write',
      pathParams: [{ name: 'packageId', example: '5780000000000000001' }],
      query: COMMON_QUERY,
      body: {
        required: false,
        schema: obj({ handover_method: str('', { enum: ['PICKUP', 'DROP_OFF'] }), pickup_slot: { description: 'Accepted by the field allow-list; not read by the handler.' }, self_shipment: { description: 'Not supported: any value (even null) gives 400.' } }, [], { additionalProperties: false }),
        example: { handover_method: 'PICKUP' },
      },
      ok: { description: 'Shipment arranged.', schema: emptyData(), example: emptyOk },
      errors: errs({
        400: 'invalid_input (non-object body, unknown field, bad handover_method, self_shipment present) or order_not_shippable (message starts with the rule code, e.g. order_unpaid, order_cancelled).',
        404: 'package_not_found: not in this shop.',
      }),
      errorShape: 'tiktok',
    }),
  },
};
