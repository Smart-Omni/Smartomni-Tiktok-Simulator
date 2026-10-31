import { Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { cancellationItem, recordItem, returnItem } from '../aftersale/aftersale.mapper';
import { AftersaleRow, AftersaleService, ARBITRATION_STATUSES, CANCEL, REJECT_REASONS, RETURN } from '../aftersale/aftersale.service';
import { TiktokFault } from '../common/tiktok-fault';
import { SCOPE_AFTERSALE_READ, SCOPE_AFTERSALE_WRITE } from '../oauth/scopes';
import { OrderRuleError } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseRawQuery } from './signature';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

type Kind = 'RETURN' | 'CANCELLATION';
const SORT_FIELDS = ['create_time', 'update_time'] as const;
type SortField = (typeof SORT_FIELDS)[number];
const RETURN_FILTERS = new Set([
  'arbitration_status',
  'buyer_user_ids',
  'create_time_ge',
  'create_time_lt',
  'locale',
  'order_ids',
  'page_size',
  'page_token',
  'return_ids',
  'return_status',
  'return_types',
  'seller_proposed_return_type',
  'update_time_ge',
  'update_time_lt',
]);
const RETURN_UNSUPPORTED = new Set<string>();
const CANCEL_FILTERS = new Set([
  'buyer_user_ids',
  'cancel_ids',
  'cancel_status',
  'cancel_types',
  'create_time_ge',
  'create_time_lt',
  'locale',
  'order_ids',
  'page_size',
  'page_token',
  'update_time_ge',
  'update_time_lt',
]);
const RETURN_STATUSES = new Set<string>(Object.values(RETURN));
const CANCEL_STATUSES = new Set<string>(Object.values(CANCEL));
const ELIGIBILITY_TYPES = ['CANCEL', 'REFUND', 'RETURN_AND_REFUND', 'EXCHANGE', 'REPLACEMENT'];
const RETURN_APPROVE_FIELDS = new Set(['decision', 'buyer_keep_item', 'partial_refund']);
const REJECT_FIELDS = new Set(['decision', 'reject_reason', 'comment', 'images']);

interface Cursor { k: number; s: number; f: SortField; o: 'ASC' | 'DESC' }
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
function stringList(value: unknown, field: string, allowed?: Set<string>): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const arr = Array.isArray(value) ? value : typeof value === 'string' ? [value] : null;
  if (!arr || arr.length > 100 || arr.some((v) => typeof v !== 'string' || v.length === 0 || v.length > 200)) {
    throw new TiktokFault(400, 'invalid_input', `${field} must be a string or array of up to 100 non-empty strings`);
  }
  if (allowed && arr.some((v) => !allowed.has(v))) {
    throw new TiktokFault(400, 'invalid_input', `${field} contains a value that is not a documented status/type`);
  }
  return arr;
}

const include = {
  lines: { orderBy: [{ externalId: 'asc' }], include: { orderLine: true } },
  order: { include: { buyer: { select: { externalId: true, name: true } } } },
} satisfies Prisma.AftersaleRequestInclude;

