import { Inject, Injectable } from '@nestjs/common';
import { Prisma, Shop } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessClock } from '../clock/clock';
import { FaultService } from '../faults/fault.service';

/**
 * Numeric `type` per topic according to TikTok OpenAPI standards.
 * 1: ORDER_STATUS_CHANGE
 * 2: RECIPIENT_ADDRESS_UPDATE
 * 3: PACKAGE_UPDATE
 * 4: REVERSE_STATUS_UPDATE (Reverse/Return/Refund/Dispute)
 * 5: PRODUCT_STATUS_CHANGE (Product status update)
 * 6: SELLER_DEAUTHORIZATION
 * 7: UPCOMING_AUTHORIZATION_EXPIRATION
 * 8: PRODUCT_AUDIT_STATUS_CHANGE
 * 11: CANCELLATION_STATUS_CHANGE
 * 12: RETURN_STATUS_CHANGE
 * 13: NEW_CONVERSATION
 * 14: NEW_MESSAGE
 * 15: DISPUTE_STATUS_CHANGE
 */
export const WEBHOOK_TYPE: Record<string, number> = {
  ORDER_STATUS_CHANGE: 1,
  RECIPIENT_ADDRESS_UPDATE: 2,
  PACKAGE_UPDATE: 3,
  REVERSE_STATUS_UPDATE: 4,
  PRODUCT_STATUS_CHANGE: 5,
  SELLER_DEAUTHORIZATION: 6,
  UPCOMING_AUTHORIZATION_EXPIRATION: 7,
  PRODUCT_AUDIT_STATUS_CHANGE: 8,
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

export interface SellerDeauthorizationPayload {
  seller_id?: string;
  shop_id: string;
  app_key?: string;
  deauthorized_time: number;
}

export interface UpcomingAuthorizationExpirationPayload {
  seller_id?: string;
  shop_id: string;
  app_key?: string;
  expiration_time: number;
}

export interface ReverseStatusUpdatePayload {
  reverse_id: string;
  return_id: string;
  order_id: string;
  reverse_type: string;
  return_type: string;
  reverse_status: string;
  return_status: string;
  arbitration_status: string;
  update_time: number;
  [key: string]: unknown;
}

export interface ProductStatusChangePayload {
  product_id: string;
  status: string;
  audit_status?: string;
  update_time: number;
  [key: string]: unknown;
}

export function buildSellerDeauthorizationData(shopId: string, appKey?: string, deauthorizedTime?: number): SellerDeauthorizationPayload {
  return {
    shop_id: shopId,
    seller_id: shopId,
    ...(appKey ? { app_key: appKey } : {}),
    deauthorized_time: deauthorizedTime ?? Math.floor(Date.now() / 1000),
  };
}

export function buildUpcomingAuthExpirationData(shopId: string, appKey?: string, expirationTime?: number): UpcomingAuthorizationExpirationPayload {
  return {
    shop_id: shopId,
    seller_id: shopId,
    ...(appKey ? { app_key: appKey } : {}),
    expiration_time: expirationTime ?? Math.floor(Date.now() / 1000) + 30 * 86400,
  };
}

export function buildReverseStatusUpdateData(params: {
  reverseId: string;
  orderId: string;
  reverseType: string;
  reverseStatus: string;
  arbitrationStatus?: string;
  updateTime?: number;
  extra?: Record<string, unknown>;
}): ReverseStatusUpdatePayload {
  const updateTime = params.updateTime ?? Math.floor(Date.now() / 1000);
  const arbitrationStatus = params.arbitrationStatus ?? 'NO_ARBITRATION';
  return {
    reverse_id: params.reverseId,
    return_id: params.reverseId,
    order_id: params.orderId,
    reverse_type: params.reverseType,
    return_type: params.reverseType,
    reverse_status: params.reverseStatus,
    return_status: params.reverseStatus,
    arbitration_status: arbitrationStatus,
    update_time: updateTime,
    ...(params.extra ?? {}),
  };
}

export function buildProductStatusChangeData(params: {
  productId: string;
  status: string;
  auditStatus?: string;
  updateTime?: number;
  extra?: Record<string, unknown>;
}): ProductStatusChangePayload {
  return {
    product_id: params.productId,
    status: params.status,
    audit_status: params.auditStatus ?? (params.status === 'ACTIVATE' ? 'APPROVED' : 'NONE'),
    update_time: params.updateTime ?? Math.floor(Date.now() / 1000),
    ...(params.extra ?? {}),
  };
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
    const reorder = await this.faults.consume('WEBHOOK', shop.id, topic, ['REORDER'], tx);
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
          nextAttemptAt: new Date(Date.now() + holdMs),
        },
      });
    }
    return subs.length;
  }
}
