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
import { BusinessClock } from '../clock/clock';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { logInventory } from '../inventory/inventory-log';
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
const CreateProduct = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).default(''),
  status: z.enum(SELLER_STATUSES).default('ACTIVATE'),
  skus: z.array(SkuInput).min(1).max(100),
});
const UpdateProduct = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(10_000),
    status: z.enum(SELLER_STATUSES),
    isNotForSale: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to update');
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

function sellerView(p: ProductRow) {
  return {
    id: p.id,
    externalId: p.externalId,
    title: p.title,
    description: p.description,
    status: p.status,
    isNotForSale: p.isNotForSale,
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

/** What a buyer sees: SKUs that can be bought, with price and a stock flag but no warehouse breakdown. */
function buyerView(p: ProductRow) {
  const skus = p.skus.map((s) => {
    const total = s.inventory.reduce((n, i) => n + i.quantity, 0);
    return { id: s.externalId, name: s.name, attributeName: s.attributeName, priceVnd: s.priceVnd, available: s.status === 'NORMAL' && total > 0, stock: total };
  });
  const prices = skus.map((s) => s.priceVnd);
  return {
    id: p.externalId,
    title: p.title,
    description: p.description,
    imageUrl: `/demo/media/products/${p.id}.svg`,
    minPriceVnd: prices.length ? Math.min(...prices) : 0,
    maxPriceVnd: prices.length ? Math.max(...prices) : 0,
    skus,
  };
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

  @Post('shops/:shopId/catalog/products')
  @UseGuards(DemoSessionGuard)
  async create(@Req() req: DemoRequest, @Param('shopId') shopId: string, @Body(new ZodPipe(CreateProduct)) body: z.infer<typeof CreateProduct>) {
    const p = principal(req);
    assertSellerShop(p, shopId);
    const warehouses = await this.prisma.warehouse.findMany({ where: { shopId } });
    const now = this.clock.now();
    const productId = randomUUID();
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.product.create({
        data: {
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
    const updated = await this.prisma.product.update({
      where: { id: existing.id },
      data: { ...body, updatedAt: this.clock.now() },
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
        for (const w of warehouses) {
          if (stock[w.externalId] === undefined) continue;
          const [prev] = await tx.$queryRaw<{ quantity: number }[]>`SELECT quantity FROM "InventoryLevel" WHERE "skuId" = ${sku.id} AND "warehouseId" = ${w.id} FOR UPDATE`;
          await logInventory(tx, [{ shopId, skuId: sku.id, warehouseId: w.id, before: prev?.quantity ?? 0, after: stock[w.externalId], source: 'SELLER', noop: (prev?.quantity ?? 0) === stock[w.externalId], note: 'seller edit' }]);
          await tx.inventoryLevel.upsert({
            where: { skuId_warehouseId: { skuId: sku.id, warehouseId: w.id } },
            create: { id: randomUUID(), skuId: sku.id, warehouseId: w.id, quantity: stock[w.externalId] },
            update: { quantity: stock[w.externalId] },
          });
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
