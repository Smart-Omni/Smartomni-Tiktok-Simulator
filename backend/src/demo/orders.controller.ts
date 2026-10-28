import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AftersaleService } from '../aftersale/aftersale.service';
import { ZodPipe } from '../common/zod.pipe';
import { OrderRow, OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertSellerShop,
  assertShopAccess,
  DemoPrincipal,
  DemoRequest,
  DemoSessionGuard,
} from './demo-session.guard';

const CartItemBody = z.object({ skuId: z.string().min(1).max(100), quantity: z.number().int().min(0).max(20) });
const Recipient = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(30),
  addressLine: z.string().trim().min(1).max(300),
  district: z.string().trim().min(1).max(100),
  city: z.string().trim().min(1).max(100),
  postalCode: z.string().max(20).optional(),
});
const CheckoutBody = z.object({
  /** Client-generated idempotency key: submitting the same key twice returns the same order. */
  checkoutKey: z.string().trim().min(8).max(100),
  items: z.array(z.object({ skuId: z.string().min(1).max(100), quantity: z.number().int().min(1).max(20) })).max(50).optional(),
  recipient: Recipient.optional(),
  buyerMessage: z.string().max(500).optional(),
  couponCode: z.string().trim().min(1).max(20).optional(),
});
const ReasonBody = z.object({ reason: z.string().trim().min(1).max(300).default('no reason given') });

function principal(req: DemoRequest): DemoPrincipal {
  return req.demo!;
}

function buyerOf(p: DemoPrincipal, shopId?: string): { id: string; shopId: string } {
  if (p.role !== 'BUYER' || !p.buyerId) throw new ForbiddenException('Only a buyer session can do this');
  return { id: p.buyerId, shopId: shopId ?? p.shopId };
}

/** What the demo UIs see: integer VND components, lines grouped per SKU with a quantity. */
export function orderView(o: OrderRow) {
  const bySku = new Map<string, { skuId: string; productId: string; productName: string; skuName: string; sellerSku: string; unitPriceVnd: number; quantity: number }>();
  for (const l of o.lines) {
    const row = bySku.get(l.skuExternalId) ?? { skuId: l.skuExternalId, productId: l.productExternalId, productName: l.productName, skuName: l.skuName, sellerSku: l.sellerSku, unitPriceVnd: l.salePrice, quantity: 0 };
    row.quantity += 1;
    bySku.set(l.skuExternalId, row);
  }
  const subTotal = o.originalProductPrice - o.sellerDiscount - o.platformDiscount;
  const shippingFee = o.originalShippingFee - o.shippingFeeDiscount;
  return {
    id: o.externalId,
    shopId: o.shopId,
    ...(o.shop ? { shop: { id: o.shop.id, name: o.shop.name } } : {}),
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    paidAt: o.paidAt?.toISOString() ?? null,
    releaseAt: o.releaseAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    buyerRequestedCancel: o.buyerRequestedCancel,
    recipient: { name: o.recipientName, phone: o.recipientPhone, addressLine: o.addressLine, district: o.district, city: o.city },
    buyer: { id: o.buyer.externalId, name: o.buyer.name },
    amounts: {
      currency: o.currency,
      productTotalVnd: o.originalProductPrice,
      sellerDiscountVnd: o.sellerDiscount,
      platformDiscountVnd: o.platformDiscount,
      subTotalVnd: subTotal,
      shippingFeeVnd: shippingFee,
      taxVnd: o.tax,
      totalVnd: subTotal + shippingFee + o.tax,
    },
    items: [...bySku.values()],
  };
}

