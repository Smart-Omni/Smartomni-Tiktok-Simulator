import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TiktokFault } from '../common/tiktok-fault';
import { SCOPE_ORDER_READ } from '../oauth/scopes';
import { ORDER_STATUSES } from '../orders/order-state';
import { orderItem, OrderWithLines } from '../orders/order.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { parseRawQuery } from './signature';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

const SORT_FIELDS = ['create_time', 'update_time'] as const;
type SortField = (typeof SORT_FIELDS)[number];
const SUPPORTED_FILTERS = new Set(['order_status', 'buyer_user_id', 'create_time_ge', 'create_time_lt', 'update_time_ge', 'update_time_lt', 'is_buyer_request_cancel', 'warehouse_ids']);
const KNOWN_UNSUPPORTED_FILTERS = new Set(['shipping_type']);
const MAX_DETAIL_IDS = 50;

interface Cursor {
  /** sort key (epoch ms) and the immutable `seq` tiebreaker of the last row returned */
  k: number;
  s: number;
  f: SortField;
  o: 'ASC' | 'DESC';
}
const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (Number.isSafeInteger(c.k) && Number.isSafeInteger(c.s) && (c.f === 'create_time' || c.f === 'update_time') && (c.o === 'ASC' || c.o === 'DESC')) return c as Cursor;
  } catch {
    /* fall through */
  }
  throw new TiktokFault(400, 'invalid_input', 'page_token is not a token issued by this API');
}
function unixSeconds(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new TiktokFault(400, 'invalid_input', `${field} must be a Unix timestamp (integer seconds)`);
  return new Date(value * 1000);
}

const orderInclude = { lines: { orderBy: [{ externalId: 'asc' }] }, buyer: { select: { externalId: true, name: true } } } satisfies Prisma.OrderInclude;

