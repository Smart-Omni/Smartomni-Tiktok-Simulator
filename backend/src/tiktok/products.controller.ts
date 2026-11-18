import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { BusinessClock } from '../clock/clock';
import { TiktokFault } from '../common/tiktok-fault';
import { APP_CONFIG, AppConfig } from '../config/config';
import { SCOPE_PRODUCT_READ, SCOPE_PRODUCT_WRITE } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { numericId } from '../seed/seed-data';
import { buildProductStatusChangeData, WebhookEmitter } from '../webhooks/webhook-emitter.service';
import { productDetail, productSummary, warehouseItem, ProductWithSkus } from './product.mapper';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';
import { FaultService } from '../faults/fault.service';
import { parseRawQuery } from './signature';

/** Values of the Search Products `status` filter, from the OAS description (ALL plus the product statuses). */
const STATUS_FILTER = new Set(['ALL', 'DRAFT', 'PENDING', 'FAILED', 'ACTIVATE', 'SELLER_DEACTIVATED', 'PLATFORM_DEACTIVATED', 'FREEZE', 'DELETED']);

/** Body filters supported by the simulator. */
const SUPPORTED_FILTERS = new Set([
  'status',
  'seller_skus',
  'sku_ids',
  'create_time_ge',
  'create_time_le',
  'update_time_ge',
  'update_time_le',
  'audit_status',
  'listing_platforms',
  'sns_filter',
  'category_version',
  'listing_quality_tiers',
  'return_draft_version',
  'page_size',
  'page_token',
]);
const KNOWN_UNSUPPORTED_FILTERS = new Set<string>();

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

const CATEGORIES_DATA = [
  { id: '100001', parent_id: '0', local_name: 'Thời trang & Phụ kiện', is_leaf: false, permission_statuses: ['AVAILABLE'] },
  { id: '100002', parent_id: '100001', local_name: 'Áo Nam', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '100003', parent_id: '100001', local_name: 'Quần Nam', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '100004', parent_id: '100001', local_name: 'Áo Nữ', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '200001', parent_id: '0', local_name: 'Điện tử & Phụ kiện', is_leaf: false, permission_statuses: ['AVAILABLE'] },
  { id: '200002', parent_id: '200001', local_name: 'Phụ kiện điện thoại', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '300001', parent_id: '0', local_name: 'Sức khỏe & Sắc đẹp', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '400001', parent_id: '0', local_name: 'Nhà cửa & Đời sống', is_leaf: true, permission_statuses: ['AVAILABLE'] },
  { id: '500001', parent_id: '0', local_name: 'Hàng hạn chế (demo)', is_leaf: true, permission_statuses: ['INVITE_ONLY'] },
];

