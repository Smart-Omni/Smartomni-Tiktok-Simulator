import { Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { DOC_TYPES, FulfillmentService } from '../fulfillment/fulfillment.service';
import { PrismaService } from '../prisma/prisma.service';
import { assertSellerShop, assertShopAccess, DemoPrincipal, DemoRequest, DemoSessionGuard } from './demo-session.guard';

const LabelBody = z.object({ documentType: z.enum(DOC_TYPES).default('SHIPPING_LABEL') });
const principal = (req: DemoRequest): DemoPrincipal => req.demo!;


/** Seller fulfillment actions and the Buyer tracking view (/demo: not TikTok OpenAPI), plus the public label download. */
@Controller()
export class FulfillmentDemoController {
  constructor(
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Post('shops/:shopId/orders/:orderId/arrange-shipment')
  @UseGuards(DemoSessionGuard)
  async arrange(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('orderId') orderId: string) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const pkg = await this.fulfillment.arrangeShipment(shopId, orderId, 'SELLER', (req as { requestId?: string }).requestId);
    return this.view(shopId, orderId, pkg.status, true);
  }

  @Post('shops/:shopId/orders/:orderId/advance-shipment')
  @UseGuards(DemoSessionGuard)
  async advance(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('orderId') orderId: string) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const pkg = await this.fulfillment.advanceShipment(shopId, orderId, 'SELLER', (req as { requestId?: string }).requestId);
    return this.view(shopId, orderId, pkg.status, true);
  }

  /** Package + tracking. A buyer sees only their own order's progress (no label link); the seller also gets the label URL once arranged. */
  @Get('shops/:shopId/orders/:orderId/fulfillment')
  @UseGuards(DemoSessionGuard)
  async fulfillmentOf(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('orderId') orderId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    if (p.role === 'BUYER') {
      const own = await this.prisma.order.findFirst({ where: { shopId, externalId: orderId, buyerId: p.buyerId ?? '' }, select: { id: true } });
      if (!own) throw new NotFoundException('Unknown order');
    }
    return this.view(shopId, orderId, undefined, p.role === 'SELLER');
  }

  @Post('shops/:shopId/orders/:orderId/shipping-label')
  @UseGuards(DemoSessionGuard)
  async label(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('orderId') orderId: string, @Body(new ZodPipe(LabelBody)) body: z.infer<typeof LabelBody>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const order = await this.fulfillment.orderOf(shopId, orderId);
    const pkg = await this.prisma.package.findUnique({ where: { orderId: order.id } });
    if (!pkg) throw new NotFoundException('This order has no package yet');
    const doc = await this.fulfillment.documentFor(shopId, pkg.externalId, body.documentType);
    return { documentType: body.documentType, trackingNumber: doc.trackingNumber, url: this.fulfillment.documentUrl(doc.token) };
  }

  /** Public (an <img>/<a> cannot send the session header); the 48-hex token is the capability. Content is test data only. */
  @Get('files/shipping-documents/:file')
  @Header('Content-Type', 'application/pdf')
  @Header('Cache-Control', 'no-store')
  @Header('Content-Disposition', 'inline; filename="shipping-document-TEST.pdf"')
  async file(@Param('file') file: string): Promise<StreamableFile> {
    const bytes = await this.fulfillment.readDocument(file.replace(/\.pdf$/, ''));
    if (!bytes) throw new NotFoundException();
    return new StreamableFile(bytes);
  }

  private async view(shopId: string, orderId: string, packageStatus: string | undefined, includeSeller: boolean) {
    const order = await this.fulfillment.orderOf(shopId, orderId);
    const pkg = await this.prisma.package.findUnique({ where: { orderId: order.id } });
    const events = await this.fulfillment.trackingOf(shopId, orderId);
    return {
      orderId: order.externalId,
      orderStatus: order.status,
      package: pkg
        ? {
            id: pkg.externalId,
            status: packageStatus ?? pkg.status,
            trackingNumber: pkg.trackingNumber,
            provider: pkg.shippingProviderName,
            ...(includeSeller ? { canArrange: order.status === 'AWAITING_SHIPMENT' } : {}),
          }
        : null,
      canArrange: includeSeller && order.status === 'AWAITING_SHIPMENT',
      blockedReason: order.status === 'ON_HOLD' ? 'order_on_hold' : order.status === 'UNPAID' ? 'order_unpaid' : null,
      tracking: events.map((e) => ({ status: e.status, description: e.description, at: e.at.toISOString() })),
    };
  }
}
