import { BadRequestException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { TiktokFault } from '../common/tiktok-fault';
import { DOC_TYPES, DocType, FulfillmentService } from '../fulfillment/fulfillment.service';
import { OrderRuleError } from '../orders/orders.service';
import { SCOPE_FULFILLMENT_READ, SCOPE_FULFILLMENT_WRITE } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { parseRawQuery } from './signature';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

const SHIP_BODY_FIELDS = new Set(['handover_method', 'pickup_slot', 'self_shipment']);
const SEARCH_BODY_FIELDS = new Set(['create_time_ge', 'create_time_lt', 'update_time_ge', 'update_time_lt', 'package_status']);
const PACKAGE_STATUSES = new Set(['TO_FULFILL', 'PROCESSING', 'FULFILLING', 'COMPLETED', 'CANCELLED']);
const HANDOVER = new Set(['PICKUP', 'DROP_OFF']);
const sec = (d: Date): number => Math.floor(d.getTime() / 1000);

/**
 * Fulfillment reads and the ship-package write (official OAS shapes: schemas/ops/fulfillment.*).
 * Every lookup is scoped to the shop of the token; an order/package of another shop is exactly as unknown as a nonexistent one.
 * The document URL points at a /demo/files route (not part of this router) so it is downloadable from the host and from Docker.
 * Unverified: error codes, the 24 h document validity (not enforced), and the package status before shipment is arranged.
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class FulfillmentController {
  constructor(
    @Inject(FulfillmentService) private readonly fulfillment: FulfillmentService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  @Get('fulfillment/202309/orders/:orderId/tracking')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_FULFILLMENT_READ)
  async tracking(@Req() req: TiktokRequest, @Param('orderId') orderId: string) {
    const shop = req.tiktok!.shop;
    const events = await this.guarded(() => this.fulfillment.trackingOf(shop.id, orderId), 'order_not_found', 'order does not exist in this shop');
    return this.envelope(req, { tracking: events.map((e) => ({ description: e.description, update_time_millis: e.at.getTime() })) });
  }

  @Get('fulfillment/202309/packages/:packageId/shipping_documents')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_FULFILLMENT_READ)
  async documents(@Req() req: TiktokRequest, @Param('packageId') packageId: string) {
    const shop = req.tiktok!.shop;
    const q = parseRawQuery(req.originalUrl)!.query;
    if (!q.document_type) throw new TiktokFault(400, 'invalid_input', 'document_type is required');
    if (!(DOC_TYPES as readonly string[]).includes(q.document_type)) {
      throw new TiktokFault(400, 'invalid_input', `document_type ${q.document_type} is not supported by the simulator (supported: ${DOC_TYPES.join(', ')})`);
    }
    if (q.document_format && q.document_format !== 'PDF') throw new TiktokFault(400, 'invalid_input', 'only document_format PDF is supported');
    if (q.document_size && !['A6', 'A5'].includes(q.document_size)) throw new TiktokFault(400, 'invalid_input', 'document_size must be A6 or A5 (the simulator always renders its own size)');
    await this.guarded(() => this.fulfillment.packageOf(shop.id, packageId), 'package_not_found', 'package does not exist in this shop');
    try {
      const doc = await this.fulfillment.documentFor(shop.id, packageId, q.document_type as DocType);
      return this.envelope(req, { doc_url: this.fulfillment.documentUrl(doc.token), tracking_number: doc.trackingNumber });
    } catch (e) {
      if (e instanceof OrderRuleError && e.code === 'package_not_arranged') throw new TiktokFault(400, 'package_not_arranged', e.message);
      throw e;
    }
  }

  @Get('fulfillment/202309/packages/:packageId')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_FULFILLMENT_READ)
  async detail(@Req() req: TiktokRequest, @Param('packageId') packageId: string) {
    const shop = req.tiktok!.shop;
    const pkg = await this.guarded(() => this.fulfillment.packageOf(shop.id, packageId), 'package_not_found', 'package does not exist in this shop');
    const o = pkg.order;
    const warehouse = o.warehouseId ? await this.prisma.warehouse.findUnique({ where: { id: o.warehouseId } }) : null;
    const lines = await this.prisma.packageLine.findMany({ where: { packageId: pkg.id }, select: { orderLineId: true } });
    const lineIds = new Map(o.lines.map((l) => [l.id, l.externalId]));
    return this.envelope(req, {
      package_id: pkg.externalId,
      package_status: pkg.status,
      create_time: sec(pkg.createdAt),
      update_time: sec(pkg.updatedAt),
      tracking_number: pkg.trackingNumber ?? undefined,
      shipping_provider_id: pkg.shippingProviderId,
      shipping_provider_name: pkg.shippingProviderName,
      shipping_type: 'TIKTOK',
      handover_method: pkg.handoverMethod ?? undefined,
      has_multi_skus: new Set(o.lines.map((l) => l.skuExternalId)).size > 1,
      split_and_combine_tag: 'DEFAULT',
      note_tag: o.buyerMessage ? 'BUYER_NOTED' : 'BUYER_UNNOTED',
      order_line_item_ids: lines.map((l) => lineIds.get(l.orderLineId)).filter((id): id is string => !!id),
      orders: [{ id: o.externalId }],
      recipient_address: {
        name: o.recipientName,
        phone_number: o.recipientPhone,
        address_detail: o.addressLine,
        address_line1: o.addressLine,
        full_address: `${o.addressLine}, ${o.district}, ${o.city}`,
        postal_code: o.postalCode,
        region_code: 'VN',
      },
      sender_address: warehouse ? { name: warehouse.name, full_address: `${warehouse.name}, ${warehouse.city}`, address_detail: warehouse.city, region_code: 'VN' } : undefined,
    });
  }

  /** POST /fulfillment/202309/packages/search: keyset pagination on (time, id). */
  @Post('fulfillment/202309/packages/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_FULFILLMENT_READ)
  async search(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const q = parseRawQuery(req.originalUrl)!.query;
    if (!/^[0-9]{1,3}$/.test(q.page_size ?? '') || Number(q.page_size) < 1 || Number(q.page_size) > 50) throw new TiktokFault(400, 'invalid_input', 'page_size is required and must be an integer in [1, 50]');
    const pageSize = Number(q.page_size);
    const sortField = q.sort_field ?? 'create_time';
    const sortOrder = q.sort_order ?? 'DESC';
    if (sortField !== 'create_time' && sortField !== 'update_time') throw new TiktokFault(400, 'invalid_input', 'sort_field must be create_time or update_time');
    if (sortOrder !== 'ASC' && sortOrder !== 'DESC') throw new TiktokFault(400, 'invalid_input', 'sort_order must be ASC or DESC');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw new TiktokFault(400, 'invalid_input', 'request body must be a JSON object');
    for (const k of Object.keys(body)) if (!SEARCH_BODY_FIELDS.has(k)) throw new TiktokFault(400, 'invalid_input', `unknown body field "${k}"`);
    const time = (v: unknown, f: string): Date | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new TiktokFault(400, 'invalid_input', `${f} must be a Unix timestamp (integer seconds)`);
      return new Date(v * 1000);
    };
    if (body.package_status !== undefined && (typeof body.package_status !== 'string' || !PACKAGE_STATUSES.has(body.package_status))) throw new TiktokFault(400, 'invalid_input', 'package_status is not a package status');
    const key = sortField === 'create_time' ? 'createdAt' : 'updatedAt';
    const cGe = time(body.create_time_ge, 'create_time_ge');
    const cLt = time(body.create_time_lt, 'create_time_lt');
    const uGe = time(body.update_time_ge, 'update_time_ge');
    const uLt = time(body.update_time_lt, 'update_time_lt');
    const where = {
      shopId: shop.id,
      ...(body.package_status ? { status: body.package_status as string } : {}),
      ...(cGe || cLt ? { createdAt: { ...(cGe && { gte: cGe }), ...(cLt && { lt: cLt }) } } : {}),
      ...(uGe || uLt ? { updatedAt: { ...(uGe && { gte: uGe }), ...(uLt && { lt: uLt }) } } : {}),
    };
    let cursor: { k: number; i: string; f: string; o: string } | null = null;
    if (q.page_token) {
      try {
        const c = JSON.parse(Buffer.from(q.page_token, 'base64url').toString('utf8'));
        if (Number.isSafeInteger(c.k) && typeof c.i === 'string' && c.f === sortField && c.o === sortOrder) cursor = c;
      } catch {
        /* fall through */
      }
      if (!cursor) throw new TiktokFault(400, 'invalid_input', 'page_token is not a token issued by this API for this sort');
    }
    const cmp = sortOrder === 'ASC' ? 'gt' : 'lt';
    const dir = sortOrder === 'ASC' ? 'asc' : 'desc';
    const pageWhere = cursor ? { AND: [where, { OR: [{ [key]: { [cmp]: new Date(cursor.k) } }, { [key]: new Date(cursor.k), id: { [cmp]: cursor.i } }] }] } : where;
    const [total, rows] = await Promise.all([
      this.prisma.package.count({ where }),
      this.prisma.package.findMany({ where: pageWhere, orderBy: [{ [key]: dir }, { id: dir }], take: pageSize + 1, include: { lines: true, order: { select: { externalId: true, lines: { select: { id: true, externalId: true } } } } } }),
    ]);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const next = rows.length > pageSize && last ? Buffer.from(JSON.stringify({ k: last[key].getTime(), i: last.id, f: sortField, o: sortOrder }), 'utf8').toString('base64url') : '';
    return this.envelope(req, {
      next_page_token: next,
      total_count: total,
      packages: page.map((pkg) => {
        const lineIds = new Map(pkg.order.lines.map((l) => [l.id, l.externalId]));
        return {
          id: pkg.externalId,
          status: pkg.status,
          tracking_number: pkg.trackingNumber ?? undefined,
          shipping_provider_id: pkg.shippingProviderId,
          shipping_provider_name: pkg.shippingProviderName,
          create_time: sec(pkg.createdAt),
          update_time: sec(pkg.updatedAt),
          order_line_item_ids: pkg.lines.map((l) => lineIds.get(l.orderLineId)).filter((id): id is string => !!id),
          orders: [{ id: pkg.order.externalId }],
        };
      }),
    });
  }

  /** POST /fulfillment/202309/packages/ship: one transaction per package, failures are listed and never block the others. */
  @Post('fulfillment/202309/packages/ship')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_FULFILLMENT_WRITE)
  async batchShip(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const body = (req.body ?? {}) as { packages?: unknown };
    if (!Array.isArray(body.packages) || body.packages.length === 0 || body.packages.length > 50) throw new TiktokFault(400, 'invalid_input', 'packages must be an array of 1-50 items');
    // validate the whole array first: a 400 must never follow packages that were already shipped
    for (const raw of body.packages as Array<Record<string, unknown>>) {
      if (typeof raw?.id !== 'string' || raw.id.length === 0) throw new TiktokFault(400, 'invalid_input', 'every package needs an id');
    }
    const errors: Array<{ code: number; message: string; detail: { package_id: string } }> = [];
    for (const raw of body.packages as Array<Record<string, unknown>>) {
      const id = raw.id as string;
      const fail = (message: string) => errors.push({ code: -1, message, detail: { package_id: id } });
      if (raw.handover_method !== undefined && (typeof raw.handover_method !== 'string' || !HANDOVER.has(raw.handover_method))) {
        fail('handover_method must be PICKUP or DROP_OFF');
        continue;
      }
      if (raw.self_shipment !== undefined) {
        fail('self_shipment is not supported: the simulator only models platform (TIKTOK) shipping');
        continue;
      }
      try {
        const pkg = await this.fulfillment.packageOf(shop.id, id);
        await this.fulfillment.arrangeShipment(shop.id, pkg.order.externalId, 'SELLER', req.requestId, raw.handover_method as string | undefined);
      } catch (e) {
        if (e instanceof NotFoundException) fail('package does not exist in this shop');
        else if (e instanceof OrderRuleError) fail(`${e.code}: ${e.message}`);
        else throw e;
      }
    }
    return this.envelope(req, { errors });
  }

  /** Ship package. Only an arranged-able package of an order in AWAITING_SHIPMENT; a repeat on an already arranged package succeeds without a second package. */
  @Post('fulfillment/202309/packages/:packageId/ship')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_FULFILLMENT_WRITE)
  async ship(@Req() req: TiktokRequest, @Param('packageId') packageId: string) {
    const shop = req.tiktok!.shop;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw new TiktokFault(400, 'invalid_input', 'request body must be a JSON object');
    for (const k of Object.keys(body)) if (!SHIP_BODY_FIELDS.has(k)) throw new TiktokFault(400, 'invalid_input', `unknown body field "${k}"`);
    if (body.handover_method !== undefined && (typeof body.handover_method !== 'string' || !HANDOVER.has(body.handover_method))) throw new TiktokFault(400, 'invalid_input', 'handover_method must be PICKUP or DROP_OFF');
    if (body.self_shipment !== undefined) throw new TiktokFault(400, 'invalid_input', 'self_shipment is not supported: the simulator only models platform (TIKTOK) shipping');
    const pkg = await this.guarded(() => this.fulfillment.packageOf(shop.id, packageId), 'package_not_found', 'package does not exist in this shop');
    try {
      await this.fulfillment.arrangeShipment(shop.id, pkg.order.externalId, 'SELLER', req.requestId, body.handover_method as string | undefined);
    } catch (e) {
      if (e instanceof OrderRuleError) throw new TiktokFault(400, 'order_not_shippable', `${e.code}: ${e.message}`);
      throw e;
    }
    return this.envelope(req, {});
  }

  private async guarded<T>(fn: () => Promise<T>, kind: 'order_not_found' | 'package_not_found', message: string): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NotFoundException) throw new TiktokFault(404, kind, message);
      if (e instanceof BadRequestException) throw e;
      throw e;
    }
  }

  private envelope(req: TiktokRequest, data: unknown) {
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data };
  }
}
