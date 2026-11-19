import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import {
  attributesFor,
  BRANDS_DATA,
  CATEGORIES_DATA,
  categoryChain,
  checkListing,
  findCategory,
  isLeafCategory,
  rulesFor,
  type CategoryMeta,
  type ListingFields,
} from '../catalog-meta';
import { BusinessClock } from '../clock/clock';
import { APP_CONFIG, AppConfig } from '../config/config';
import { mediaIdFromUri, mediaUrl, MEDIA_URI_PREFIX } from '../media/media-store';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { logInventory } from '../inventory/inventory-log';
import { emitInventoryChanged } from '../inventory/inventory-webhook';
import { WebhookEmitter } from '../webhooks/webhook-emitter.service';
import { numericId } from '../seed/seed-data';
import {
  assertSellerShop,
  assertShopAccess,
  DemoPrincipal,
  DemoRequest,
  DemoSessionGuard,
} from './demo-session.guard';

/** Statuses a seller may set from the Seller UI (subset of the OAS product statuses; the rest are platform-driven). */
const SELLER_STATUSES = ['DRAFT', 'ACTIVATE', 'SELLER_DEACTIVATED', 'DELETED'] as const;
const money = z.number().int().min(1).max(2_000_000_000);
const SkuInput = z.object({
  sellerSku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  attributeName: z.string().trim().min(1).max(100).optional(),
  priceVnd: money,
  /** Stock by warehouse external id (a warehouse that is not listed starts at 0). */
  stock: z.record(z.string(), z.number().int().min(0).max(99_999)).optional(),
});
const positiveNumber = z.number().positive().max(1_000_000);
const AttributeValue = z
  .object({ id: z.string().min(1).max(50).optional(), name: z.string().trim().min(1).max(200).optional() })
  .refine((v) => v.id !== undefined || v.name !== undefined, 'a value needs an id or a name');
/** Listing fields (Seller Center product page), checked with the TikTok listing rules in `listingFields`. */
const Listing = {
  categoryId: z.string().trim().min(1).max(50).optional(),
  brandId: z.string().trim().min(1).max(50).nullable().optional(),
  /** `uri` values returned by POST /demo/shops/{shopId}/media/images; the first one is the main image. */
  images: z.array(z.string().min(1).max(200)).min(1).max(9).optional(),
  productAttributes: z.array(z.object({ id: z.string().min(1).max(50), values: z.array(AttributeValue).min(1).max(50) })).max(100).optional(),
  packageWeight: z.object({ value: positiveNumber, unit: z.enum(['KILOGRAM', 'POUND']).default('KILOGRAM') }).nullable().optional(),
  packageDimensions: z
    .object({ length: positiveNumber, width: positiveNumber, height: positiveNumber, unit: z.enum(['CENTIMETER', 'INCH']).default('CENTIMETER') })
    .nullable()
    .optional(),
};
type ListingInput = z.infer<z.ZodObject<typeof Listing>>;
const LISTING_KEYS = Object.keys(Listing) as (keyof ListingInput)[];
const CreateProduct = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).default(''),
  status: z.enum(SELLER_STATUSES).default('ACTIVATE'),
  skus: z.array(SkuInput).min(1).max(100),
  ...Listing,
});
const UpdateProduct = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(10_000).optional(),
    status: z.enum(SELLER_STATUSES).optional(),
    isNotForSale: z.boolean().optional(),
    ...Listing,
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update');

