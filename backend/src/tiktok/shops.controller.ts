import { Controller, Delete, Get, HttpCode, Inject, Req, UseFilters, UseGuards } from '@nestjs/common';
import { AuthClock, BusinessClock } from '../clock/clock';
import { FaultService } from '../faults/fault.service';
import { SCOPE_AUTHORIZED_SHOPS } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookEmitter } from '../webhooks/webhook-emitter.service';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

/**
 * GET /authorization/202309/shops (official OAS shape: schemas/ops/auth.shops.response.json).
 * Returns ONLY the shop of the presented access token. No tenant id exists in this schema.
 * `region: VN` and `seller_type: LOCAL` for the seeded shops are UNVERIFIED (see manifest).
 * DELETE /authorization/202403/shops (DeauthorizeShop) revokes every token of this app for this shop (DECISIONS DA-11).
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class ShopsController {
  private readonly emitter: WebhookEmitter;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuthClock) private readonly authClock: AuthClock,
    @Inject(BusinessClock) clock: BusinessClock,
    @Inject(FaultService) faults: FaultService,
  ) {
    this.emitter = new WebhookEmitter(clock, faults);
  }

  @Get('authorization/202309/shops')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AUTHORIZED_SHOPS)
  shops(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    return {
      code: 0,
      message: 'Success',
      request_id: req.requestId ?? 'unknown',
      data: { shops: [{ cipher: shop.shopCipher, code: shop.code, id: shop.tiktokShopId, name: shop.name, region: shop.region, seller_type: shop.sellerType }] },
    };
  }

  /** The seller's authorization is removed: tokens stop working at once and SELLER_DEAUTHORIZATION is queued in the same transaction. */
  @Delete('authorization/202403/shops')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AUTHORIZED_SHOPS)
  async deauthorize(@Req() req: TiktokRequest) {
    const { shop, app } = req.tiktok!;
    await this.prisma.$transaction(async (tx) => {
      await tx.token.updateMany({ where: { appId: app.id, shopId: shop.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: this.authClock.now() } });
      await this.emitter.emit(tx, shop, 'SELLER_DEAUTHORIZATION', { shop_id: shop.tiktokShopId, app_key: app.appKey, reason: 'DEAUTHORIZED_BY_APP' }, req.requestId);
    });
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data: {} };
  }
}
