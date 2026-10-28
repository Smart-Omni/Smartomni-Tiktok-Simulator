import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { TiktokFaultFilter } from '../tiktok/tiktok-fault.filter';
import { DISPUTE_STATUSES, DisputeService, TriggerDisputeInput } from './dispute.service';

const TriggerSchema = z.object({
  status: z.enum(DISPUTE_STATUSES as [string, ...string[]]),
  dispute_id: z.string().trim().min(1).max(100).optional(),
  disputeId: z.string().trim().min(1).max(100).optional(),
  order_id: z.string().trim().min(1).max(100).optional(),
  orderId: z.string().trim().min(1).max(100).optional(),
  return_id: z.string().trim().min(1).max(100).optional(),
  returnId: z.string().trim().min(1).max(100).optional(),
  shop_id: z.string().trim().min(1).max(100).optional(),
  shopId: z.string().trim().min(1).max(100).optional(),
  reason: z.string().max(500).optional(),
  compensation_amount: z.number().int().min(0).optional(),
  currency: z.string().max(10).optional(),
  compensation: z.record(z.unknown()).optional(),
  adjustment: z.record(z.unknown()).optional(),
  webhook_url: z.string().max(300).optional(),
  webhookUrl: z.string().max(300).optional(),
});

@Controller()
@UseFilters(TiktokFaultFilter)
export class DisputeController {
  constructor(@Inject(DisputeService) private readonly disputeService: DisputeService) {}

  @Post('api/v2/simulator/dispute/trigger')
  @HttpCode(200)
  async trigger(
    @Req() req: Request,
    @Body(new ZodPipe(TriggerSchema)) body: TriggerDisputeInput,
  ) {
    const requestId = (req as any).requestId;
    const result = await this.disputeService.trigger(body, requestId);

    return {
      code: 0,
      message: 'Success',
      data: {
        dispute_id: result.dispute.disputeId,
        dispute_status: result.dispute.status,
        order_id: result.dispute.orderId,
        return_id: result.dispute.returnId,
        reason: result.dispute.reason,
        webhook_dispatched: result.webhookSent || result.webhookEnqueued,
        webhook_enqueued: result.webhookEnqueued,
        webhook_sent: result.webhookSent,
        target_url: result.targetUrl,
        compensation: result.dispute.compensation,
        adjustment: result.dispute.adjustment,
        updated_at: result.dispute.updatedAt.toISOString(),
      },
    };
  }

  @Get('api/v2/simulator/dispute')
  async list() {
    return {
      code: 0,
      message: 'Success',
      data: {
        disputes: this.disputeService.list(),
      },
    };
  }

  @Get('api/v2/simulator/dispute/:id')
  async get(@Param('id') id: string) {
    const dispute = this.disputeService.get(id);
    if (!dispute) throw new NotFoundException(`Dispute ${id} not found`);
    return {
      code: 0,
      message: 'Success',
      data: dispute,
    };
  }
}
