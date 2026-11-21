import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BusinessClock } from '../clock/clock';
import { TiktokFault } from '../common/tiktok-fault';
import { couponDetail, couponSearchItem } from '../coupons/coupon.mapper';
import { SCOPE_PROMOTION_READ } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { parseRawQuery } from './signature';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

const STATUS_VALUES = ['NOT_START', 'ONGOING', 'EXPIRED', 'DEACTIVATED'] as const;
/** `display_type` values listed in the OAS description (the list there is cut off, so only the five visible values are accepted). */
const DISPLAY_TYPES = new Set(['REGULAR', 'LIVE', 'CREATOR_EXCLUSIVE', 'CHAT', 'PROMO_CODE']);
const SUPPORTED_FILTERS = new Set(['status', 'display_type', 'title_keyword']);

const encodeCursor = (seq: number): string => Buffer.from(JSON.stringify({ seq }), 'utf8').toString('base64url');
function decodeCursor(raw: string): number {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { seq?: unknown };
    if (typeof v.seq === 'number' && Number.isSafeInteger(v.seq) && v.seq >= 0) return v.seq;
  } catch {
    /* fall through */
  }
  throw new TiktokFault(400, 'invalid_input', 'page_token is not a token issued by this API');
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 20 || value.some((v) => typeof v !== 'string')) throw new TiktokFault(400, 'invalid_input', `${field} must be an array of up to 20 strings`);
  return value as string[];
}

/**
 * READ-ONLY coupon operations: Search Coupon List (POST /promotion/202406/coupons/search) and Get Coupon (GET /promotion/202406/coupons/{id}).
 * There is deliberately NO create/update route: the manifest keeps `promotion.coupon_create` unsupported, and coupons are created only through
 * the simulator's /demo Seller endpoints. Reading coupons proves nothing about the right to create or audit them.
 * Scope `sim.promotion.read` is a simulator placeholder (official scope names unresolved).
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class CouponsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
  ) {}

  @Post('promotion/202406/coupons/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PROMOTION_READ)
  async search(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const query = parseRawQuery(req.originalUrl)!.query;
    let pageSize = 50; // OAS default
    if (query.page_size !== undefined) {
      if (!/^\d{1,4}$/.test(query.page_size) || Number(query.page_size) < 1 || Number(query.page_size) > 100) throw new TiktokFault(400, 'invalid_input', 'page_size must be an integer in [1, 100]');
      pageSize = Number(query.page_size);
    }
    const after = query.page_token ? decodeCursor(query.page_token) : 0;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw new TiktokFault(400, 'invalid_input', 'request body must be a JSON object');
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      if (!SUPPORTED_FILTERS.has(k)) throw new TiktokFault(400, 'invalid_input', `unknown body field "${k}"`);
    }
    const statuses = stringArray(body.status, 'status');
    if (statuses?.some((s) => !(STATUS_VALUES as readonly string[]).includes(s))) throw new TiktokFault(400, 'invalid_input', 'status contains an undocumented value');
    const displayTypes = stringArray(body.display_type, 'display_type');
    if (displayTypes?.some((d) => !DISPLAY_TYPES.has(d))) throw new TiktokFault(400, 'invalid_input', 'display_type contains an unsupported value');
    const keyword = body.title_keyword;
    if (keyword !== undefined && keyword !== null && (typeof keyword !== 'string' || keyword.length < 1 || keyword.length > 100)) throw new TiktokFault(400, 'invalid_input', 'title_keyword must be 1-100 characters');

    const now = this.clock.now();
    const where: Prisma.CouponWhereInput = { shopId: shop.id };
    if (displayTypes) where.displayType = { in: displayTypes };
    // case-insensitive substring (DECISIONS 09c-Q9: the OAS is silent; SmartOmni filters by batch title)
    if (typeof keyword === 'string') where.title = { contains: keyword, mode: 'insensitive' };
    if (statuses?.length) {
      // the status is derived from the window, the deactivation flag and the BUSINESS clock
      const byStatus: Record<string, Prisma.CouponWhereInput> = {
        DEACTIVATED: { deactivated: true },
        NOT_START: { deactivated: false, startAt: { gt: now } },
        ONGOING: { deactivated: false, startAt: { lte: now }, endAt: { gt: now } },
        EXPIRED: { deactivated: false, endAt: { lte: now } },
      };
      where.OR = statuses.map((s) => byStatus[s]);
    }
    const [totalCount, rows] = await Promise.all([
      this.prisma.coupon.count({ where }),
      this.prisma.coupon.findMany({ where: { ...where, seq: { gt: after } }, orderBy: { seq: 'asc' }, take: pageSize + 1 }),
    ]);
    const page = rows.slice(0, pageSize);
    return this.envelope(req, {
      coupons: page.map((c) => couponSearchItem(c, now)),
      next_page_token: rows.length > pageSize ? encodeCursor(page[page.length - 1].seq) : '',
      total_count: totalCount,
    });
  }

  /** A coupon id of another shop is indistinguishable from an unknown id. */
  @Get('promotion/202406/coupons/:couponId')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PROMOTION_READ)
  async detail(@Req() req: TiktokRequest, @Param('couponId') couponId: string) {
    const shop = req.tiktok!.shop;
    const coupon = await this.prisma.coupon.findUnique({ where: { shopId_externalId: { shopId: shop.id, externalId: couponId } } });
    if (!coupon) throw new TiktokFault(404, 'coupon_not_found', 'coupon does not exist in this shop');
    return this.envelope(req, { coupon: couponDetail(coupon, this.clock.now()) });
  }

  private envelope(req: TiktokRequest, data: unknown) {
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data };
  }
}
