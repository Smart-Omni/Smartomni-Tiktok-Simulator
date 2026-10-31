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
};
