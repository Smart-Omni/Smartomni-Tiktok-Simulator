import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { hashToken } from '../common/hash';
import { ZodPipe } from '../common/zod.pipe';
import { APP_CONFIG, AppConfig } from '../config/config';
import { OAuthModule } from '../oauth/oauth.module';
import { OAuthService } from '../oauth/oauth.service';
import { PrismaService } from '../prisma/prisma.service';
import { AftersaleModule } from '../aftersale/aftersale.module';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { AftersaleDemoController } from './aftersale.controller';
import { OrdersModule } from '../orders/orders.module';
import { ChatModule } from '../chat/chat.module';
import { CatalogDemoController } from './catalog.controller';
import { ChatDemoController } from './chat.controller';
import { CouponsDemoController } from './coupons.controller';
import { FulfillmentDemoController } from './fulfillment.controller';
import { InventoryDemoController } from './inventory.controller';
import { OrdersDemoController } from './orders.controller';
import {
  assertSellerShop,
  assertShopAccess,
  DemoPrincipal,
  DemoRequest,
  DemoSessionGuard,
} from './demo-session.guard';

const CreateSession = z.union([
  z.object({ role: z.literal('SELLER'), sellerId: z.string().min(1), shopId: z.string().min(1).optional() }),
  z.object({ role: z.literal('BUYER'), buyerId: z.string().min(1), shopId: z.string().min(1).optional() }),
]);

const ConsentQuery = z.object({ app_key: z.string().min(1).max(200), redirect_uri: z.string().max(2000).optional(), state: z.string().max(512).optional() });
const ConsentDecision = z.object({
  app_key: z.string().min(1).max(200),
  redirect_uri: z.string().max(2000).optional(),
  state: z.string().max(512).optional(),
  decision: z.enum(['accept', 'deny']),
});

function principal(req: DemoRequest): DemoPrincipal {
  if (!req.demo) throw new UnauthorizedException();
  return req.demo;
}

