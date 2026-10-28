import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessClock } from '../clock/clock';
import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_TYPE, WebhookEnvelope } from '../webhooks/webhook-emitter.service';
import { WebhookQueueService } from '../webhooks/webhook-queue.service';

export type DisputeStatus = 'DISPUTE_PENDING_REVIEW' | 'DISPUTE_APPROVED' | 'DISPUTE_REJECTED';

export const DISPUTE_STATUSES: DisputeStatus[] = [
  'DISPUTE_PENDING_REVIEW',
  'DISPUTE_APPROVED',
  'DISPUTE_REJECTED',
];

export interface CompensationInfo {
  type: string;
  adjustment_type: string;
  amount: number;
  currency: string;
  reason: string;
  create_time: number;
  [key: string]: unknown;
}

export interface AdjustmentInfo {
  type: string;
  adjustment_type: string;
  amount: number;
  currency: string;
  [key: string]: unknown;
}

export interface DisputeRecord {
  disputeId: string;
  orderId: string;
  returnId?: string;
  shopId: string;
  status: DisputeStatus;
  reason?: string;
  compensation?: CompensationInfo;
  adjustment?: AdjustmentInfo;
  createdAt: Date;
  updatedAt: Date;
}

export interface TriggerDisputeInput {
  dispute_id?: string;
  disputeId?: string;
  order_id?: string;
  orderId?: string;
  return_id?: string;
  returnId?: string;
  shop_id?: string;
  shopId?: string;
  status: DisputeStatus;
  reason?: string;
  compensation_amount?: number;
  currency?: string;
  compensation?: Record<string, unknown>;
  adjustment?: Record<string, unknown>;
  webhook_url?: string;
  webhookUrl?: string;
}

export function validateDisputeTransition(from: DisputeStatus | undefined, to: DisputeStatus): void {
  if (!from) return; // Initial creation
  if (from === to) return; // Idempotent

  if (from === 'DISPUTE_PENDING_REVIEW') {
    if (to === 'DISPUTE_APPROVED' || to === 'DISPUTE_REJECTED') {
      return;
    }
  }

  if (from === 'DISPUTE_APPROVED') {
    throw new BadRequestException(
      `Invalid state transition: dispute is already in DISPUTE_APPROVED state and cannot be moved to ${to}`,
    );
  }

  if (from === 'DISPUTE_REJECTED') {
    throw new BadRequestException(
      `Invalid state transition: dispute is already in DISPUTE_REJECTED state and cannot be moved to ${to}`,
    );
  }

  throw new BadRequestException(`Invalid state transition from ${from} to ${to}`);
}

