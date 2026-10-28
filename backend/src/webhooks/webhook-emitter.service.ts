import { Inject, Injectable } from '@nestjs/common';
import { Prisma, Shop } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessClock } from '../clock/clock';
import { FaultService } from '../faults/fault.service';

/**
 * Numeric `type` per topic. Only ORDER_STATUS_CHANGE = 1 appears in a (secondary) sample; the others are NOT verified
 * (contracts/schemas/webhook-envelope.json). They are marked here so nobody mistakes them for contract values.
 */
export const WEBHOOK_TYPE: Record<string, number> = {
  ORDER_STATUS_CHANGE: 1,
  // UNVERIFIED recollection of the Partner Center list; receivers must route on topic-specific fields, not on `type` alone.
  RECIPIENT_ADDRESS_UPDATE: 2,
  PACKAGE_UPDATE: 3,
  PRODUCT_STATUS_CHANGE: 4,
  SELLER_DEAUTHORIZATION: 6,
  UPCOMING_AUTHORIZATION_EXPIRATION: 7,
  CANCELLATION_STATUS_CHANGE: 11,
  RETURN_STATUS_CHANGE: 12,
  NEW_CONVERSATION: 13,
  NEW_MESSAGE: 14,
  DISPUTE_STATUS_CHANGE: 15,
};

export interface WebhookEnvelope {
  type: number;
  tts_notification_id: string;
  shop_id: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Writes webhook jobs for the shop's Events API subscriptions INSIDE the caller's transaction (transactional outbox):
 * a state change and its events commit together, so a crash between them cannot lose or invent an event.
 */
@Injectable()
export class WebhookEmitter {
  constructor(
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(FaultService) private readonly faults: FaultService,
  ) {}

  async emit(tx: Prisma.TransactionClient, shop: Pick<Shop, 'id' | 'tiktokShopId'>, topic: string, data: Record<string, unknown>, requestId?: string | null): Promise<number> {
    const subs = await tx.webhookSubscription.findMany({ where: { shopId: shop.id, eventType: topic }, orderBy: { createdAt: 'asc' } });
    if (subs.length === 0) return 0;
    const reorder = await this.faults.consume('WEBHOOK', shop.id, topic, ['REORDER'], tx) // same transaction client: never take a second pool connection inside a transaction;
    const holdMs = reorder ? Math.min(Number((reorder.params as { holdMs?: number } | null)?.holdMs ?? 5000), 600000) : 0;
    const now = this.clock.now();
    for (const sub of subs) {
      const envelope: WebhookEnvelope = {
        type: WEBHOOK_TYPE[topic] ?? 0,
        tts_notification_id: randomUUID(),
        shop_id: shop.tiktokShopId,
        timestamp: Math.floor(now.getTime() / 1000),
        data,
      };
      await tx.webhookJob.create({
        data: {
          shopId: shop.id,
          appId: sub.appId,
          topic,
          payload: envelope as unknown as Prisma.InputJsonValue,
          targetUrl: sub.address,
          requestId: requestId ?? null,
          // scheduling uses real time (worker time), never the business clock
          nextAttemptAt: new Date(Date.now() + holdMs),
        },
      });
    }
    return subs.length;
  }
}
