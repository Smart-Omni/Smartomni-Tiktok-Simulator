import { Inject, Injectable, Module, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { FaultService } from '../faults/fault.service';
import { classifyRouter } from '../http-log/request-log.middleware';
import { OAuthModule } from '../oauth/oauth.module';
import { OAuthService } from '../oauth/oauth.service';
import { AftersaleModule } from '../aftersale/aftersale.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { AftersaleController } from './aftersale.controller';
import { CouponsController } from './coupons.controller';
import { EventsController } from './events.controller';
import { ChatModule } from '../chat/chat.module';
import { ConversationsController } from './conversations.controller';
import { FulfillmentController } from './fulfillment.controller';
import { InventoryController } from './inventory.controller';
import { OrdersController } from './orders.controller';
import { ProductsController } from './products.controller';
import { ShopsController } from './shops.controller';
import { TiktokApiGuard } from './tiktok-api.guard';
import { TokenController } from './token.controller';

/**
 * TikTok-shaped public API (adapter). Method/path/header/JSON shapes come from `contracts/` (Phase 01).
 * Endpoints: GET /api/v2/token/get, GET /api/v2/token/refresh (provisional), GET /authorization/202309/shops (Phase 03);
 * POST /product/202502/products/search, GET /product/202309/products/{id}, GET /logistics/202309/warehouses (Phase 04, read-only);
 * POST /order/202309/orders/search, GET /order/202507/orders, GET/PUT/DELETE /event/202309/webhooks (Phase 05);
 * POST /product/202309/products/{id}/inventory/update (Phase 06, absolute quantity).
 * GET /fulfillment/202309/orders/{id}/tracking, GET .../packages/{id}, GET .../packages/{id}/shipping_documents, POST .../packages/{id}/ship (Phase 07a).
 * This module may import only OAuthModule (token lifecycle); it must never import Demo/TestAdmin/Seed/Reset providers; seed, reset, clock and fault control
 * live exclusively under /test-admin, and scenario helpers under /demo.
 * Unmatched paths return Nest's plain 404 - the simulator does not pretend unsupported endpoints exist.
 */
@Injectable()
export class TiktokFaultMiddleware implements NestMiddleware {
  constructor(
    @Inject(FaultService) private readonly faults: FaultService,
    @Inject(OAuthService) private readonly oauth: OAuthService,
  ) {}

  /** Applies API-target fault rules (set via /test-admin/faults) to TikTok-router requests only. */
  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const path = req.originalUrl.split('?')[0];
    if (classifyRouter(path) !== 'TIKTOK') return next();
    try {
      // Middleware runs before TiktokApiGuard, so the shop is not known yet: resolve it from the access token so that
      // shop-scoped rules can match. Lookup only; authentication still happens in the guard, and req.shopId is left alone.
      const rawAccess = req.header('x-tts-access-token');
      const shopId = rawAccess ? await this.oauth.shopIdOfAccessToken(rawAccess) : null;
      const rule = await this.faults.consume('API', shopId, path);
      if (!rule) return next();
      if (rule.kind === 'DELAY') {
        await new Promise((r) => setTimeout(r, Math.min(Number((rule.params as any)?.delayMs ?? 1000), 30000)));
        return next();
      }
      if (rule.kind === 'HTTP_ERROR') {
        const status = Number((rule.params as any)?.status ?? 500);
        // Body shape is intentionally NOT TikTok's envelope: it is a simulator marker until Phase 01 fixes the contract.
        res.status(status).json({ simulatorFault: true, message: 'Injected by /test-admin/faults', status });
        return;
      }
      return next();
    } catch (e) {
      return next(e);
    }
  }
}

@Module({
  imports: [OAuthModule, ChatModule, FulfillmentModule, AftersaleModule],
  controllers: [TokenController, ShopsController, ProductsController, OrdersController, EventsController, InventoryController, ConversationsController, FulfillmentController, CouponsController, AftersaleController],
  providers: [TiktokFaultMiddleware, TiktokApiGuard],
  exports: [TiktokFaultMiddleware],
})
export class TiktokModule {}