@Injectable()
export class DisputeService {
  private readonly logger = new Logger(DisputeService.name);
  private readonly disputes = new Map<string, DisputeRecord>();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(WebhookQueueService) private readonly queue: WebhookQueueService,
  ) {}

  clear(): void {
    this.disputes.clear();
  }

  get(id: string): DisputeRecord | undefined {
    return this.disputes.get(id);
  }

  list(): DisputeRecord[] {
    return [...this.disputes.values()];
  }

  async trigger(input: TriggerDisputeInput, requestId?: string): Promise<{
    dispute: DisputeRecord;
    webhookSent: boolean;
    webhookEnqueued: boolean;
    targetUrl?: string;
  }> {
    const disputeId = input.dispute_id || input.disputeId || `mock_dispute_${Date.now()}`;
    const orderId = input.order_id || input.orderId || `order_${randomUUID().slice(0, 8)}`;
    const returnId = input.return_id || input.returnId;
    const now = this.clock.now();

    const existing = this.disputes.get(disputeId);
    validateDisputeTransition(existing?.status, input.status);

    // Resolve shop
    const reqShopId = input.shop_id || input.shopId;
    let shop = reqShopId
      ? await this.prisma.shop.findFirst({
          where: { OR: [{ id: reqShopId }, { tiktokShopId: reqShopId }] },
        })
      : null;

    if (!shop) {
      shop = await this.prisma.shop.findFirst({ where: { status: 'ACTIVE' } });
    }

    const shopEntity = shop ?? {
      id: reqShopId || 'mock_shop_id',
      tiktokShopId: reqShopId || '7494000000000000001',
    };

    let compensation: CompensationInfo | undefined;
    let adjustment: AdjustmentInfo | undefined;
    let webhookSent = false;
    let webhookEnqueued = false;
    let targetUrl: string | undefined;

    if (input.status === 'DISPUTE_APPROVED') {
      const compAmount =
        input.compensation_amount ??
        (typeof input.compensation?.amount === 'number'
          ? input.compensation.amount
          : typeof input.adjustment?.amount === 'number'
            ? input.adjustment.amount
            : 100000);

      const currency =
        input.currency ||
        (typeof input.compensation?.currency === 'string'
          ? input.compensation.currency
          : typeof input.adjustment?.currency === 'string'
            ? input.adjustment.currency
            : 'VND');

      compensation = {
        type: 'COMPENSATION',
        adjustment_type: 'ADJUSTMENT',
        amount: compAmount,
        currency,
        reason: input.reason || 'DISPUTE_RESOLVED_COMPENSATION',
        create_time: Math.floor(now.getTime() / 1000),
        ...(input.compensation || {}),
      };

      adjustment = {
        type: 'COMPENSATION',
        adjustment_type: 'ADJUSTMENT',
        amount: compAmount,
        currency,
        ...(input.adjustment || {}),
      };

      // Resolve webhook target URL
      targetUrl = input.webhook_url || input.webhookUrl;
      if (!targetUrl) {
        const sub = await this.prisma.webhookSubscription.findFirst({
          where: { shopId: shopEntity.id, eventType: 'DISPUTE_STATUS_CHANGE' },
        });
        if (sub) {
          targetUrl = sub.address;
        } else {
          const anySub = await this.prisma.webhookSubscription.findFirst({
            where: { shopId: shopEntity.id },
          });
          if (anySub) {
            targetUrl = anySub.address;
          } else {
            targetUrl =
              process.env.SMARTOMNI_WEBHOOK_URL ||
              process.env.SMARTOMNI_BE_WEBHOOK_URL ||
              'http://localhost:8080/api/v1/integrations/tiktok/webhook';
          }
        }
      }

      // Build standard TikTok Webhook envelope
      const topic = 'DISPUTE_STATUS_CHANGE';
      const eventData = {
        dispute_id: disputeId,
        dispute_status: 'DISPUTE_APPROVED',
        order_id: orderId,
        ...(returnId ? { return_id: returnId } : {}),
        update_time: Math.floor(now.getTime() / 1000),
        reason: input.reason || 'Dispute approved by platform',
        compensation,
        adjustment,
        adjustment_info: adjustment,
      };

      const envelope: WebhookEnvelope = {
        type: WEBHOOK_TYPE[topic] ?? 15,
        tts_notification_id: randomUUID(),
        shop_id: shopEntity.tiktokShopId,
        timestamp: Math.floor(now.getTime() / 1000),
        data: eventData,
      };

      // 1. Enqueue job into durable PostgreSQL queue (transactional outbox)
      try {
        await this.queue.enqueue({
          shopId: shopEntity.id,
          topic,
          payload: envelope as unknown as Prisma.InputJsonValue,
          targetUrl,
          requestId: requestId || null,
        });
        webhookEnqueued = true;
      } catch (err: any) {
        this.logger.warn(`Failed to enqueue webhook job: ${err?.message}`);
      }

      // 2. Direct delivery attempt (immediate notification for tests or listeners)
      try {
        const directHeaders: Record<string, string> = {
          'content-type': 'application/json',
          'x-simulator-webhook-id': envelope.tts_notification_id,
          'x-simulator-event': topic,
          ...(requestId ? { 'x-request-id': requestId } : {}),
        };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(targetUrl, {
          method: 'POST',
          headers: directHeaders,
          body: JSON.stringify(envelope),
          signal: controller.signal,
        });
        clearTimeout(timer);
        webhookSent = res.ok;
      } catch {
        // Direct delivery timeout or connection refused is expected when external receiver is offline
        webhookSent = false;
      }
    }

    const record: DisputeRecord = {
      disputeId,
      orderId,
      returnId,
      shopId: shopEntity.id,
      status: input.status,
      reason: input.reason,
      compensation,
      adjustment,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.disputes.set(disputeId, record);

    return {
      dispute: record,
      webhookSent,
      webhookEnqueued,
      targetUrl,
    };
  }
}