/** Attribute field names follow the OAS spelling, including `is_requried`. */
const ATTRIBUTES_DATA = [
  { id: 'attr_brand', name: 'Thương hiệu', type: 'PRODUCT_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: false, values: [{ id: 'brand_001', name: 'No Brand' }], requirement_conditions: [] },
  { id: 'attr_color', name: 'Màu sắc', type: 'SALES_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: true, values: [{ id: 'color_black', name: 'Đen' }, { id: 'color_white', name: 'Trắng' }], requirement_conditions: [] },
  { id: 'attr_size', name: 'Kích cỡ', type: 'SALES_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: true, values: [{ id: 'size_s', name: 'S' }, { id: 'size_m', name: 'M' }, { id: 'size_l', name: 'L' }], requirement_conditions: [] },
  { id: 'attr_material', name: 'Chất liệu', type: 'PRODUCT_PROPERTY', is_requried: false, is_multiple_selection: false, is_customizable: true, values: [], requirement_conditions: [] },
];

/** `UNAUTHORIEZD` is the OAS spelling of the unauthorized value. */
const BRANDS_DATA = [
  { id: 'brand_001', name: 'No Brand', authorized_status: 'AUTHORIZED', is_t1_brand: false },
  { id: 'brand_002', name: 'OEM', authorized_status: 'AUTHORIZED', is_t1_brand: false },
  { id: 'brand_003', name: 'SmartOmni', authorized_status: 'AUTHORIZED', is_t1_brand: false },
  { id: 'brand_004', name: 'Apple', authorized_status: 'UNAUTHORIEZD', is_t1_brand: true },
  { id: 'brand_005', name: 'Samsung', authorized_status: 'UNAUTHORIEZD', is_t1_brand: true },
];

function leafCategory(categoryId: string): void {
  const c = CATEGORIES_DATA.find((x) => x.id === categoryId);
  if (!c || !c.is_leaf) throw new TiktokFault(400, 'invalid_input', 'category_id must be an existing leaf category');
}

/** BCP-47-ish locale check (e.g. vi-VN, en-US). Only the shape is validated. */
function checkLocale(value: string | undefined): void {
  if (value !== undefined && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value)) {
    throw new TiktokFault(400, 'invalid_input', 'locale must be a BCP-47 language tag such as vi-VN');
  }
}

function queryBool(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new TiktokFault(400, 'invalid_input', `${field} must be a boolean`);
}

/**
 * Product management & catalog API per TikTok Shop OpenAPI standard.
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class ProductsController {
  private readonly emitter: WebhookEmitter;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(FaultService) private readonly faults: FaultService,
  ) {
    this.emitter = new WebhookEmitter(this.clock, this.faults);
  }

  /** POST /product/202502/products/search */
  @Post('product/202502/products/search')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async search(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const query = parseRawQuery(req.originalUrl)!.query;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw new TiktokFault(400, 'invalid_input', 'request body must be a JSON object');
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      if (KNOWN_UNSUPPORTED_FILTERS.has(k)) throw new TiktokFault(400, 'invalid_input', `the simulator does not implement the "${k}" filter`);
      if (!SUPPORTED_FILTERS.has(k)) throw new TiktokFault(400, 'invalid_input', `unknown body field "${k}"`);
    }

    const rawPageSize = query.page_size ?? (body.page_size !== undefined ? String(body.page_size) : undefined);
    if (!/^\d{1,4}$/.test(rawPageSize ?? '')) throw new TiktokFault(400, 'invalid_input', 'page_size is required and must be an integer in [1, 100]');
    const pageSize = Number(rawPageSize);
    if (pageSize < 1 || pageSize > 100) throw new TiktokFault(400, 'invalid_input', 'page_size must be in [1, 100]');
    const rawToken = query.page_token ?? (typeof body.page_token === 'string' ? body.page_token : undefined);
    const after = rawToken ? decodePageToken(rawToken).seq : 0;
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

    // Audit status mapping: APPROVED -> ACTIVATE, AUDITING -> PENDING, FAILED -> FAILED
    if (body.audit_status) {
      const audits = Array.isArray(body.audit_status) ? body.audit_status : [body.audit_status];
      const mappedStatuses: string[] = [];
      for (const a of audits) {
        if (a === 'APPROVED') mappedStatuses.push('ACTIVATE');
        else if (a === 'AUDITING') mappedStatuses.push('PENDING');
        else if (a === 'FAILED') mappedStatuses.push('FAILED');
      }
      if (mappedStatuses.length > 0) {
        and.push({ status: { in: mappedStatuses } });
      }
    }

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

  /** GET /product/202309/products/{product_id} */
  @Get('product/202309/products/:productId')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async detail(@Req() req: TiktokRequest, @Param('productId') productId: string) {
    const shop = req.tiktok!.shop;
    const query = parseRawQuery(req.originalUrl)!.query;
    // The simulator keeps no draft / under-review versions: these are validated and ignored (DECISIONS DA-4).
    queryBool(query.return_under_review_version, 'return_under_review_version');
    queryBool(query.return_draft_version, 'return_draft_version');
    checkLocale(query.locale);
    const product = await this.prisma.product.findUnique({
      where: { shopId_externalId: { shopId: shop.id, externalId: productId } },
      include: { skus: { orderBy: [{ createdAt: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }], include: { inventory: { include: { warehouse: true } } } } },
    });
    if (!product) throw new TiktokFault(404, 'product_not_found', 'product does not exist in this shop');
    return this.envelope(req, productDetail(product as ProductWithSkus, this.config.publicApiBaseUrl));
  }

  /** POST /product/202309/products: Create product */
  @Post('product/202309/products')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_WRITE)
  async createProduct(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 500) {
      throw new TiktokFault(400, 'invalid_input', 'title is required (1-500 chars)');
    }
    const description = typeof body.description === 'string' ? body.description : '';
    const skus = Array.isArray(body.skus) && body.skus.length > 0 ? (body.skus as Array<Record<string, unknown>>) : null;
    if (!skus) {
      throw new TiktokFault(400, 'invalid_input', 'skus must contain at least 1 SKU');
    }

    const defaultWarehouse = await this.prisma.warehouse.findFirst({ where: { shopId: shop.id } });
    const now = this.clock.now();
    const productId = randomUUID();
    const externalId = numericId('7500', `product:${productId}`);

    const created = await this.prisma.$transaction(async (tx) => {
      const p = await tx.product.create({
        data: {
          id: productId,
          shopId: shop.id,
          externalId,
          title,
          description,
          status: 'ACTIVATE',
          createdAt: now,
          updatedAt: now,
        },
      });

      const skuResults = [];
      for (let i = 0; i < skus.length; i++) {
        const item = skus[i];
        const skuId = randomUUID();
        const skuExtId = numericId('7510', `sku:${skuId}`);
        const sellerSku = typeof item.seller_sku === 'string' ? item.seller_sku : `SKU-${Date.now()}-${i + 1}`;
        const name = typeof item.name === 'string' ? item.name : `Variant ${i + 1}`;
        const priceObj = item.price as Record<string, unknown> | undefined;
        const priceVnd =
          typeof item.price_vnd === 'number'
            ? item.price_vnd
            : priceObj && typeof priceObj.amount === 'number'
              ? priceObj.amount
              : priceObj && typeof priceObj.amount === 'string'
                ? Number(priceObj.amount) || 100000
                : 100000;

        const s = await tx.sku.create({
          data: {
            id: skuId,
            shopId: shop.id,
            productId: p.id,
            externalId: skuExtId,
            sellerSku,
            name,
            priceVnd,
            createdAt: now,
            updatedAt: now,
          },
        });

        // Inventory
        const invList = Array.isArray(item.inventory) ? item.inventory : [];
        if (invList.length > 0) {
          for (const inv of invList) {
            const wh = await tx.warehouse.findFirst({ where: { shopId: shop.id, externalId: inv.warehouse_id } });
            if (wh) {
              await tx.inventoryLevel.create({
                data: {
                  id: randomUUID(),
                  skuId: s.id,
                  warehouseId: wh.id,
                  quantity: Number(inv.quantity) || 10,
                },
              });
            }
          }
        } else if (defaultWarehouse) {
          await tx.inventoryLevel.create({
            data: {
              id: randomUUID(),
              skuId: s.id,
              warehouseId: defaultWarehouse.id,
              quantity: 100,
            },
          });
        }

        skuResults.push({ id: skuExtId, seller_sku: sellerSku });
      }

      // Emit PRODUCT_CREATION & PRODUCT_STATUS_CHANGE
      const productEvent = buildProductStatusChangeData({
        productId: externalId,
        status: 'ACTIVATE',
        auditStatus: 'APPROVED',
        updateTime: Math.floor(now.getTime() / 1000),
      });
      await this.emitter.emit(tx, shop, 'PRODUCT_CREATION', productEvent, req.requestId);
      await this.emitter.emit(tx, shop, 'PRODUCT_STATUS_CHANGE', productEvent, req.requestId);

      return { product_id: externalId, skus: skuResults };
    });

    return this.envelope(req, created);
  }

  /** PUT /product/202509/products/{product_id}: Edit product */
  @Put('product/202509/products/:productId')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_WRITE)
  async editProduct(@Req() req: TiktokRequest, @Param('productId') productId: string) {
    const shop = req.tiktok!.shop;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const product = await this.prisma.product.findUnique({
      where: { shopId_externalId: { shopId: shop.id, externalId: productId } },
      include: { skus: true },
    });
    if (!product) throw new TiktokFault(404, 'product_not_found', 'product does not exist in this shop');

    const now = this.clock.now();
    const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : product.title;
    const description = typeof body.description === 'string' ? body.description : product.description;
    const isNotForSale = typeof body.is_not_for_sale === 'boolean' ? body.is_not_for_sale : product.isNotForSale;

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id: product.id },
        data: { title, description, isNotForSale, updatedAt: now },
      });

      // Update SKUs if provided
      if (Array.isArray(body.skus)) {
        for (const item of body.skus as Array<Record<string, unknown>>) {
          const sellerSku = item.seller_sku as string | undefined;
          if (sellerSku) {
            const existingSku = product.skus.find((s) => s.sellerSku === sellerSku);
            const priceObj = item.price as Record<string, unknown> | undefined;
            const priceVnd =
              typeof item.price_vnd === 'number'
                ? item.price_vnd
                : priceObj && typeof priceObj.amount === 'number'
                  ? priceObj.amount
                  : priceObj && typeof priceObj.amount === 'string'
                    ? Number(priceObj.amount) || undefined
                    : undefined;

            if (existingSku && priceVnd !== undefined) {
              await tx.sku.update({
                where: { id: existingSku.id },
                data: { priceVnd, updatedAt: now },
              });
            }
          }
        }
      }

      const productEvent = buildProductStatusChangeData({
        productId,
        status: product.status,
        auditStatus: product.status === 'ACTIVATE' ? 'APPROVED' : 'NONE',
        updateTime: Math.floor(now.getTime() / 1000),
      });
      await this.emitter.emit(tx, shop, 'PRODUCT_STATUS_CHANGE', productEvent, req.requestId);
    });

    return this.envelope(req, { product_id: productId });
  }

  /** POST /product/202309/products/activate */
  @Post('product/202309/products/activate')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_WRITE)
  async activateProducts(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const body = (req.body ?? {}) as { product_ids?: unknown };
    const productIds = stringList(body.product_ids, 'product_ids');
    if (!productIds || productIds.length === 0) {
      throw new TiktokFault(400, 'invalid_input', 'product_ids must be a non-empty array');
    }

    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { shopId: shop.id, externalId: { in: productIds } },
        data: { status: 'ACTIVATE', updatedAt: now },
      });

      for (const pid of productIds) {
        const ev = buildProductStatusChangeData({
          productId: pid,
          status: 'ACTIVATE',
          auditStatus: 'APPROVED',
          updateTime: Math.floor(now.getTime() / 1000),
        });
        await this.emitter.emit(tx, shop, 'PRODUCT_STATUS_CHANGE', ev, req.requestId);
      }
    });

    return this.envelope(req, { errors: [] });
  }

  /** POST /product/202309/products/deactivate */
  @Post('product/202309/products/deactivate')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_WRITE)
  async deactivateProducts(@Req() req: TiktokRequest) {
    const shop = req.tiktok!.shop;
    const body = (req.body ?? {}) as { product_ids?: unknown };
    const productIds = stringList(body.product_ids, 'product_ids');
    if (!productIds || productIds.length === 0) {
      throw new TiktokFault(400, 'invalid_input', 'product_ids must be a non-empty array');
    }

    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      await tx.product.updateMany({
        where: { shopId: shop.id, externalId: { in: productIds } },
        data: { status: 'SELLER_DEACTIVATED', updatedAt: now },
      });

      for (const pid of productIds) {
        const ev = buildProductStatusChangeData({
          productId: pid,
          status: 'SELLER_DEACTIVATED',
          auditStatus: 'NONE',
          updateTime: Math.floor(now.getTime() / 1000),
        });
        await this.emitter.emit(tx, shop, 'PRODUCT_STATUS_CHANGE', ev, req.requestId);
      }
    });

    return this.envelope(req, { errors: [] });
  }

  /** POST /product/202309/products/listing_check */
  @Post('product/202309/products/listing_check')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async listingCheck(@Req() req: TiktokRequest) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const failedReasons: string[] = [];

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) failedReasons.push('Product title is required');
    else if (title.length > 500) failedReasons.push('Product title exceeds 500 characters');

    const skus = Array.isArray(body.skus) ? body.skus : [];
    if (skus.length === 0) {
      failedReasons.push('At least one SKU is required');
    }

    const result = failedReasons.length === 0 ? 'PASS' : 'FAIL';
    return this.envelope(req, {
      check_result: result,
      failed_reasons: failedReasons,
    });
  }

  /** GET /product/202309/categories */
  @Get('product/202309/categories')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async categories(@Req() req: TiktokRequest) {
    const query = parseRawQuery(req.originalUrl)!.query;
    checkLocale(query.locale);
    const keyword = query.keyword?.trim().toLowerCase();
    const includeProhibited = queryBool(query.include_prohibited_categories, 'include_prohibited_categories') ?? false;
    const categories = CATEGORIES_DATA.filter((c) => {
      if (keyword && !c.local_name.toLowerCase().includes(keyword)) return false;
      if (!includeProhibited && c.permission_statuses.some((p) => p === 'INVITE_ONLY' || p === 'NON_MAIN_CATEGORY' || p === 'PROHIBITED')) return false;
      return true;
    });
    return this.envelope(req, { categories });
  }

  /** GET /product/202309/categories/{category_id}/attributes */
  @Get('product/202309/categories/:categoryId/attributes')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async categoryAttributes(@Req() req: TiktokRequest, @Param('categoryId') categoryId: string) {
    checkLocale(parseRawQuery(req.originalUrl)!.query.locale);
    leafCategory(categoryId);
    return this.envelope(req, { attributes: ATTRIBUTES_DATA });
  }

  /** GET /product/202309/categories/{category_id}/rules */
  @Get('product/202309/categories/:categoryId/rules')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async categoryRules(@Req() req: TiktokRequest, @Param('categoryId') categoryId: string) {
    checkLocale(parseRawQuery(req.originalUrl)!.query.locale);
    leafCategory(categoryId);
    return this.envelope(req, {
      cod: { is_supported: true },
      package_dimension: { is_required: false },
      size_chart: { is_required: false, is_supported: ['100002', '100003', '100004'].includes(categoryId) },
      product_certifications: [],
      epr: { is_required: false },
      fees: [],
      allowed_special_product_types: [],
    });
  }

  /** Old non-OAS path, answers 501 only (DECISIONS DA-3). */
  @Get('product/202309/attributes')
  attributesRemoved(): never {
    throw new TiktokFault(501, 'unsupported_operation', 'GET /product/202309/attributes is not an official path; use /product/202309/categories/{category_id}/attributes');
  }

  /** Old non-OAS path, answers 501 only (DECISIONS DA-3). */
  @Get('product/202309/rules')
  rulesRemoved(): never {
    throw new TiktokFault(501, 'unsupported_operation', 'GET /product/202309/rules is not an official path; use /product/202309/categories/{category_id}/rules');
  }

  /** GET /product/202309/brands */
  @Get('product/202309/brands')
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_READ)
  async brands(@Req() req: TiktokRequest) {
    const query = parseRawQuery(req.originalUrl)!.query;
    if (!/^\d{1,4}$/.test(query.page_size ?? '')) throw new TiktokFault(400, 'invalid_input', 'page_size is required and must be an integer in [1, 100]');
    const pageSize = Number(query.page_size);
    if (pageSize < 1 || pageSize > 100) throw new TiktokFault(400, 'invalid_input', 'page_size must be in [1, 100]');
    const isAuthorized = queryBool(query.is_authorized, 'is_authorized');
    const name = query.brand_name?.toLowerCase();
    let offset = 0;
    if (query.page_token) {
      try {
        const v = JSON.parse(Buffer.from(query.page_token, 'base64url').toString('utf8')) as { offset?: unknown };
        if (typeof v.offset !== 'number' || !Number.isSafeInteger(v.offset) || v.offset < 0) throw new Error('bad token');
        offset = v.offset;
      } catch {
        throw new TiktokFault(400, 'invalid_input', 'page_token is not a token issued by this API');
      }
    }
    const categoryScoped = query.category_id !== undefined;
    if (categoryScoped && !CATEGORIES_DATA.some((c) => c.id === query.category_id)) throw new TiktokFault(400, 'invalid_input', 'category_id does not exist');
    const matched = BRANDS_DATA.filter((b) => (name === undefined || b.name.toLowerCase().startsWith(name)) && (isAuthorized === undefined || (b.authorized_status === 'AUTHORIZED') === isAuthorized));
    const page = matched.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < matched.length;
    return this.envelope(req, {
      brands: page.map((b) => (categoryScoped && b.authorized_status === 'AUTHORIZED' ? { ...b, brand_status: 'AVAILABLE' } : b)),
      next_page_token: hasMore ? Buffer.from(JSON.stringify({ offset: offset + pageSize }), 'utf8').toString('base64url') : '',
      total_count: matched.length,
    });
  }

  /** POST /product/202309/images/upload */
  @Post('product/202309/images/upload')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_WRITE)
  @UseInterceptors(AnyFilesInterceptor())
  async uploadImage(
    @Req() req: TiktokRequest,
    @UploadedFiles() files?: Array<any>,
  ) {
    const file = files && files.length > 0 ? files[0] : undefined;
    const fileName = file?.originalname || 'product_image.jpg';
    if (file?.buffer) {
      try {
        await fs.mkdir(this.config.mediaDir, { recursive: true });
        await fs.writeFile(join(this.config.mediaDir, fileName), file.buffer);
      } catch {
        /* Ignore disk write errors in restricted test environment */
      }
    }

    return this.envelope(req, {
      uri: `tos-maliva-i-o3syd03w52-us/${randomUUID().slice(0, 12)}`,
      url: `https://simulator.smartomni.local/uploads/${fileName}`,
      width: 800,
      height: 800,
      use_case: 'MAIN_IMAGE',
    });
  }

  /** POST /product/202309/files/upload */
  @Post('product/202309/files/upload')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_PRODUCT_WRITE)
  @UseInterceptors(AnyFilesInterceptor())
  async uploadFile(
    @Req() req: TiktokRequest,
    @UploadedFiles() files?: Array<any>,
  ) {
    const file = files && files.length > 0 ? files[0] : undefined;
    const fileName = file?.originalname || 'certificate.pdf';
    if (file?.buffer) {
      try {
        await fs.mkdir(this.config.mediaDir, { recursive: true });
        await fs.writeFile(join(this.config.mediaDir, fileName), file.buffer);
      } catch {
        /* Ignore disk write error */
      }
    }

    return this.envelope(req, {
      id: `file_${randomUUID().slice(0, 12)}`,
      name: fileName,
      url: `https://simulator.smartomni.local/uploads/${fileName}`,
      format: fileName.endsWith('.pdf') ? 'PDF' : 'IMAGE',
    });
  }

  /** GET /logistics/202309/warehouses */
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