/**
 * Get Order List (POST /order/202309/orders/search) and Get Order Detail (GET /order/202507/orders).
 * Shapes follow the official OAS (schemas/ops/order.*); transition rules, error codes and unit semantics of filters are the simulator's model (unverified).
 * Time filters: `*_ge` is inclusive and `*_lt` exclusive, as the OAS names say. The search page cursor is a keyset over (sort key, seq),
 * so rows changing while a crawl is in flight never cause a skipped or repeated row inside the same ordering.
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class OrdersController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Post('order/202309/orders/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_ORDER_READ)
  async search(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const query = parseRawQuery(req.originalUrl)!.query;
    if (!/^\d{1,4}$/.test(query.page_size ?? '')) throw new TiktokFault(400, 'invalid_input', 'page_size is required and must be an integer in [1, 100]');
    const pageSize = Number(query.page_size);
    if (pageSize < 1 || pageSize > 100) throw new TiktokFault(400, 'invalid_input', 'page_size must be in [1, 100]');
    const sortField = (query.sort_field ?? 'create_time') as SortField;
    if (!SORT_FIELDS.includes(sortField)) throw new TiktokFault(400, 'invalid_input', 'sort_field must be create_time or update_time');
    const sortOrder = query.sort_order ?? 'DESC';
    if (sortOrder !== 'ASC' && sortOrder !== 'DESC') throw new TiktokFault(400, 'invalid_input', 'sort_order must be ASC or DESC');
    const cursor = query.page_token ? decodeCursor(query.page_token) : null;
    if (cursor && (cursor.f !== sortField || cursor.o !== sortOrder)) throw new TiktokFault(400, 'invalid_input', 'page_token was issued for a different sort_field/sort_order');

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw new TiktokFault(400, 'invalid_input', 'request body must be a JSON object');
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      if (KNOWN_UNSUPPORTED_FILTERS.has(k)) throw new TiktokFault(400, 'invalid_input', `the simulator does not implement the "${k}" filter`);
      if (!SUPPORTED_FILTERS.has(k)) throw new TiktokFault(400, 'invalid_input', `unknown body field "${k}"`);
    }
    const where: Prisma.OrderWhereInput = { shopId: shop.id };
    if (body.order_status !== undefined && body.order_status !== null) {
      if (typeof body.order_status !== 'string' || !(ORDER_STATUSES as readonly string[]).includes(body.order_status)) throw new TiktokFault(400, 'invalid_input', 'order_status is not a documented order status');
      where.status = body.order_status;
    }
    if (body.buyer_user_id !== undefined && body.buyer_user_id !== null) {
      if (typeof body.buyer_user_id !== 'string') throw new TiktokFault(400, 'invalid_input', 'buyer_user_id must be a string');
      where.buyer = { externalId: body.buyer_user_id };
    }
    if (body.is_buyer_request_cancel !== undefined && body.is_buyer_request_cancel !== null) {
      if (typeof body.is_buyer_request_cancel !== 'boolean') throw new TiktokFault(400, 'invalid_input', 'is_buyer_request_cancel must be a boolean');
      where.buyerRequestedCancel = body.is_buyer_request_cancel;
    }
    const shopWarehouses = await this.prisma.warehouse.findMany({ where: { shopId: shop.id }, select: { id: true, externalId: true } });
    if (body.warehouse_ids !== undefined && body.warehouse_ids !== null) {
      const ids = body.warehouse_ids;
      if (!Array.isArray(ids) || ids.length > 100 || ids.some((i) => typeof i !== 'string')) throw new TiktokFault(400, 'invalid_input', 'warehouse_ids must be an array of up to 100 strings');
      where.warehouseId = { in: shopWarehouses.filter((w) => (ids as string[]).includes(w.externalId)).map((w) => w.id) };
    }
    const createGe = unixSeconds(body.create_time_ge, 'create_time_ge');
    const createLt = unixSeconds(body.create_time_lt, 'create_time_lt');
    const updateGe = unixSeconds(body.update_time_ge, 'update_time_ge');
    const updateLt = unixSeconds(body.update_time_lt, 'update_time_lt');
    const and: Prisma.OrderWhereInput[] = [];
    if (createGe || createLt) and.push({ createdAt: { ...(createGe && { gte: createGe }), ...(createLt && { lt: createLt }) } });
    if (updateGe || updateLt) and.push({ updatedAt: { ...(updateGe && { gte: updateGe }), ...(updateLt && { lt: updateLt }) } });
    if (and.length) where.AND = and;

    const keyColumn = sortField === 'create_time' ? 'createdAt' : 'updatedAt';
    const dir = sortOrder === 'ASC' ? 'asc' : 'desc';
    const cmp = sortOrder === 'ASC' ? 'gt' : 'lt';
    const pageWhere: Prisma.OrderWhereInput = cursor
      ? { AND: [where, { OR: [{ [keyColumn]: { [cmp]: new Date(cursor.k) } }, { [keyColumn]: new Date(cursor.k), seq: { [cmp]: cursor.s } }] }] }
      : where;
    const [totalCount, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({ where: pageWhere, orderBy: [{ [keyColumn]: dir }, { seq: dir }], take: pageSize + 1, include: orderInclude }),
    ]);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const next = rows.length > pageSize && last ? encodeCursor({ k: last[keyColumn].getTime(), s: last.seq, f: sortField, o: sortOrder }) : '';
    return this.envelope(req, { next_page_token: next, orders: page.map((o) => this.item(o, shopWarehouses)), total_count: totalCount });
  }

  /** `ids` is a comma-separated list (max 50). Unknown ids and ids of other shops are simply absent from the result (unverified behaviour). */
  @Get('order/202507/orders')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_ORDER_READ)
  async detail(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const raw = parseRawQuery(req.originalUrl)!.query.ids;
    if (!raw) throw new TiktokFault(400, 'invalid_input', 'ids is required');
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > MAX_DETAIL_IDS) throw new TiktokFault(400, 'invalid_input', `ids must contain 1 to ${MAX_DETAIL_IDS} order ids`);
    const [rows, shopWarehouses] = await Promise.all([
      this.prisma.order.findMany({ where: { shopId: shop.id, externalId: { in: ids } }, orderBy: { seq: 'asc' }, include: orderInclude }),
      this.prisma.warehouse.findMany({ where: { shopId: shop.id }, select: { id: true, externalId: true } }),
    ]);
    return this.envelope(req, { orders: rows.map((o) => this.item(o, shopWarehouses)) });
  }

  /**
   * GET /order/202407/orders/{order_id}/price_detail. Pure read of the stored price columns (strings, VND). The order shipping fee is shared
   * over the lines (remainder to the earlier lines); tax, COD and distance fees are 0 for VN domestic orders (DECISIONS DA-11).
   */
  @Get('order/202407/orders/:orderId/price_detail')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_ORDER_READ)
  async priceDetail(@Req() req: TiktokRequest, @Param('orderId') orderId: string) {
    const shop = req.tiktok!.shop;
    const o = await this.prisma.order.findFirst({ where: { shopId: shop.id, externalId: orderId }, include: { lines: { orderBy: [{ externalId: 'asc' }] } } });
    if (!o) throw new TiktokFault(404, 'order_not_found', 'order does not exist in this shop');
    const n = o.lines.length || 1;
    const share = (total: number, i: number): number => Math.floor(total / n) + (i < total % n ? 1 : 0);
    const s = (v: number): string => String(v);
    const money = (list: number, sellerDed: number, platformDed: number, shipList: number, shipSeller: number) => {
      const skuSale = list - sellerDed - platformDed;
      const shipSale = shipList - shipSeller;
      return {
        sku_list_price: s(list),
        sku_sale_price: s(skuSale),
        sku_gift_original_price: '0',
        sku_gift_net_price: '0',
        subtotal_deduction_seller: s(sellerDed),
        subtotal_deduction_platform: s(platformDed),
        subtotal_tax_amount: '0',
        subtotal: s(skuSale),
        voucher_deduction_seller: '0',
        voucher_deduction_platform: '0',
        shipping_list_price: s(shipList),
        shipping_fee_deduction_seller: s(shipSeller),
        shipping_fee_deduction_platform: '0',
        shipping_fee_deduction_platform_voucher: '0',
        shipping_sale_price: s(shipSale),
        tax_amount: '0',
        tax_rate: '0',
        net_price_amount: s(skuSale),
        cod_fee: '0',
        distance_fee: '0',
        distance_shipping_fee: '0',
        payment: s(skuSale + shipSale),
        total: s(list + shipList),
      };
    };
    return this.envelope(req, {
      currency: o.currency,
      ...money(o.originalProductPrice, o.sellerDiscount, o.platformDiscount, o.originalShippingFee, o.shippingFeeDiscount),
      cod_fee_net_amount: '0',
      line_items: o.lines.map((l, i) => ({
        id: l.externalId,
        currency: o.currency,
        ...money(l.originalPrice, l.sellerDiscount, l.platformDiscount, share(o.originalShippingFee, i), share(o.shippingFeeDiscount, i)),
        cod_fee_amount: '0',
      })),
    });
  }

  private item(o: Omit<OrderWithLines, 'warehouse'>, warehouses: { id: string; externalId: string }[]) {
    const w = warehouses.find((x) => x.id === o.warehouseId);
    return orderItem({ ...o, warehouse: w ? { externalId: w.externalId } : null });
  }

  private envelope(req: TiktokRequest, data: unknown) {
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data };
  }
}