/**
 * Returns, cancellations, reject reasons and aftersale eligibility (official OAS shapes: schemas/ops/return.* and cancellation.*).
 * 202602 / 202309 OpenAPI endpoints supported.
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class AftersaleController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AftersaleService) private readonly aftersale: AftersaleService,
  ) {}

  // ---- returns --------------------------------------------------------------------------------------------------

  @Post('return_refund/202602/returns/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_READ)
  async searchReturns202602(@Req() req: TiktokRequest) {
    return this.searchReturns(req);
  }

  @Post('return_refund/202309/returns/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_READ)
  async searchReturns(@Req() req: TiktokRequest) {
    const { rows, next, total, locale } = await this.search(req, 'RETURN');
    const returnOrders = rows.map((r) => returnItem(r, locale));
    return this.envelope(req, {
      next_page_token: next,
      return_orders: returnOrders,
      returns: returnOrders,
      total_count: total,
    });
  }

  @Get('return_refund/202309/returns/:returnId/records')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_READ)
  async records(@Req() req: TiktokRequest, @Param('returnId') returnId: string) {
    const shop = req.tiktok!.shop;
    await this.mustOwn(shop.id, returnId, 'RETURN');
    const rows = await this.aftersale.records(shop.id, returnId);
    return this.envelope(req, { records: rows.map(recordItem) });
  }

  @Post('return_refund/202309/returns/:returnId/approve')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_WRITE)
  async approveReturn(@Req() req: TiktokRequest, @Param('returnId') returnId: string) {
    const shop = req.tiktok!.shop;
    const body = this.body(req, RETURN_APPROVE_FIELDS);
    if (body.buyer_keep_item !== undefined && body.buyer_keep_item !== null) throw new TiktokFault(400, 'invalid_input', 'buyer_keep_item (returnless refund) is not modelled by the simulator');
    if (body.partial_refund !== undefined && body.partial_refund !== null) throw new TiktokFault(400, 'invalid_input', 'partial_refund offers are not modelled by the simulator');
    const decision = this.optionalString(body.decision, 'decision');
    await this.mustOwn(shop.id, returnId, 'RETURN');
    await this.run(() => this.aftersale.approveReturn(shop.id, returnId, decision, 'SELLER', { idempotencyKey: this.idempotencyKey(req), requestId: req.requestId }));
    return this.envelope(req, {});
  }

  @Post('return_refund/202309/returns/:returnId/reject')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_WRITE)
  async rejectReturn(@Req() req: TiktokRequest, @Param('returnId') returnId: string) {
    const shop = req.tiktok!.shop;
    const body = this.body(req, REJECT_FIELDS);
    const reason = this.requiredString(body.reject_reason, 'reject_reason');
    await this.mustOwn(shop.id, returnId, 'RETURN');
    await this.run(() => this.aftersale.rejectReturn(shop.id, returnId, { decision: this.optionalString(body.decision, 'decision'), reason, comment: this.optionalString(body.comment, 'comment') }, 'SELLER', { idempotencyKey: this.idempotencyKey(req), requestId: req.requestId }));
    return this.envelope(req, {});
  }

  @Get('return_refund/202309/reject_reasons')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_READ)
  async rejectReasons(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const id = parseRawQuery(req.originalUrl)!.query.return_or_cancel_id;
    if (!id) throw new TiktokFault(400, 'invalid_input', 'return_or_cancel_id is required');
    await this.mustOwn(shop.id, id);
    return this.envelope(req, { reasons: REJECT_REASONS });
  }

  @Get('return_refund/202602/orders/:orderId/aftersale_eligibility')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_READ)
  async eligibility202602(@Req() req: TiktokRequest, @Param('orderId') orderId: string) {
    return this.eligibility(req, orderId);
  }

  @Get('return_refund/202512/orders/:orderId/aftersale_eligibility')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_READ)
  async eligibility(@Req() req: TiktokRequest, @Param('orderId') orderId: string) {
    const shop = req.tiktok!.shop;
    const q = parseRawQuery(req.originalUrl)!.query;
    if (q.initiate_aftersale_user && !['SELLER', 'BUYER'].includes(q.initiate_aftersale_user)) throw new TiktokFault(400, 'invalid_input', 'initiate_aftersale_user must be SELLER or BUYER');
    const types = q.request_types ? q.request_types.split(',').map((t) => t.trim()).filter(Boolean) : ELIGIBILITY_TYPES;
    if (types.length === 0 || types.some((t) => !ELIGIBILITY_TYPES.includes(t))) throw new TiktokFault(400, 'invalid_input', `request_types must be a comma-separated subset of ${ELIGIBILITY_TYPES.join(', ')}`);
    try {
      return this.envelope(req, {
        request_types: types,
        sku_eligibility: await this.aftersale.eligibility(shop.id, orderId, types),
      });
    } catch (e) {
      if (e instanceof NotFoundException) throw new TiktokFault(404, 'order_not_found', 'order does not exist in this shop');
      throw e;
    }
  }

  // ---- cancellations --------------------------------------------------------------------------------------------

  @Post('return_refund/202309/cancellations/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_READ)
  async searchCancellations(@Req() req: TiktokRequest) {
    const { rows, next, total } = await this.search(req, 'CANCELLATION');
    return this.envelope(req, { next_page_token: next, cancellations: rows.map(cancellationItem), total_count: total });
  }

  @Post('return_refund/202309/cancellations/:cancelId/approve')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_WRITE)
  async approveCancellation(@Req() req: TiktokRequest, @Param('cancelId') cancelId: string) {
    const shop = req.tiktok!.shop;
    await this.mustOwn(shop.id, cancelId, 'CANCELLATION');
    await this.run(() => this.aftersale.approveCancellation(shop.id, cancelId, 'SELLER', req.requestId));
    return this.envelope(req, {});
  }

  @Post('return_refund/202309/cancellations/:cancelId/reject')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_AFTERSALE_WRITE)
  async rejectCancellation(@Req() req: TiktokRequest, @Param('cancelId') cancelId: string) {
    const shop = req.tiktok!.shop;
    const body = this.body(req, new Set(['comment', 'images', 'reject_reason']));
    const reason = this.requiredString(body.reject_reason, 'reject_reason');
    await this.mustOwn(shop.id, cancelId, 'CANCELLATION');
    await this.run(() => this.aftersale.rejectCancellation(shop.id, cancelId, { reason, comment: this.optionalString(body.comment, 'comment') }, 'SELLER', req.requestId));
    return this.envelope(req, {});
  }

  // ---- helpers --------------------------------------------------------------------------------------------------

  private async search(req: TiktokRequest, kind: Kind): Promise<{ rows: AftersaleRow[]; next: string; total: number; locale?: string }> {
    const shop = req.tiktok!.shop;
    const query = parseRawQuery(req.originalUrl)!.query;
    const body = this.body(req, kind === 'RETURN' ? RETURN_FILTERS : CANCEL_FILTERS, kind === 'RETURN' ? RETURN_UNSUPPORTED : undefined);

    // OAS: returns page_size valid range [10-50] (default 10); cancellations [1-50] (default 10)
    const min = kind === 'RETURN' ? 10 : 1;
    const rawPageSize = query.page_size ?? (body.page_size !== undefined ? String(body.page_size) : undefined);
    if (rawPageSize !== undefined && !/^\d{1,3}$/.test(rawPageSize)) throw new TiktokFault(400, 'invalid_input', 'page_size must be an integer');
    const pageSize = rawPageSize === undefined ? 10 : Number(rawPageSize);
    if (pageSize < min || pageSize > 50) throw new TiktokFault(400, 'invalid_input', `page_size must be in [${min}, 50]`);
    const sortField = (query.sort_field ?? (typeof body.sort_field === 'string' ? body.sort_field : 'create_time')) as SortField;
    if (!SORT_FIELDS.includes(sortField)) throw new TiktokFault(400, 'invalid_input', 'sort_field must be create_time or update_time');
    const sortOrder = query.sort_order ?? (typeof body.sort_order === 'string' ? body.sort_order : 'ASC');
    if (sortOrder !== 'ASC' && sortOrder !== 'DESC') throw new TiktokFault(400, 'invalid_input', 'sort_order must be ASC or DESC');
    const rawToken = query.page_token ?? (typeof body.page_token === 'string' ? body.page_token : undefined);
    const cursor = rawToken ? decodeCursor(rawToken) : null;
    if (cursor && (cursor.f !== sortField || cursor.o !== sortOrder)) throw new TiktokFault(400, 'invalid_input', 'page_token was issued for a different sort_field/sort_order');
    const where: Prisma.AftersaleRequestWhereInput = { shopId: shop.id, kind };
    const and: Prisma.AftersaleRequestWhereInput[] = [];
    const ids = stringList(body[kind === 'RETURN' ? 'return_ids' : 'cancel_ids'], kind === 'RETURN' ? 'return_ids' : 'cancel_ids');
    if (ids) where.externalId = { in: ids };
    const orderIds = stringList(body.order_ids, 'order_ids');
    const buyers = stringList(body.buyer_user_ids, 'buyer_user_ids');
    if (orderIds || buyers) where.order = { ...(orderIds ? { externalId: { in: orderIds } } : {}), ...(buyers ? { buyer: { externalId: { in: buyers } } } : {}) };
    const statuses = stringList(body[kind === 'RETURN' ? 'return_status' : 'cancel_status'], kind === 'RETURN' ? 'return_status' : 'cancel_status', kind === 'RETURN' ? RETURN_STATUSES : CANCEL_STATUSES);
    if (statuses) where.status = { in: statuses };
    const types = stringList(body[kind === 'RETURN' ? 'return_types' : 'cancel_types'], kind === 'RETURN' ? 'return_types' : 'cancel_types', kind === 'RETURN' ? new Set(['REFUND', 'RETURN_AND_REFUND', 'EXCHANGE', 'REPLACEMENT']) : new Set(['CANCEL', 'BUYER_CANCEL']));
    if (types) where.type = { in: types };

    // 202602 filters
    if (kind === 'RETURN') {
      const arbStatuses = stringList(body.arbitration_status, 'arbitration_status', new Set(ARBITRATION_STATUSES));
      if (arbStatuses) where.arbitrationStatus = { in: arbStatuses };
      const propTypes = stringList(body.seller_proposed_return_type, 'seller_proposed_return_type', new Set(['REFUND', 'RETURN_AND_REFUND', 'EXCHANGE', 'REPLACEMENT']));
      if (propTypes) where.sellerProposedReturnType = { in: propTypes };
    }

    const cGe = unixSeconds(body.create_time_ge, 'create_time_ge');
    const cLt = unixSeconds(body.create_time_lt, 'create_time_lt');
    const uGe = unixSeconds(body.update_time_ge, 'update_time_ge');
    const uLt = unixSeconds(body.update_time_lt, 'update_time_lt');
    if (cGe || cLt) and.push({ createdAt: { ...(cGe && { gte: cGe }), ...(cLt && { lt: cLt }) } });
    if (uGe || uLt) and.push({ updatedAt: { ...(uGe && { gte: uGe }), ...(uLt && { lt: uLt }) } });
    if (and.length) where.AND = and;

    const keyColumn = sortField === 'create_time' ? 'createdAt' : 'updatedAt';
    const dir = sortOrder === 'ASC' ? 'asc' : 'desc';
    const cmp = sortOrder === 'ASC' ? 'gt' : 'lt';
    const pageWhere: Prisma.AftersaleRequestWhereInput = cursor
      ? { AND: [where, { OR: [{ [keyColumn]: { [cmp]: new Date(cursor.k) } }, { [keyColumn]: new Date(cursor.k), seq: { [cmp]: cursor.s } }] }] }
      : where;
    const [total, rows] = await Promise.all([
      this.prisma.aftersaleRequest.count({ where }),
      this.prisma.aftersaleRequest.findMany({ where: pageWhere, orderBy: [{ [keyColumn]: dir }, { seq: dir }], take: pageSize + 1, include }),
    ]);
    const page = rows.slice(0, pageSize);
    const last = page[page.length - 1];
    const next = rows.length > pageSize && last ? encodeCursor({ k: last[keyColumn].getTime(), s: last.seq, f: sortField, o: sortOrder }) : '';
    const locale = typeof body.locale === 'string' ? body.locale : (query.locale ?? undefined);
    return { rows: page, next, total, locale };
  }

  /** The body as an object; unknown fields are rejected, documented-but-unmodelled ones get a clear refusal. */
  private body(req: TiktokRequest, allowed: Set<string>, unsupported?: Set<string>): Record<string, unknown> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw new TiktokFault(400, 'invalid_input', 'request body must be a JSON object');
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      if (unsupported?.has(k)) throw new TiktokFault(400, 'invalid_input', `the simulator does not implement the "${k}" filter`);
      if (!allowed.has(k)) throw new TiktokFault(400, 'invalid_input', `unknown body field "${k}"`);
    }
    return body;
  }

  private optionalString(v: unknown, field: string): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.length > 500) throw new TiktokFault(400, 'invalid_input', `${field} must be a string (max 500)`);
    return v;
  }

  private requiredString(v: unknown, field: string): string {
    const s = this.optionalString(v, field);
    if (!s) throw new TiktokFault(400, 'invalid_input', `${field} is required`);
    return s;
  }

  private idempotencyKey(req: TiktokRequest): string | undefined {
    const k = parseRawQuery(req.originalUrl)!.query.idempotency_key;
    if (k !== undefined && (k.length === 0 || k.length > 100)) throw new TiktokFault(400, 'invalid_input', 'idempotency_key must be 1-100 characters');
    return k;
  }

  private async mustOwn(shopId: string, externalId: string, kind?: Kind): Promise<void> {
    const found = await this.prisma.aftersaleRequest.findFirst({ where: { shopId, externalId, ...(kind ? { kind } : {}) }, select: { id: true } });
    if (!found) throw new TiktokFault(404, 'aftersale_not_found', 'the return/cancellation does not exist in this shop');
  }

  /** Domain rule errors become test faults in the TikTok envelope (the codes are simulator-defined, TikTok's are undocumented). */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof OrderRuleError) {
        const kind = e.code === 'invalid_decision' ? 'invalid_decision' : 'invalid_input';
        throw new TiktokFault(400, kind, e.message);
      }
      throw e;
    }
  }

  private envelope(req: TiktokRequest, data: unknown) {
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data };
  }
}