/** Buyer cart / checkout / fake payment / order history and the Seller order list. /demo only: none of this is TikTok OpenAPI. */
@Controller()
export class OrdersDemoController {
  constructor(
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AftersaleService) private readonly aftersale: AftersaleService,
  ) {}

  // ---- Marketplace Buyer Cart & Orders ------------------------------------------------------------------------

  @Get('cart')
  @UseGuards(DemoSessionGuard)
  async marketplaceCart(@Req() req: DemoRequest) {
    const p = principal(req);
    const buyer = buyerOf(p);
    const cartItems = await this.prisma.cartItem.findMany({
      where: { buyerId: buyer.id },
      include: {
        sku: {
          include: {
            product: {
              include: {
                shop: { select: { id: true, name: true, status: true } },
              },
            },
            inventory: true,
          },
        },
      },
      orderBy: { updatedAt: 'asc' },
    });

    const shopMap = new Map<string, { shop: { id: string; name: string }; items: any[]; shopTotalVnd: number }>();
    let totalVnd = 0;
    let itemCount = 0;

    for (const item of cartItems) {
      const shop = item.sku.product.shop;
      if (shop.status !== 'ACTIVE') continue;

      const lineTotalVnd = item.sku.priceVnd * item.quantity;
      totalVnd += lineTotalVnd;
      itemCount += item.quantity;

      const formattedItem = {
        skuId: item.sku.externalId,
        productId: item.sku.product.externalId,
        productTitle: item.sku.product.title,
        skuName: item.sku.name,
        sellerSku: item.sku.sellerSku,
        quantity: item.quantity,
        unitPriceVnd: item.sku.priceVnd,
        lineTotalVnd,
        available:
          item.sku.product.status === 'ACTIVATE' &&
          !item.sku.product.isNotForSale &&
          item.sku.status === 'NORMAL' &&
          item.sku.inventory.reduce((n, l) => n + l.quantity, 0) >= item.quantity,
      };

      let group = shopMap.get(shop.id);
      if (!group) {
        group = { shop: { id: shop.id, name: shop.name }, items: [], shopTotalVnd: 0 };
        shopMap.set(shop.id, group);
      }
      group.items.push(formattedItem);
      group.shopTotalVnd += lineTotalVnd;
    }

    return {
      currency: 'VND',
      shops: [...shopMap.values()],
      totalVnd,
      itemCount,
    };
  }

  @Get('buyer/orders')
  @UseGuards(DemoSessionGuard)
  async marketplaceBuyerOrders(@Req() req: DemoRequest) {
    const p = principal(req);
    const buyer = buyerOf(p);
    const rows = await this.orders.listForBuyer(buyer.id);
    return { items: rows.map(orderView) };
  }

  // ---- Shop-Scoped Cart & Orders -----------------------------------------------------------------------------

  @Get('shops/:shopId/cart')
  @UseGuards(DemoSessionGuard)
  async cart(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const items = await this.orders.cart(buyerOf(p, shopId).id, shopId);
    return { currency: 'VND', items, totalVnd: items.reduce((n, i) => n + i.lineTotalVnd, 0) };
  }

  @Put('shops/:shopId/cart/items')
  @UseGuards(DemoSessionGuard)
  async setCartItem(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CartItemBody)) body: z.infer<typeof CartItemBody>) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    await this.orders.setCartItem(buyerOf(p, shopId), body.skuId, body.quantity);
    return this.cart(req, shopId);
  }

  @Post('shops/:shopId/checkout')
  @UseGuards(DemoSessionGuard)
  async checkout(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CheckoutBody)) body: z.infer<typeof CheckoutBody>) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const buyer = buyerOf(p, shopId);
    const fromCart = !body.items;
    const items = body.items
      ? body.items.map((i) => ({ skuExternalId: i.skuId, quantity: i.quantity }))
      : (await this.orders.cart(buyer.id, shopId)).map((i) => ({ skuExternalId: i.skuId, quantity: i.quantity }));
    const row = await this.prisma.buyer.findUniqueOrThrow({ where: { id: buyer.id } });
    const recipient = body.recipient ?? { name: row.name, phone: row.phone, addressLine: row.addressLine, district: row.district, city: row.city };
    const { order, replayed } = await this.orders.checkout(buyer, { checkoutKey: body.checkoutKey, items, recipient, buyerMessage: body.buyerMessage, couponCode: body.couponCode }, (req as { requestId?: string }).requestId);
    if (fromCart && !replayed) {
      await this.prisma.cartItem.deleteMany({
        where: {
          buyerId: buyer.id,
          sku: { shopId: buyer.shopId },
        },
      });
    }
    return { replayed, order: orderView(order) };
  }

  @Post('shops/:shopId/orders/:orderId/pay')
  @UseGuards(DemoSessionGuard)
  async pay(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('orderId') orderId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const { order, replayed } = await this.orders.pay(buyerOf(p, shopId), orderId, (req as { requestId?: string }).requestId);
    return { replayed, order: orderView(order) };
  }

  @Post('shops/:shopId/orders/:orderId/cancel')
  @UseGuards(DemoSessionGuard)
  async cancel(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('orderId') orderId: string, @Body(new ZodPipe(ReasonBody)) body: z.infer<typeof ReasonBody>) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    if (p.role === 'BUYER') {
      const rid = (req as { requestId?: string }).requestId;
      const row = await this.prisma.order.findFirst({ where: { buyerId: buyerOf(p, shopId).id, shopId, externalId: orderId }, select: { id: true, status: true } });
      // Phase 07b: once the order is paid and released (AWAITING_SHIPMENT) a cancel is a REQUEST the seller must approve, recorded as an aftersale cancellation
      if (row?.status === 'AWAITING_SHIPMENT') await this.aftersale.createCancellation(buyerOf(p, shopId), orderId, body.reason, rid);
      else return { order: orderView(await this.orders.buyerCancel(buyerOf(p, shopId), orderId, body.reason, rid)) };
      const updated = await this.prisma.order.findUniqueOrThrow({
        where: { id: row.id },
        include: {
          lines: { orderBy: [{ externalId: 'asc' }] },
          buyer: { select: { externalId: true, name: true } },
          shop: { select: { id: true, name: true } },
        },
      });
      return { order: orderView(updated) };
    }
    assertSellerShop(p, shopId);
    const order = await this.prisma.order.findFirst({ where: { shopId, externalId: orderId }, select: { id: true } });
    if (!order) throw new NotFoundException('Unknown order');
    const updated = await this.orders.transition(order.id, 'CANCELLED', 'SELLER', { note: body.reason, cancelReason: body.reason, initiator: 'SELLER', requestId: (req as { requestId?: string }).requestId });
    return { order: orderView(updated) };
  }

  /** Buyer: own orders. Seller: every order of the shop. */
  @Get('shops/:shopId/orders')
  @UseGuards(DemoSessionGuard)
  async list(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const rows = p.role === 'BUYER' ? await this.orders.listForBuyer(buyerOf(p, shopId).id, shopId) : await this.orders.listForShop(shopId);
    return { items: rows.map(orderView) };
  }

  @Get('shops/:shopId/orders/:orderId')
  @UseGuards(DemoSessionGuard)
  async detail(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('orderId') orderId: string) {
    const p = principal(req);
    await assertShopAccess(p, shopId, this.prisma);
    const order = await this.prisma.order.findFirst({
      where: { shopId, externalId: orderId, ...(p.role === 'BUYER' ? { buyerId: buyerOf(p, shopId).id } : {}) },
      include: {
        lines: { orderBy: [{ externalId: 'asc' }] },
        buyer: { select: { externalId: true, name: true } },
        shop: { select: { id: true, name: true } },
      },
    });
    if (!order) throw new NotFoundException('Unknown order');
    return { order: orderView(order), history: (await this.orders.audits(order.id)).map((a) => ({ from: a.fromStatus, to: a.toStatus, actor: a.actor, note: a.note, at: a.at.toISOString() })) };
  }
}
