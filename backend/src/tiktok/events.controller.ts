import { Controller, Delete, Get, HttpCode, Inject, Put, Req, UseFilters, UseGuards } from '@nestjs/common';
import { BusinessClock } from '../clock/clock';
import { TiktokFault } from '../common/tiktok-fault';
import { SCOPE_EVENT_MANAGE } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

/** `event_type` topics listed in the official OAS description of PUT /event/202309/webhooks. */
export const EVENT_TOPICS = new Set([
  'ORDER_STATUS_CHANGE',
  'RECIPIENT_ADDRESS_UPDATE',
  'PACKAGE_UPDATE',
  'PRODUCT_STATUS_CHANGE',
  'SELLER_DEAUTHORIZATION',
  'UPCOMING_AUTHORIZATION_EXPIRATION',
  'CANCELLATION_STATUS_CHANGE',
  'RETURN_STATUS_CHANGE',
  'NEW_CONVERSATION',
  'NEW_MESSAGE',
  'PRODUCT_INFORMATION_CHANGE',
  'PRODUCT_CREATION',
  'PRODUCT_CATEGORY_CHANGE',
  'NEW_MESSAGE_LISTENER',
  'INVOICE_STATUS_CHANGE',
  'PRODUCT_AUDIT_STATUS_CHANGE',
  'REVERSE_STATUS_UPDATE',
  'DISPUTE_STATUS_CHANGE',
]);

/**
 * Events API: webhook subscriptions per (shop of the token, app of the token, event_type). Only the subscribed topics are ever delivered.
 * Whether the simulator can actually EMIT a topic depends on its phase (Phase 05: ORDER_STATUS_CHANGE); subscribing to others is accepted and stored.
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class EventsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
  ) {}

  @Get('event/202309/webhooks')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_EVENT_MANAGE)
  async list(@Req() req: TiktokRequest) {
    const { shop, app } = req.tiktok!;
    const subs = await this.prisma.webhookSubscription.findMany({ where: { shopId: shop.id, appId: app.id }, orderBy: { eventType: 'asc' } });
    return this.envelope(req, {
      total_count: subs.length,
      webhooks: subs.map((s) => ({ address: s.address, create_time: Math.floor(s.createdAt.getTime() / 1000), event_type: s.eventType, update_time: Math.floor(s.updatedAt.getTime() / 1000) })),
    });
  }

  @Put('event/202309/webhooks')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_EVENT_MANAGE)
  async put(@Req() req: TiktokRequest) {
    const { shop, app } = req.tiktok!;
    const body = (req.body ?? {}) as { event_type?: unknown; address?: unknown };
    const eventType = this.eventType(body.event_type);
    const address = body.address;
    if (typeof address !== 'string' || address.length === 0 || address.length > 255) throw new TiktokFault(400, 'invalid_input', 'address is required (max 255 characters)');
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new TiktokFault(400, 'invalid_input', 'address must be an absolute URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TiktokFault(400, 'invalid_input', 'address must be http(s)');
    const now = this.clock.now();
    await this.prisma.webhookSubscription.upsert({
      where: { shopId_appId_eventType: { shopId: shop.id, appId: app.id, eventType } },
      create: { shopId: shop.id, appId: app.id, eventType, address, createdAt: now, updatedAt: now },
      update: { address, updatedAt: now },
    });
    return this.envelope(req, {});
  }

  @Delete('event/202309/webhooks')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_EVENT_MANAGE)
  async remove(@Req() req: TiktokRequest) {
    const { shop, app } = req.tiktok!;
    const eventType = this.eventType(((req.body ?? {}) as { event_type?: unknown }).event_type);
    await this.prisma.webhookSubscription.deleteMany({ where: { shopId: shop.id, appId: app.id, eventType } });
    return this.envelope(req, {});
  }

  private eventType(value: unknown): string {
    if (typeof value !== 'string' || !EVENT_TOPICS.has(value)) throw new TiktokFault(400, 'invalid_input', 'event_type is not a documented webhook topic');
    return value;
  }

  private envelope(req: TiktokRequest, data: unknown) {
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data };
  }
}