@Controller()
export class DemoController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OAuthService) private readonly oauth: OAuthService,
  ) {}

  /** Names only, so the demo UI can offer a "sign in as" picker. No tokens, secrets or contact data. */
  @Get('identities')
  async identities() {
    const [sellers, buyers] = await Promise.all([
      this.prisma.seller.findMany({ include: { shops: { select: { id: true, name: true } } }, orderBy: { name: 'asc' } }),
      this.prisma.buyer.findMany({ select: { id: true, name: true, shopId: true }, orderBy: { name: 'asc' } }),
    ]);
    return {
      sellers: sellers.map((s) => ({ id: s.id, name: s.name, shops: s.shops })),
      buyers,
    };
  }

  @Post('sessions')
  async createSession(@Body(new ZodPipe(CreateSession)) body: z.infer<typeof CreateSession>) {
    let shopId: string;
    let buyerId: string | null = null;
    let scope: 'MARKETPLACE' | 'SHOP';
    if (body.role === 'SELLER') {
      const seller = await this.prisma.seller.findUnique({ where: { id: body.sellerId }, include: { shops: true } });
      if (!seller) throw new NotFoundException('Unknown seller');
      const shop = body.shopId ? seller.shops.find((s) => s.id === body.shopId) : seller.shops[0];
      if (!shop) throw new BadRequestException('Seller has no such shop');
      shopId = shop.id;
      scope = 'SHOP';
    } else {
      const buyer = await this.prisma.buyer.findUnique({ where: { id: body.buyerId } });
      if (!buyer) throw new NotFoundException('Unknown buyer');
      const fallbackShop = await this.prisma.shop.findFirst({ where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
      shopId = buyer.shopId ?? body.shopId ?? fallbackShop?.id ?? 'default-shop';
      buyerId = buyer.id;
      scope = 'MARKETPLACE';
    }
    const raw = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + this.config.demoSessionTtlMs);
    await this.prisma.demoSession.create({
      data: { tokenHash: hashToken(raw), role: body.role, shopId, buyerId, expiresAt },
    });
    // The raw token is returned exactly once and never stored or logged (redacted by key name).
    return { sessionToken: raw, role: body.role, scope, shopId, buyerId, expiresAt: expiresAt.toISOString() };
  }

  @Delete('sessions/current')
  @UseGuards(DemoSessionGuard)
  async endSession(@Req() req: DemoRequest) {
    await this.prisma.demoSession.deleteMany({ where: { id: principal(req).sessionId } });
    return { ended: true };
  }

  @Get('me')
  @UseGuards(DemoSessionGuard)
  async me(@Req() req: DemoRequest) {
    const p = principal(req);
    const shop = await this.prisma.shop.findUniqueOrThrow({
      where: { id: p.shopId },
      select: { id: true, name: true, region: true, currency: true, status: true },
    });
    const buyer = p.buyerId
      ? await this.prisma.buyer.findUnique({ where: { id: p.buyerId }, select: { id: true, name: true, city: true } })
      : null;
    return { role: p.role, scope: p.scope, shop, buyer };
  }

  @Get('shops/:shopId')
  @UseGuards(DemoSessionGuard)
  async shop(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    await assertShopAccess(principal(req), shopId, this.prisma);
    const shop = await this.prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: { id: true, name: true, region: true, currency: true, status: true, warehouses: { select: { id: true, code: true, name: true, city: true } } },
    });
    return shop;
  }

  @Get('shops/:shopId/products')
  @UseGuards(DemoSessionGuard)
  async products(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    assertSellerShop(principal(req), shopId);
    const items = await this.prisma.product.findMany({
      where: { shopId },
      orderBy: { title: 'asc' },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        skus: { orderBy: { sellerSku: 'asc' }, select: { id: true, sellerSku: true, name: true, priceVnd: true } },
      },
    });
    return { items, currency: 'VND' };
  }

  @Get('shops/:shopId/buyers')
  @UseGuards(DemoSessionGuard)
  async buyers(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    if (p.role !== 'SELLER') throw new ForbiddenException('Only a seller session can list buyers');
    const items = await this.prisma.buyer.findMany({ where: { shopId }, select: { id: true, name: true, city: true }, orderBy: { name: 'asc' } });
    return { items };
  }

  /**
   * Seller consent (simulator-defined; the real authorization URL is unsupported in the contract). The shop comes from the
   * seller session, never from the URL. Returns what the consent page shows; nothing secret.
   */
  @Get('authorization/consent')
  @UseGuards(DemoSessionGuard)
  async consent(@Req() req: DemoRequest, @Query(new ZodPipe(ConsentQuery)) q: z.infer<typeof ConsentQuery>) {
    const p = principal(req);
    if (p.role !== 'SELLER') throw new ForbiddenException('Only a seller session can authorize an app');
    return this.oauth.consentContext(p.shopId, q.app_key, q.redirect_uri, q.state);
  }

  /** Accept or deny. The response carries the redirect URL (registered URI only, `code`/`error` plus the echoed `state`). */
  @Post('authorization/consent')
  @UseGuards(DemoSessionGuard)
  async decide(@Req() req: DemoRequest, @Body(new ZodPipe(ConsentDecision)) body: z.infer<typeof ConsentDecision>) {
    const p = principal(req);
    if (p.role !== 'SELLER') throw new ForbiddenException('Only a seller session can authorize an app');
    return this.oauth.decide(p.shopId, { appKey: body.app_key, redirectUri: body.redirect_uri, state: body.state, decision: body.decision });
  }
}

@Module({ imports: [OAuthModule, OrdersModule, ChatModule, FulfillmentModule, AftersaleModule], controllers: [DemoController, CatalogDemoController, OrdersDemoController, InventoryDemoController, ChatDemoController, FulfillmentDemoController, CouponsDemoController, AftersaleDemoController], providers: [DemoSessionGuard] })
export class DemoModule {}
