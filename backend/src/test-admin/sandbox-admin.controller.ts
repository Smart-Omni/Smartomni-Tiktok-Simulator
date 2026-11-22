import { Body, Controller, Get, Inject, NotFoundException, Post, Query, Req, UseGuards } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { DELIVERY_OPTIONS, FulfillmentService } from '../fulfillment/fulfillment.service';
import { MAX_UNITS_PER_SKU, OrderRow, OrdersService } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminTokenGuard } from './loyalty-admin.controller';

/** Largest batch one Create Sandbox Order call may place (toolkit `--order-count`; the real limit is unknown, DECISIONS DA-12). */
export const MAX_SANDBOX_ORDER_COUNT = 10;
export const MAX_SANDBOX_PAGE_SIZE = 10;

/**
 * Canonical state names of the toolkit's sandbox commands, derived from the simulator status (DECISIONS DA-12). Only the test-admin
 * view uses this: TO_SHIP / SHIPPED / UNKNOWN are not TikTok order statuses and are never stored.
 */
export function canonicalStatus(o: { status: string; buyerRequestedCancel: boolean }): string {
  return o.status === 'AWAITING_SHIPMENT' && o.buyerRequestedCancel ? 'CANCEL_PENDING' : o.status;
}

/** One happy-path step. The state machine is the simulator's, so every step goes through the same service the apps use. */
export async function advanceOneStep(orders: OrdersService, fulfillment: FulfillmentService, order: OrderRow, requestId?: string): Promise<OrderRow | null> {
  const buyer = { id: order.buyerId, shopId: order.shopId };
  switch (order.status) {
    case 'UNPAID':
      return (await orders.pay(buyer, order.externalId, requestId)).order;
    case 'AWAITING_SHIPMENT':
      await fulfillment.arrangeShipment(order.shopId, order.externalId, 'TEST_CONSOLE', requestId);
      break;
    case 'AWAITING_COLLECTION':
    case 'IN_TRANSIT':
      await fulfillment.advanceShipment(order.shopId, order.externalId, 'TEST_CONSOLE', requestId);
      break;
    case 'DELIVERED':
      return orders.transition(order.id, 'COMPLETED', 'TEST_CONSOLE', { note: 'sandbox: completed', requestId });
    default:
      return null; // COMPLETED, CANCELLED, PARTIALLY_SHIPPING: no happy-path step
  }
  return orders.findForAdmin(order.id, order.shopId);
}

const SandboxProductsQuery = z.object({ shopId: z.string().min(1) });
const SandboxOrderCreate = z.object({
  shopId: z.string().min(1),
  items: z.array(z.object({ product_id: z.string().min(1).optional(), sku_id: z.string().min(1), quantity: z.number().int().min(1).max(MAX_UNITS_PER_SKU) })).min(1).max(20),
  order_count: z.number().int().min(1).max(MAX_SANDBOX_ORDER_COUNT).default(1),
  logistics_service_id: z.string().min(1).max(100).optional(),
  payment_method: z.string().min(1).max(50).optional(),
  pay: z.boolean().default(true),
});

type Rq = Request & { requestId?: string };

/**
 * Test-control counterparts of the toolkit's `sandbox` commands (shop list / product list / order create), see docs/tts-toolkit-alignment.md §2.
 * These are simulator controls under /test-admin, not TikTok routes. Fake data only.
 */
@Controller('sandbox')
@UseGuards(AdminTokenGuard)
export class SandboxAdminController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly orders: OrdersService,
  ) {}

  /** `sandbox product list`: ACTIVATE products with their SKUs and the stock summed over warehouses. */
  @Get('products')
  async products(@Query(new ZodPipe(SandboxProductsQuery)) q: z.infer<typeof SandboxProductsQuery>) {
    const shop = await this.prisma.shop.findUnique({ where: { id: q.shopId } });
    if (!shop) throw new NotFoundException('Unknown shop');
    const rows = await this.prisma.product.findMany({
      where: { shopId: shop.id, status: 'ACTIVATE' },
      orderBy: { externalId: 'asc' },
      take: 200,
      include: { skus: { where: { status: 'NORMAL' }, orderBy: { externalId: 'asc' }, include: { inventory: { select: { quantity: true } } } } },
    });
    return {
      shop_id: shop.tiktokShopId,
      products: rows.filter((p) => p.skus.length > 0).map((p) => ({
        product_id: p.externalId,
        title: p.title,
        sku_list: p.skus.map((s) => ({ id: s.externalId, seller_sku: s.sellerSku, price: s.priceVnd, stock_count: s.inventory.reduce((n, i) => n + i.quantity, 0) })),
      })),
      limits: { max_quantity_per_sku: MAX_UNITS_PER_SKU, max_order_count: MAX_SANDBOX_ORDER_COUNT },
    };
  }

  /**
   * `sandbox order create`: places `order_count` orders through the real checkout (and payment unless pay=false). A batch can be partly
   * created and partly failed; created orders are never rolled back. Every order gets its own checkoutKey.
   */
  @Post('orders')
  async createOrders(@Req() req: Rq, @Body(new ZodPipe(SandboxOrderCreate)) body: z.infer<typeof SandboxOrderCreate>) {
    const shop = await this.prisma.shop.findUnique({ where: { id: body.shopId } });
    if (!shop) throw new NotFoundException('Unknown shop');
    if (body.logistics_service_id && !DELIVERY_OPTIONS.some((o) => o.id === body.logistics_service_id)) {
      return { created: [], failed: [{ index: 0, error: `logistics_service_id must be one of ${DELIVERY_OPTIONS.map((o) => o.id).join(', ')}` }], request_id: req.requestId ?? null };
    }
    const buyer = (await this.prisma.buyer.findFirst({ where: { shopId: shop.id }, orderBy: { createdAt: 'asc' } })) ?? (await this.prisma.buyer.findFirst({ where: { shopId: null }, orderBy: { createdAt: 'asc' } }));
    if (!buyer) throw new NotFoundException('The shop has no buyer to place sandbox orders with');
    const created: { order_id: string; status: string }[] = [];
    const failed: { index: number; error: string }[] = [];
    for (let i = 0; i < body.order_count; i++) {
      try {
        const { order } = await this.orders.checkout(
          { id: buyer.id, shopId: shop.id },
          {
            checkoutKey: `sandbox-${randomUUID()}`,
            items: body.items.map((it) => ({ skuExternalId: it.sku_id, quantity: it.quantity })),
            recipient: { name: buyer.name, phone: buyer.phone, addressLine: buyer.addressLine, district: buyer.district, city: buyer.city },
            buyerMessage: 'sandbox order',
          },
          req.requestId,
        );
        let current = order;
        if (body.payment_method) await this.prisma.order.update({ where: { id: order.id }, data: { paymentMethodName: body.payment_method } });
        if (body.pay) current = (await this.orders.pay({ id: buyer.id, shopId: shop.id }, order.externalId, req.requestId)).order;
        created.push({ order_id: current.externalId, status: current.status });
      } catch (e) {
        failed.push({ index: i, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { created, failed, request_id: req.requestId ?? null };
  }
}