interface StoredAttribute {
  id: string;
  name?: string;
  values: { id?: string; name?: string }[];
}
const UpdateSku = z
  .object({
    sellerSku: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    attributeName: z.string().trim().min(1).max(100),
    priceVnd: money,
    status: z.enum(['NORMAL', 'DEACTIVATED']),
    stock: z.record(z.string(), z.number().int().min(0).max(99_999)),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');

const productInclude = {
  skus: { orderBy: [{ createdAt: 'asc' }, { sellerSku: 'asc' }, { id: 'asc' }], include: { inventory: { include: { warehouse: true } } } },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

function principal(req: DemoRequest): DemoPrincipal {
  return req.demo!;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Stored `mainImages` (TikTok shape) as {uri, url, width, height}; entries without a usable URL are skipped. */
function imagesOf(mainImages: Prisma.JsonValue): { uri: string; url: string; width: number | null; height: number | null }[] {
  if (!Array.isArray(mainImages)) return [];
  return mainImages.flatMap((i) => {
    if (!isObj(i) || typeof i.uri !== 'string') return [];
    const url = Array.isArray(i.urls) && typeof i.urls[0] === 'string' ? i.urls[0] : /^https?:\/\//i.test(i.uri) ? i.uri : undefined;
    if (!url) return [];
    return [{ uri: i.uri, url, width: typeof i.width === 'number' ? i.width : null, height: typeof i.height === 'number' ? i.height : null }];
  });
}

/** TikTok stores package numbers as strings; the Seller Center reads numbers. */
function weightOf(v: Prisma.JsonValue | null) {
  return isObj(v) && Number(v.value) > 0 ? { value: Number(v.value), unit: typeof v.unit === 'string' ? v.unit : 'KILOGRAM' } : null;
}
function dimensionsOf(v: Prisma.JsonValue | null) {
  if (!isObj(v) || !['length', 'width', 'height'].every((k) => Number(v[k]) > 0)) return null;
  return { length: Number(v.length), width: Number(v.width), height: Number(v.height), unit: typeof v.unit === 'string' ? v.unit : 'CENTIMETER' };
}

function sellerView(p: ProductRow) {
  return {
    id: p.id,
    externalId: p.externalId,
    title: p.title,
    description: p.description,
    status: p.status,
    isNotForSale: p.isNotForSale,
    images: imagesOf(p.mainImages),
    categoryId: p.categoryId,
    categoryPath: categoryChain(p.categoryId).map((c) => ({ id: c.id, name: c.local_name })),
    brandId: p.brandId,
    productAttributes: (Array.isArray(p.productAttributes) ? p.productAttributes : []) as unknown as StoredAttribute[],
    packageWeight: weightOf(p.packageWeight),
    packageDimensions: dimensionsOf(p.packageDimensions),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    skus: p.skus.map((s) => ({
      id: s.id,
      externalId: s.externalId,
      sellerSku: s.sellerSku,
      name: s.name,
      attributeName: s.attributeName,
      priceVnd: s.priceVnd,
      status: s.status,
      stock: s.inventory.map((i) => ({ warehouseId: i.warehouse.externalId, warehouseName: i.warehouse.name, quantity: i.quantity })),
      totalStock: s.inventory.reduce((n, i) => n + i.quantity, 0),
    })),
  };
}

/** Real image URLs from the product's `mainImages` (`urls[0]` when present, else an http(s) `uri`). */
function realImageUrls(mainImages: Prisma.JsonValue): string[] {
  if (!Array.isArray(mainImages)) return [];
  const out: string[] = [];
  for (const item of mainImages) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const urls = item.urls;
    const first = Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : undefined;
    const candidate = first ?? (typeof item.uri === 'string' ? item.uri : undefined);
    if (candidate && /^https?:\/\//i.test(candidate)) out.push(candidate);
  }
  return out;
}

/** What a buyer sees: SKUs that can be bought, with price and a stock flag but no warehouse breakdown. */
function buyerView(p: ProductRow) {
  const placeholder = `/demo/media/products/${p.id}.svg`;
  const images = realImageUrls(p.mainImages);
  const skus = p.skus.map((s) => {
    const total = s.inventory.reduce((n, i) => n + i.quantity, 0);
    return { id: s.externalId, name: s.name, attributeName: s.attributeName, priceVnd: s.priceVnd, available: s.status === 'NORMAL' && total > 0, stock: total };
  });
  const prices = skus.map((s) => s.priceVnd);
  return {
    id: p.externalId,
    title: p.title,
    description: p.description,
    imageUrl: images[0] ?? placeholder,
    images: images.length ? images : [placeholder],
    minPriceVnd: prices.length ? Math.min(...prices) : 0,
    maxPriceVnd: prices.length ? Math.max(...prices) : 0,
    skus,
  };
}

interface CategoryNode {
  id: string;
  name: string;
  isLeaf: boolean;
  children: CategoryNode[];
}

/** Categories a seller may list in (permission AVAILABLE), as a tree in data order. */
function categoryTree(): CategoryNode[] {
  const byParent = new Map<string, CategoryMeta[]>();
  for (const c of CATEGORIES_DATA) {
    if (!c.permission_statuses.includes('AVAILABLE')) continue;
    byParent.set(c.parent_id, [...(byParent.get(c.parent_id) ?? []), c]);
  }
  const build = (parentId: string): CategoryNode[] =>
    (byParent.get(parentId) ?? []).map((c) => ({ id: c.id, name: c.local_name, isLeaf: c.is_leaf, children: c.is_leaf ? [] : build(c.id) }));
  return build('0');
}

/** A leaf category a seller may list in: unknown => 404, not a leaf or not AVAILABLE => 400. */
function availableLeaf(categoryId: string): CategoryMeta {
  const c = findCategory(categoryId);
  if (!c) throw new NotFoundException('Unknown category');
  if (!c.is_leaf) throw new BadRequestException('Choose a leaf category (one without sub-categories)');
  if (!c.permission_statuses.includes('AVAILABLE')) throw new BadRequestException('This category is not available to the shop');
  return c;
}

const escapeXml = (s: string): string => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

/**
 * Seller product management, Buyer storefront, and Public Marketplace Catalog.
 */
@Controller()
export class CatalogDemoController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(WebhookEmitter) private readonly emitter: WebhookEmitter,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---- Public Marketplace Storefront --------------------------------------------------------------------------

  @Get('catalog')
  async marketplaceCatalog(
    @Query('q') q?: string,
    @Query('shopId') shopId?: string,
    @Query('limit') limitStr?: string,
    @Query('cursor') cursor?: string,
  ) {
    const limit = Math.min(Math.max(Number(limitStr) || 20, 1), 100);
    const query = q?.trim();

    const where: Prisma.ProductWhereInput = {
      status: 'ACTIVATE',
      isNotForSale: false,
      shop: { status: 'ACTIVE' },
      ...(shopId ? { shopId } : {}),
      ...(query
        ? {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(cursor ? { seq: { gt: Number(cursor) || 0 } } : {}),
    };

    const products = await this.prisma.product.findMany({
      where,
      orderBy: { seq: 'asc' },
      take: limit + 1,
      include: {
        ...productInclude,
        shop: { select: { id: true, name: true } },
      },
    });

    const hasNext = products.length > limit;
    const items = hasNext ? products.slice(0, limit) : products;
    const nextCursor = hasNext && items.length > 0 ? String(items[items.length - 1].seq) : null;

    return {
      currency: 'VND',
      items: items.map((p) => ({
        ...buyerView(p),
        shop: { id: p.shop.id, name: p.shop.name },
      })),
      nextCursor,
    };
  }

  @Get('catalog/:shopId/:productId')
  async marketplaceProductDetail(
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: {
        shopId,
        OR: [{ externalId: productId }, { id: productId }],
        status: 'ACTIVATE',
        isNotForSale: false,
        shop: { status: 'ACTIVE' },
      },
      include: {
        ...productInclude,
        shop: { select: { id: true, name: true } },
      },
    });

    if (!product) throw new NotFoundException('This product is not available');
    return {
      currency: 'VND',
      shop: { id: product.shop.id, name: product.shop.name },
      product: buyerView(product),
    };
  }

  // ---- Seller -------------------------------------------------------------------------------------------------

  @Get('shops/:shopId/catalog')
  @UseGuards(DemoSessionGuard)
  async sellerList(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const [products, warehouses] = await Promise.all([
      this.prisma.product.findMany({ where: { shopId }, orderBy: { seq: 'asc' }, include: productInclude }),
      this.prisma.warehouse.findMany({ where: { shopId }, orderBy: { code: 'asc' }, select: { externalId: true, name: true, city: true, isDefault: true } }),
    ]);
    return { currency: 'VND', warehouses, items: products.map(sellerView) };
  }

  // ---- Seller: category, attribute and brand data (the same data as the TikTok router) -------------------------

  @Get('shops/:shopId/catalog/categories')
  @UseGuards(DemoSessionGuard)
  categories(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    assertSellerShop(principal(req), shopId);
    return { categories: categoryTree() };
  }

  @Get('shops/:shopId/catalog/categories/:categoryId/attributes')
  @UseGuards(DemoSessionGuard)
  categoryAttributes(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('categoryId') categoryId: string) {
    assertSellerShop(principal(req), shopId);
    availableLeaf(categoryId);
    return {
      attributes: attributesFor(categoryId)
        .filter((a) => a.type === 'PRODUCT_PROPERTY')
        .map((a) => ({ id: a.id, name: a.name, isRequired: a.is_requried, isMultipleSelection: a.is_multiple_selection, isCustomizable: a.is_customizable, values: a.values })),
    };
  }

  @Get('shops/:shopId/catalog/categories/:categoryId/rules')
  @UseGuards(DemoSessionGuard)
  categoryRules(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('categoryId') categoryId: string) {
    assertSellerShop(principal(req), shopId);
    availableLeaf(categoryId);
    const r = rulesFor(categoryId);
    return { packageDimensionsRequired: r.package_dimension.is_required, sizeChartSupported: r.size_chart.is_supported, codSupported: r.cod.is_supported };
  }

  @Get('shops/:shopId/catalog/brands')
  @UseGuards(DemoSessionGuard)
  brands(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    assertSellerShop(principal(req), shopId);
    return { brands: BRANDS_DATA.map((b) => ({ id: b.id, name: b.name, authorized: b.authorized_status === 'AUTHORIZED' })) };
  }

  @Post('shops/:shopId/catalog/products')
  @UseGuards(DemoSessionGuard)
  async create(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CreateProduct)) body: z.infer<typeof CreateProduct>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const listing = await this.listingFields(shopId, body);
    const warehouses = await this.prisma.warehouse.findMany({ where: { shopId } });
    const now = this.clock.now();
    const productId = randomUUID();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.product.create({
        data: {
          ...(listing as Omit<Prisma.ProductUncheckedCreateInput, 'id' | 'shopId' | 'externalId' | 'title'>),
          id: productId,
          shopId,
          externalId: numericId('7500', `product:${productId}`),
          title: body.title,
          description: body.description,
          status: body.status,
          createdAt: now,
          updatedAt: now,
        },
      });
      for (const s of body.skus) await this.createSku(tx, shopId, productId, warehouses, s, now);
      return tx.product.findUniqueOrThrow({ where: { id: productId }, include: productInclude });
    });
    return sellerView(created);
  }

  @Patch('shops/:shopId/catalog/products/:productId')
  @UseGuards(DemoSessionGuard)
  async update(
    @Req() req: DemoRequest,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Body(new ZodPipe(UpdateProduct)) body: z.infer<typeof UpdateProduct>,
  ) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const existing = await this.ownedProduct(shopId, productId);
    if (existing.status === 'DELETED') throw new BadRequestException('A deleted product cannot be edited');
    const { title, description, status, isNotForSale } = body;
    const listing = await this.listingFields(shopId, body, existing);
    const updated = await this.prisma.product.update({
      where: { id: existing.id },
      data: { title, description, status, isNotForSale, ...listing, updatedAt: this.clock.now() },
      include: productInclude,
    });
    return sellerView(updated);
  }

  /** Soft delete: the product stays visible to Search Products with status DELETED. */
  @Delete('shops/:shopId/catalog/products/:productId')
  @UseGuards(DemoSessionGuard)
  async remove(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('productId') productId: string) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const existing = await this.ownedProduct(shopId, productId);
    const updated = await this.prisma.product.update({ where: { id: existing.id }, data: { status: 'DELETED', updatedAt: this.clock.now() }, include: productInclude });
    return sellerView(updated);
  }

  @Post('shops/:shopId/catalog/products/:productId/skus')
  @UseGuards(DemoSessionGuard)
  async addSku(
    @Req() req: DemoRequest,
    @Param('shopId') shopId: string,
    @Param('productId') productId: string,
    @Body(new ZodPipe(SkuInput)) body: z.infer<typeof SkuInput>,
  ) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const existing = await this.ownedProduct(shopId, productId);
    if (existing.status === 'DELETED') throw new BadRequestException('A deleted product cannot be edited');
    if (existing.skus.length >= 100) throw new BadRequestException('A product can have at most 100 SKUs');
    const warehouses = await this.prisma.warehouse.findMany({ where: { shopId } });
    const now = this.clock.now();
    const updated = await this.prisma.$transaction(async (tx) => {
      await this.createSku(tx, shopId, existing.id, warehouses, body, now);
      await tx.product.update({ where: { id: existing.id }, data: { updatedAt: now } });
      return tx.product.findUniqueOrThrow({ where: { id: existing.id }, include: productInclude });
    });
    return sellerView(updated);
  }

  /** Price, seller SKU, status and stock are edited per SKU: changing one SKU never touches its siblings. */
  @Patch('shops/:shopId/catalog/skus/:skuId')
  @UseGuards(DemoSessionGuard)
  async updateSku(
    @Req() req: DemoRequest,
    @Param('shopId') shopId: string,
    @Param('skuId') skuId: string,
    @Body(new ZodPipe(UpdateSku)) body: z.infer<typeof UpdateSku>,
  ) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const sku = await this.prisma.sku.findFirst({ where: { id: skuId, shopId }, include: { product: true } });
    if (!sku) throw new NotFoundException('Unknown SKU');
    if (sku.product.status === 'DELETED') throw new BadRequestException('A deleted product cannot be edited');
    const warehouses = await this.prisma.warehouse.findMany({ where: { shopId } });
    const { stock, ...fields } = body;
    if (stock) {
      for (const key of Object.keys(stock)) if (!warehouses.some((w) => w.externalId === key)) throw new BadRequestException(`Unknown warehouse ${key}`);
    }
    const now = this.clock.now();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (Object.keys(fields).length) await tx.sku.update({ where: { id: sku.id }, data: { ...fields, updatedAt: now } });
      if (stock) {
        let changed = false;
        for (const w of warehouses) {
          if (stock[w.externalId] === undefined) continue;
          const [prev] = await tx.$queryRaw<{ quantity: number }[]>`SELECT quantity FROM "InventoryLevel" WHERE "skuId" = ${sku.id} AND "warehouseId" = ${w.id} FOR UPDATE`;
          if ((prev?.quantity ?? 0) !== stock[w.externalId]) changed = true;
          await logInventory(tx, [{ shopId, skuId: sku.id, warehouseId: w.id, before: prev?.quantity ?? 0, after: stock[w.externalId], source: 'SELLER', noop: (prev?.quantity ?? 0) === stock[w.externalId], note: 'seller edit' }]);
          await tx.inventoryLevel.upsert({
            where: { skuId_warehouseId: { skuId: sku.id, warehouseId: w.id } },
            create: { id: randomUUID(), skuId: sku.id, warehouseId: w.id, quantity: stock[w.externalId] },
            update: { quantity: stock[w.externalId] },
          });
        }
        if (changed) {
          const shop = await tx.shop.findUniqueOrThrow({ where: { id: shopId } });
          await emitInventoryChanged(tx, this.emitter, this.clock, shop, { id: sku.id, externalId: sku.externalId, productExternalId: sku.product.externalId }, 'SELLER');
        }
      }
      await tx.product.update({ where: { id: sku.productId }, data: { updatedAt: now } });
      return tx.product.findUniqueOrThrow({ where: { id: sku.productId }, include: productInclude });
    });
    return sellerView(updated);
  }

  // ---- Buyer storefront ---------------------------------------------------------------------------------------

  @Get('shops/:shopId/storefront/products')
  @UseGuards(DemoSessionGuard)
  async storefront(@Req() req: DemoRequest, @Param('shopId') shopId: string) {
    await assertShopAccess(principal(req), shopId, this.prisma);
    const products = await this.prisma.product.findMany({ where: { shopId, status: 'ACTIVATE', isNotForSale: false }, orderBy: { seq: 'asc' }, include: productInclude });
    return { currency: 'VND', items: products.map(buyerView) };
  }

  /** Detail by the marketplace product id, so a link built from a catalog `externalProductId` opens the right product. */
  @Get('shops/:shopId/storefront/products/:productId')
  @UseGuards(DemoSessionGuard)
  async storefrontDetail(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Param('productId') productId: string) {
    await assertShopAccess(principal(req), shopId, this.prisma);
    const product = await this.prisma.product.findUnique({
      where: { shopId_externalId: { shopId, externalId: productId } },
      include: productInclude,
    });
    if (!product || product.status !== 'ACTIVATE' || product.isNotForSale) throw new NotFoundException('This product is not available');
    return { currency: 'VND', product: buyerView(product) };
  }

  /** Public placeholder picture (an <img> cannot send the session header). Content is derived from the title only. */
  @Get('media/products/:file')
  @Header('Content-Type', 'image/svg+xml')
  @Header('Cache-Control', 'no-store')
  async image(@Param('file') file: string) {
    const id = file.replace(/\.svg$/, '');
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const product = await this.prisma.product.findUnique({ where: { id }, select: { title: true } });
    if (!product) throw new NotFoundException();
    const hue = [...product.title].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600"><rect width="600" height="600" fill="hsl(${hue},45%,86%)"/><text x="300" y="310" font-family="sans-serif" font-size="34" text-anchor="middle" fill="hsl(${hue},40%,25%)">${escapeXml(product.title.slice(0, 28))}</text></svg>`;
  }

  // ---- helpers ------------------------------------------------------------------------------------------------

  /**
   * Turns the camelCase listing fields into stored columns. Checked by the TikTok `checkListing` (leaf category, brand,
   * the DA-6 demo rules, package dimensions) plus the Seller Center rules of DECISIONS DA-14: every attribute the category
   * flags `is_requried`, attributes and listed values of that category only, and images uploaded by this shop.
   * Runs only when a listing field is sent; on edit the stored values stand in for the fields that are not sent.
   */
  private async listingFields(shopId: string, body: ListingInput, existing?: ProductRow): Promise<Prisma.ProductUncheckedUpdateInput> {
    if (!LISTING_KEYS.some((k) => body[k] !== undefined)) return {};
    const reasons: string[] = [];

    let mainImages: Prisma.InputJsonValue[] | undefined;
    if (body.images !== undefined) {
      const ids = body.images.map((u) => mediaIdFromUri(u));
      if (ids.some((id) => !id)) reasons.push('images must be uri values returned by the image upload');
      else if (new Set(ids).size !== ids.length) reasons.push('images must not repeat');
      else {
        const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: ids as string[] }, shopId }, select: { id: true, width: true, height: true } });
        const byId = new Map(assets.map((a) => [a.id, a]));
        if (ids.some((id) => !byId.has(id!))) reasons.push('every image must be uploaded by this shop');
        else
          mainImages = ids.map((id) => {
            const a = byId.get(id!)!;
            const url = mediaUrl(this.config.publicApiBaseUrl, a.id);
            return { uri: `${MEDIA_URI_PREFIX}${a.id}`, urls: [url], thumb_urls: [url], width: a.width, height: a.height };
          });
      }
    }

    const categoryChanged = body.categoryId !== undefined && body.categoryId !== existing?.categoryId;
    const categoryId = body.categoryId ?? existing?.categoryId ?? undefined;
    // A new category drops the stored attributes unless new ones are sent.
    const attrs: StoredAttribute[] = body.productAttributes ?? (categoryChanged ? [] : ((existing?.productAttributes ?? []) as unknown as StoredAttribute[]));

    const snake: Record<string, unknown> = {};
    if (body.categoryId !== undefined) snake.category_id = body.categoryId;
    if (body.brandId) snake.brand_id = body.brandId;
    if (mainImages !== undefined) snake.main_images = mainImages;
    if (body.productAttributes !== undefined || categoryChanged) snake.product_attributes = attrs;
    if (body.packageWeight) snake.package_weight = { value: String(body.packageWeight.value), unit: body.packageWeight.unit };
    if (body.packageDimensions) {
      const d = body.packageDimensions;
      snake.package_dimensions = { length: String(d.length), width: String(d.width), height: String(d.height), unit: d.unit };
    }
    const stored: ListingFields = existing
      ? {
          categoryId: existing.categoryId ?? undefined,
          productAttributes: existing.productAttributes as Prisma.InputJsonValue,
          packageDimensions: body.packageDimensions === null ? undefined : ((existing.packageDimensions ?? undefined) as Prisma.InputJsonValue | undefined),
        }
      : {};
    const checked = checkListing(snake, stored);
    reasons.push(...checked.reasons);

    const defs = categoryId && isLeafCategory(categoryId) ? attributesFor(categoryId).filter((a) => a.type === 'PRODUCT_PROPERTY') : [];
    if (categoryId && isLeafCategory(categoryId)) {
      if (!findCategory(categoryId)!.permission_statuses.includes('AVAILABLE')) reasons.push('this category is not available to the shop');
      for (const a of attrs) {
        const def = defs.find((d) => d.id === a.id);
        if (!def) {
          reasons.push(`attribute ${a.id} does not belong to this category`);
          continue;
        }
        if (!def.is_multiple_selection && a.values.length > 1) reasons.push(`${def.name} takes one value`);
        for (const v of a.values) {
          if (v.id !== undefined && !def.values.some((x) => x.id === v.id)) reasons.push(`${def.name}: unknown value ${v.id}`);
          else if (v.id === undefined && !def.is_customizable) reasons.push(`${def.name} only accepts its listed values`);
        }
      }
      for (const d of defs) if (d.is_requried && !attrs.some((a) => a.id === d.id && a.values.length > 0)) reasons.push(`${d.name} is required for this category`);
    } else if (!categoryId && attrs.length) {
      reasons.push('choose a category before setting attributes');
    }
    if (reasons.length) throw new BadRequestException({ statusCode: 400, message: [...new Set(reasons)].join('; '), error: 'Bad Request' });

    const out: Prisma.ProductUncheckedUpdateInput = {};
    const f = checked.fields;
    if (f.categoryId !== undefined) out.categoryId = f.categoryId;
    if (body.brandId !== undefined) out.brandId = body.brandId;
    if (f.mainImages !== undefined) out.mainImages = f.mainImages;
    if (snake.product_attributes !== undefined) {
      // Stored in the TikTok shape, with attribute and value names filled in from the category data.
      out.productAttributes = attrs.map((a) => {
        const def = defs.find((d) => d.id === a.id);
        return {
          id: a.id,
          ...(def ? { name: def.name } : {}),
          values: a.values.map((v) => ({ ...(v.id ? { id: v.id } : {}), name: v.name ?? def?.values.find((x) => x.id === v.id)?.name ?? v.id ?? '' })),
        };
      });
    }
    if (body.packageWeight !== undefined) out.packageWeight = f.packageWeight ?? Prisma.DbNull;
    if (body.packageDimensions !== undefined) out.packageDimensions = f.packageDimensions ?? Prisma.DbNull;
    return out;
  }

  private async ownedProduct(shopId: string, productId: string): Promise<ProductRow> {
    // Accepts the row id; a product of another shop is reported as unknown (never confirmed to exist).
    const product = await this.prisma.product.findFirst({ where: { id: productId, shopId }, include: productInclude });
    if (!product) throw new NotFoundException('Unknown product');
    return product;
  }

  private async createSku(
    tx: Prisma.TransactionClient,
    shopId: string,
    productId: string,
    warehouses: { id: string; externalId: string }[],
    s: z.infer<typeof SkuInput>,
    now: Date,
  ): Promise<void> {
    for (const key of Object.keys(s.stock ?? {})) if (!warehouses.some((w) => w.externalId === key)) throw new BadRequestException(`Unknown warehouse ${key}`);
    const id = randomUUID();
    await tx.sku.create({
      data: {
        id,
        productId,
        shopId,
        externalId: numericId('7510', `sku:${id}`),
        sellerSku: s.sellerSku,
        name: s.name,
        attributeName: s.attributeName ?? 'Phân loại',
        priceVnd: s.priceVnd,
        createdAt: now,
        updatedAt: now,
        inventory: { create: warehouses.map((w) => ({ id: randomUUID(), warehouseId: w.id, quantity: s.stock?.[w.externalId] ?? 0 })) },
      },
    });
  }
}
