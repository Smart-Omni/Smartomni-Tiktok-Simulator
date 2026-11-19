import { PathsFragment, arr, envelope, int, obj, op, str } from './helpers';

export const paths: PathsFragment = {
  '/api/v2/media/upload': {
    post: op({
      tag: 'Media',
      summary: 'Mock media upload',
      description: 'Upload mock media (image or video) and get a TikTok Shop Open API formatted response with media_id and media_url.',
      handler: 'MediaController.uploadMedia',
      security: [],
      body: {
        contentType: 'multipart/form-data',
        schema: obj({
          file: str('Image or video binary file', { format: 'binary' }),
          file_name: str('Optional custom filename'),
          media_id: str('Optional custom media_id'),
        }),
      },
      ok: {
        description: 'Upload succeeded',
        schema: envelope(
          obj(
            {
              media_id: str('Media ID'),
              media_url: str('Hosted media URL'),
            },
            ['media_id', 'media_url'],
          ),
        ),
        example: {
          code: 0,
          message: 'Success',
          request_id: 'mock_req_123',
          data: {
            media_id: 'mock_media_123456',
            media_url: 'https://simulator.smartomni.local/uploads/mock_evidence.jpg',
          },
        },
      },
      errorShape: 'tiktok',
    }),
  },

  '/api/v2/simulator/dispute/trigger': {
    post: op({
      tag: 'Simulator Dispute',
      summary: 'Trigger dispute simulation event',
      description:
        'Triggers dispute state transitions (DISPUTE_PENDING_REVIEW, DISPUTE_APPROVED, DISPUTE_REJECTED). When DISPUTE_APPROVED is triggered, fires a DISPUTE_STATUS_CHANGE webhook event with compensation and adjustment info.',
      handler: 'DisputeController.trigger',
      security: [],
      body: {
        schema: obj(
          {
            status: str('Dispute status', {
              enum: ['DISPUTE_PENDING_REVIEW', 'DISPUTE_APPROVED', 'DISPUTE_REJECTED'],
            }),
            dispute_id: str('Dispute ID'),
            order_id: str('Order ID'),
            return_id: str('Return / Aftersale ID'),
            shop_id: str('Shop ID'),
            reason: str('Dispute reason'),
            compensation_amount: int('Compensation amount (VND)'),
            currency: str('Currency', { default: 'VND' }),
            webhook_url: str('Target webhook URL override'),
          },
          ['status'],
        ),
        example: {
          status: 'DISPUTE_APPROVED',
          dispute_id: 'mock_dispute_123456',
          order_id: '5770000000000000001',
          compensation_amount: 100000,
        },
      },
      ok: {
        description: 'Dispute trigger processed',
        schema: envelope(
          obj(
            {
              dispute_id: str(),
              dispute_status: str(),
              order_id: str(),
              webhook_dispatched: str(),
            },
            ['dispute_id', 'dispute_status'],
          ),
        ),
        example: {
          code: 0,
          message: 'Success',
          data: {
            dispute_id: 'mock_dispute_123456',
            dispute_status: 'DISPUTE_APPROVED',
            order_id: '5770000000000000001',
            webhook_dispatched: true,
          },
        },
      },
      errorShape: 'tiktok',
    }),
  },

  '/api/v2/simulator/dispute': {
    get: op({
      tag: 'Simulator Dispute',
      summary: 'List simulated disputes',
      description: 'Returns all currently tracked dispute records in the simulator.',
      handler: 'DisputeController.list',
      security: [],
      ok: {
        description: 'Dispute list',
        schema: envelope(
          obj(
            {
              disputes: arr(
                obj({
                  disputeId: str(),
                  orderId: str(),
                  status: str(),
                }),
              ),
            },
            ['disputes'],
          ),
        ),
      },
      errorShape: 'tiktok',
    }),
  },

  '/api/v2/simulator/dispute/{id}': {
    get: op({
      tag: 'Simulator Dispute',
      summary: 'Get simulated dispute by ID',
      description: 'Returns the dispute record and its current status.',
      handler: 'DisputeController.get',
      security: [],
      pathParams: [{ name: 'id', description: 'Dispute ID', example: 'mock_dispute_123456' }],
      ok: {
        description: 'Dispute detail',
        schema: envelope(
          obj(
            {
              disputeId: str(),
              orderId: str(),
              status: str(),
            },
            ['disputeId', 'status'],
          ),
        ),
      },
      errors: { 404: 'Dispute not found' },
      errorShape: 'tiktok',
    }),
  },

  '/product/202309/categories/{categoryId}/attributes': {
    get: op({
      tag: 'Product',
      summary: 'Get Attributes',
      description: 'OAS: GET /product/202309/categories/{category_id}/attributes. category_id must be a leaf category.',
      handler: 'ProductsController.categoryAttributes',
      security: ['TiktokSignedApi'],
      pathParams: [{ name: 'categoryId', description: 'Leaf category id.', example: '100002' }],
      query: [{ name: 'locale' }, { name: 'category_version' }],
      errors: { 400: 'invalid_input: category is not an existing leaf category, or locale is malformed.' },
      errorShape: 'tiktok',
      ok: { description: 'Attributes list', schema: envelope(obj({ attributes: arr(obj({})) })) },
    }),
  },

  '/product/202309/categories/{categoryId}/rules': {
    get: op({
      tag: 'Product',
      summary: 'Get Category Rules',
      description: 'OAS: GET /product/202309/categories/{category_id}/rules. category_id must be a leaf category.',
      handler: 'ProductsController.categoryRules',
      security: ['TiktokSignedApi'],
      pathParams: [{ name: 'categoryId', description: 'Leaf category id.', example: '100002' }],
      query: [{ name: 'locale' }, { name: 'category_version' }],
      errors: { 400: 'invalid_input: category is not an existing leaf category, or locale is malformed.' },
      errorShape: 'tiktok',
      ok: { description: 'Category rules', schema: envelope(obj({ cod: obj({}), package_dimension: obj({}), size_chart: obj({}) })) },
    }),
  },

  '/product/202309/attributes': {
    get: op({
      tag: 'Product',
      summary: 'Get Product Attributes (removed)',
      description: 'Not an official path. Always 501 unsupported_operation, no guard (DECISIONS DA-3).',
      handler: 'ProductsController.attributesRemoved',
      security: [],
      errors: { 501: 'unsupported_operation' },
      errorShape: 'tiktok',
      ok: { description: 'Never returned.' },
    }),
  },

  '/product/202309/rules': {
    get: op({
      tag: 'Product',
      summary: 'Get Product Rules (removed)',
      description: 'Not an official path. Always 501 unsupported_operation, no guard (DECISIONS DA-3).',
      handler: 'ProductsController.rulesRemoved',
      security: [],
      errors: { 501: 'unsupported_operation' },
      errorShape: 'tiktok',
      ok: { description: 'Never returned.' },
    }),
  },

  '/product/202309/brands': {
    get: op({
      tag: 'Product',
      summary: 'Get Brands',
      handler: 'ProductsController.brands',
      security: ['TiktokSignedApi'],
      query: [
        { name: 'page_size', required: true, description: 'Integer in [1, 100].', schema: { type: 'integer', minimum: 1, maximum: 100 }, example: 20 },
        { name: 'page_token' },
        { name: 'category_id' },
        { name: 'is_authorized', schema: { type: 'boolean' } },
        { name: 'brand_name', description: 'Case-insensitive prefix filter.' },
        { name: 'category_version' },
      ],
      errors: { 400: 'invalid_input: page_size missing or out of range, bad page_token, unknown category_id.' },
      errorShape: 'tiktok',
      ok: { description: 'Brands page', schema: envelope(obj({ brands: arr(obj({})), next_page_token: str(), total_count: int() })) },
    }),
  },

  '/product/202309/categories': {
    get: op({
      tag: 'Product',
      summary: 'Get Categories',
      handler: 'ProductsController.categories',
      security: ['TiktokSignedApi'],
      query: [
        { name: 'locale' },
        { name: 'keyword', description: 'Substring filter on local_name.' },
        { name: 'category_version' },
        { name: 'include_prohibited_categories', schema: { type: 'boolean' } },
      ],
      errors: { 400: 'invalid_input: malformed locale or boolean.' },
      errorShape: 'tiktok',
      ok: { description: 'Categories', schema: envelope(obj({ categories: arr(obj({})) })) },
    }),
  },

  '/product/202309/products': {
    post: op({
      tag: 'Product',
      summary: 'Create Product',
      handler: 'ProductsController.createProduct',
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Created product', schema: envelope(obj({ product_id: str() })) },
    }),
  },

  '/product/202509/products/{productId}': {
    put: op({
      tag: 'Product',
      summary: 'Edit Product',
      handler: 'ProductsController.editProduct',
      pathParams: [{ name: 'productId', description: 'Product ID' }],
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Updated product', schema: envelope(obj({ product_id: str() })) },
    }),
  },

  '/product/202309/products/activate': {
    post: op({
      tag: 'Product',
      summary: 'Activate Products',
      handler: 'ProductsController.activateProducts',
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Activated products result', schema: envelope(obj({ errors: arr(obj({})) })) },
    }),
  },

  '/product/202309/products/deactivate': {
    post: op({
      tag: 'Product',
      summary: 'Deactivate Products',
      handler: 'ProductsController.deactivateProducts',
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Deactivated products result', schema: envelope(obj({ errors: arr(obj({})) })) },
    }),
  },

  '/product/202309/products/listing_check': {
    post: op({
      tag: 'Product',
      summary: 'Check Product Listing',
      handler: 'ProductsController.listingCheck',
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Listing check result', schema: envelope(obj({ check_result: str('PASS | FAILED'), fail_reasons: arr(obj({ code: int(), message: str() })) })) },
    }),
  },

  '/product/202309/images/upload': {
    post: op({
      tag: 'Product',
      summary: 'Upload Product Image',
      handler: 'ProductsController.uploadImage',
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Uploaded image info', schema: envelope(obj({ url: str(), uri: str() })) },
    }),
  },

  '/product/202309/files/upload': {
    post: op({
      tag: 'Product',
      summary: 'Upload Product File',
      handler: 'ProductsController.uploadFile',
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Uploaded file info', schema: envelope(obj({ url: str(), id: str() })) },
    }),
  },

  '/return_refund/202602/returns/search': {
    post: op({
      tag: 'Aftersale',
      summary: 'Search Returns 202602',
      handler: 'AftersaleController.searchReturns202602',
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Returns search list', schema: envelope(obj({ return_orders: arr(obj({})), returns: arr(obj({})) })) },
    }),
  },

  '/return_refund/202602/orders/{orderId}/aftersale_eligibility': {
    get: op({
      tag: 'Aftersale',
      summary: 'Get Aftersale Eligibility 202602',
      handler: 'AftersaleController.eligibility202602',
      pathParams: [{ name: 'orderId', description: 'Order ID' }],
      security: ['TiktokSignedApi'],
      errorShape: 'tiktok',
      ok: { description: 'Aftersale eligibility info', schema: envelope(obj({ request_types: arr(str()) })) },
    }),
  },

  '/demo/shops/{shopId}/aftersale/{id}/dispute': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Buyer Dispute Trigger',
      handler: 'DemoAftersaleController.raiseDispute',
      pathParams: [{ name: 'shopId', description: 'Shop ID' }, { name: 'id', description: 'Aftersale request ID' }],
      security: ['DemoSession'],
      errorShape: 'nest',
      ok: { description: 'Dispute raised result', schema: obj({ changed: str() }) },
    }),
  },

  '/demo/shops/{shopId}/aftersale/{id}/arbitrate': {
    post: op({
      tag: 'Demo Aftersale',
      summary: 'Admin / Operator Arbitrate Trigger',
      handler: 'DemoAftersaleController.arbitrate',
      pathParams: [{ name: 'shopId', description: 'Shop ID' }, { name: 'id', description: 'Aftersale request ID' }],
      security: ['DemoSession'],
      errorShape: 'nest',
      ok: { description: 'Arbitration result', schema: obj({ changed: str() }) },
    }),
  },

  '/test-admin/aftersale/{ref}/arbitration': {
    post: op({
      tag: 'Test Admin Aftersale',
      summary: 'Test Admin Arbitrate',
      handler: 'TestAdminController.arbitrateAftersale',
      pathParams: [{ name: 'ref', description: 'Aftersale Request ID or external ID' }],
      security: ['TestAdminToken'],
      errorShape: 'nest',
      ok: { description: 'Arbitration adjudication result', schema: obj({ arbitration_status: str() }) },
    }),
  },
};
