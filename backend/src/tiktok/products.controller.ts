import { Controller, Get, HttpCode, Inject, Param, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TiktokFault } from '../common/tiktok-fault';
import { APP_CONFIG, AppConfig } from '../config/config';
import { SCOPE_PRODUCT_READ } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { productDetail, productSummary, warehouseItem, ProductWithSkus } from './product.mapper';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';
import { parseRawQuery } from './signature';

/** Values of the Search Products `status` filter, from the OAS description (ALL plus the product statuses). */
const STATUS_FILTER = new Set(['ALL', 'DRAFT', 'PENDING', 'FAILED', 'ACTIVATE', 'SELLER_DEACTIVATED', 'PLATFORM_DEACTIVATED', 'FREEZE', 'DELETED']);
/** Body filters this simulator implements. Other documented fields are rejected instead of being silently ignored. */
const SUPPORTED_FILTERS = new Set(['status', 'seller_skus', 'sku_ids', 'create_time_ge', 'create_time_le', 'update_time_ge', 'update_time_le']);
const KNOWN_UNSUPPORTED_FILTERS = new Set(['audit_status', 'category_version', 'listing_platforms', 'listing_quality_tiers', 'return_draft_version', 'sns_filter']);

interface PageToken {
  seq: number;
}

export function encodePageToken(seq: number): string {
  return Buffer.from(JSON.stringify({ seq } satisfies PageToken), 'utf8').toString('base64url');
}

function decodePageToken(raw: string): PageToken {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<PageToken>;
    if (typeof v.seq === 'number' && Number.isSafeInteger(v.seq) && v.seq >= 0) return { seq: v.seq };
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

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.length === 0 || v.length > 200) || value.length > 100) {
    throw new TiktokFault(400, 'invalid_input', `${field} must be an array of up to 100 non-empty strings`);
  }
  return value as string[];
}

/**
 * Product + warehouse reads (official OAS shapes: schemas/ops/product.*.json, logistics.warehouses.response.json).
 * Every query is scoped to the shop of the access token; no shop id is ever read from the request body.
 * Scope `sim.product.read` is a simulator placeholder (official scope names unresolved) and also covers warehouses.
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class ProductsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** POST /product/202502/products/search: page_size (1-100) is required, page_token is an opaque keyset cursor. */
  @Post('product/202502/products/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async search(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const query = parseRawQuery(req.originalUrl)!.query;
    if (!/^\d{1,4}$/.test(query.page_size ?? '')) throw new TiktokFault(400, 'invalid_input', 'page_size is required and must be an integer in [1, 100]');
    const pageSize = Number(query.page_size);
    if (pageSize < 1 || pageSize > 100) throw new TiktokFault(400, 'invalid_input', 'page_size must be in [1, 100]');
    const after = query.page_token ? decodePageToken(query.page_token).seq : 0;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw new TiktokFault(400, 'invalid_input', 'request body must be a JSON object');
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      if (KNOWN_UNSUPPORTED_FILTERS.has(k)) throw new TiktokFault(400, 'invalid_input', `the simulator does not implement the "${k}" filter`);
      if (!SUPPORTED_FILTERS.has(k)) throw new TiktokFault(400, 'invalid_input', `unknown body field "${k}"`);
    }
    const status = body.status ?? 'ALL';
    if (typeof status !== 'string' || !STATUS_FILTER.has(status)) throw new TiktokFault(400, 'invalid_input', 'status is not a documented product status');
    const sellerSkus = stringList(body.seller_skus, 'seller_skus');
    const skuIds = stringList(body.sku_ids, 'sku_ids');
    const createGe = unixSeconds(body.create_time_ge, 'create_time_ge');
    const createLe = unixSeconds(body.create_time_le, 'create_time_le');
    const updateGe = unixSeconds(body.update_time_ge, 'update_time_ge');
    const updateLe = unixSeconds(body.update_time_le, 'update_time_le');

    const where: Prisma.ProductWhereInput = { shopId: shop.id };
    if (status !== 'ALL') where.status = status;
    const and: Prisma.ProductWhereInput[] = [];
    if (sellerSkus) and.push({ skus: { some: { sellerSku: { in: sellerSkus } } } });
    if (skuIds) and.push({ skus: { some: { externalId: { in: skuIds } } } });
    if (createGe || createLe) and.push({ createdAt: { ...(createGe && { gte: createGe }), ...(createLe && { lte: createLe }) } });
    if (updateGe || updateLe) and.push({ updatedAt: { ...(updateGe && { gte: updateGe }), ...(updateLe && { lte: updateLe }) } });
    if (and.length) where.AND = and;

    const [totalCount, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where: { ...where, seq: { gt: after } },
        orderBy: { seq: 'asc' },
        take: pageSize + 1,
        include: { skus: { orderBy: [{ createdAt: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }], include: { inventory: { include: { warehouse: true } } } } },
      }),
    ]);
    const page = rows.slice(0, pageSize);
    const hasMore = rows.length > pageSize;
    return this.envelope(req, {
      next_page_token: hasMore ? encodePageToken(page[page.length - 1].seq) : '',
      products: page.map((p) => productSummary(p as ProductWithSkus)),
      total_count: totalCount,
    });
  }

  /** GET /product/202309/products/{product_id}. A product id of another shop is indistinguishable from an unknown id. */
  @Get('product/202309/products/:productId')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async detail(@Req() req: TiktokRequest, @Param('productId') productId: string) {
    const shop = req.tiktok!.shop;
    const product = await this.prisma.product.findUnique({
      where: { shopId_externalId: { shopId: shop.id, externalId: productId } },
      include: { skus: { orderBy: [{ createdAt: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }], include: { inventory: { include: { warehouse: true } } } } },
    });
    // Product error codes are undocumented: this is a simulator test fault, not a TikTok code.
    if (!product) throw new TiktokFault(404, 'product_not_found', 'product does not exist in this shop');
    return this.envelope(req, productDetail(product as ProductWithSkus, this.config.publicApiBaseUrl));
  }

  /** GET /logistics/202309/warehouses: the warehouses of the token's shop; the OAS documents no pagination. */
  @Get('logistics/202309/warehouses')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async warehouses(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const rows = await this.prisma.warehouse.findMany({ where: { shopId: shop.id }, orderBy: [{ isDefault: 'desc' }, { code: 'asc' }] });
    return this.envelope(req, { warehouses: rows.map((w) => warehouseItem(w, shop.region)) });
  }

  private envelope(req: TiktokRequest, data: unknown) {
    return { code: 0, message: 'Success', request_id: req.requestId ?? 'unknown', data };
  }
}
