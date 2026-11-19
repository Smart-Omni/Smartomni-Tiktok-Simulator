import { Body, Controller, ForbiddenException, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AftersaleRow, AftersaleService, REJECT_REASONS, REQUEST_REASONS } from '../aftersale/aftersale.service';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertSellerShop,
  assertShopAccess,
  DemoPrincipal,
  DemoRequest,
  DemoSessionGuard,
} from './demo-session.guard';

const BUYER_RETURN_TYPES = ['REFUND', 'RETURN_AND_REFUND'] as const;

const CreateReturn = z.object({
  orderId: z.string().min(1).max(100),
  items: z.array(z.object({ skuId: z.string().min(1).max(100), quantity: z.number().int().min(1).max(50) })).min(1).max(50),
  returnType: z.enum(BUYER_RETURN_TYPES),
  reason: z.string().trim().min(1).max(300).default('OTHER'),
  sellerProposedReturnType: z.string().max(50).optional(),
});
const CreateCancellation = z.object({ orderId: z.string().min(1).max(100), reason: z.string().trim().min(1).max(300).default('CHANGED_MIND') });
const Approve = z.object({ decision: z.string().max(60).optional() });
const Reject = z.object({ reason: z.string().min(1).max(100), comment: z.string().max(500).optional(), decision: z.string().max(60).optional() });
const Arbitrate = z.object({
  decision: z.enum(['WIN', 'LOSS', 'ARBITRATION_WIN', 'ARBITRATION_LOSS']),
  note: z.string().max(500).optional(),
});

function principal(req: DemoRequest): DemoPrincipal {
  return req.demo!;
}

function buyerOf(p: DemoPrincipal, shopId?: string): { id: string; shopId: string } {
  if (p.role !== 'BUYER' || !p.buyerId) throw new ForbiddenException('Only a buyer session can do this');
  return { id: p.buyerId, shopId: shopId ?? p.shopId };
}

/** What the demo UIs see of a request: integer VND components and the units grouped per SKU. */
export function aftersaleView(r: AftersaleRow) {
  const bySku = new Map<string, { skuId: string; productName: string; skuName: string; quantity: number }>();
  for (const l of r.lines) {
    const row = bySku.get(l.orderLine.skuExternalId) ?? { skuId: l.orderLine.skuExternalId, productName: l.orderLine.productName, skuName: l.orderLine.skuName, quantity: 0 };
    row.quantity += 1;
    bySku.set(l.orderLine.skuExternalId, row);
  }
  return {
    id: r.externalId,
    orderId: r.order.externalId,
    kind: r.kind,
    type: r.type,
    status: r.status,
    reason: r.reason,
    role: r.role,
    rejectReason: r.rejectReason,
    returnTrackingNumber: r.returnTrackingNumber,
    arbitrationStatus: r.arbitrationStatus ?? 'NO_ARBITRATION',
    sellerProposedReturnType: r.sellerProposedReturnType ?? null,
    buyer: { id: r.order.buyer.externalId, name: r.order.buyer.name },
    refund: { subtotalVnd: r.refundSubtotal, shippingVnd: r.refundShipping, totalVnd: r.refundTotal },
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    items: [...bySku.values()],
  };
}

/** Buyer aftersale requests and Seller decisions through /demo (the TikTok-shaped write operations live on the TikTok router). */
@Controller()
export class AftersaleDemoController {
  constructor(
    @Inject(AftersaleService) private readonly aftersale: AftersaleService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  private rid(req: DemoRequest): string | undefined {
    return (req as { requestId?: string }).requestId;
  }

  @Get('shops/:shopId/aftersale')
  @UseGuards(DemoSessionGuard)
  async list(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const rows = await this.aftersale.listForShop(shopId, p.role === 'BUYER' ? buyerOf(p, shopId).id : undefined);
    return { items: rows.map(aftersaleView), requestReasons: REQUEST_REASONS, rejectReasons: REJECT_REASONS };
  }

  @Post('shops/:shopId/aftersale/returns')
  @UseGuards(DemoSessionGuard)
  async createReturn(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CreateReturn)) body: z.infer<typeof CreateReturn>) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    return {
      request: aftersaleView(
        await this.aftersale.createReturn(
          buyerOf(p, shopId),
          body.orderId,
          { items: body.items, returnType: body.returnType, reason: body.reason, sellerProposedReturnType: body.sellerProposedReturnType },
          this.rid(req),
        ),
      ),
    };
  }

  @Post('shops/:shopId/aftersale/cancellations')
  @UseGuards(DemoSessionGuard)
  async createCancellation(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CreateCancellation)) body: z.infer<typeof CreateCancellation>) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    return { request: aftersaleView(await this.aftersale.createCancellation(buyerOf(p, shopId), body.orderId, body.reason, this.rid(req))) };
  }

  @Post('shops/:shopId/aftersale/:id/cancel')
  @UseGuards(DemoSessionGuard)
  async buyerCancel(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('id') id: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    return { request: aftersaleView(await this.aftersale.buyerCancelReturn(buyerOf(p, shopId), id, this.rid(req))) };
  }

  @Post('shops/:shopId/aftersale/:id/ship-back')
  @UseGuards(DemoSessionGuard)
  async shipBack(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('id') id: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    return { request: aftersaleView(await this.aftersale.buyerShipBack(buyerOf(p, shopId), id, this.rid(req))) };
  }

  @Post('shops/:shopId/aftersale/:id/approve')
  @UseGuards(DemoSessionGuard)
  async approve(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('id') id: string, @Body(new ZodPipe(Approve)) body: z.infer<typeof Approve>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const existing = await this.aftersale.byExternal(shopId, id);
    const r = existing.kind === 'CANCELLATION' ? await this.aftersale.approveCancellation(shopId, id, 'SELLER', this.rid(req)) : await this.aftersale.approveReturn(shopId, id, body.decision, 'SELLER', { requestId: this.rid(req) });
    return { changed: r.changed, request: aftersaleView(r.request) };
  }

  @Post('shops/:shopId/aftersale/:id/reject')
  @UseGuards(DemoSessionGuard)
  async reject(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('id') id: string, @Body(new ZodPipe(Reject)) body: z.infer<typeof Reject>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const existing = await this.aftersale.byExternal(shopId, id);
    const r =
      existing.kind === 'CANCELLATION'
        ? await this.aftersale.rejectCancellation(shopId, id, { reason: body.reason, comment: body.comment }, 'SELLER', this.rid(req))
        : await this.aftersale.rejectReturn(shopId, id, { reason: body.reason, comment: body.comment, decision: body.decision }, 'SELLER', { requestId: this.rid(req) });
    return { changed: r.changed, request: aftersaleView(r.request) };
  }

  /** Buyer raises arbitration / dispute: transitions arbitration_status to IN_ARBITRATION. */
  @Post('shops/:shopId/aftersale/:id/dispute')
  @UseGuards(DemoSessionGuard)
  async raiseDispute(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('id') id: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const r = await this.aftersale.arbitrate(shopId, id, 'IN_ARBITRATION', p.role === 'BUYER' ? 'BUYER' : 'OPERATOR', { requestId: this.rid(req) });
    return { changed: r.changed, request: aftersaleView(r.request) };
  }

  /** TikTok Admin / Operator arbitrates: transitions to ARBITRATION_WIN or ARBITRATION_LOSS. */
  @Post('shops/:shopId/aftersale/:id/arbitrate')
  @UseGuards(DemoSessionGuard)
  async arbitrate(
    @Req() req: DemoRequest,
    @Param('shopId') shopId: string,
    @Param('id') id: string,
    @Body(new ZodPipe(Arbitrate)) body: z.infer<typeof Arbitrate>,
  ) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const targetStatus = body.decision.includes('WIN') ? 'ARBITRATION_WIN' : 'ARBITRATION_LOSS';
    const r = await this.aftersale.arbitrate(shopId, id, targetStatus, 'OPERATOR', { note: body.note, requestId: this.rid(req) });
    return { changed: r.changed, request: aftersaleView(r.request) };
  }
}
