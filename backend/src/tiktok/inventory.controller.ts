import { Controller, HttpCode, Inject, Param, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { TiktokFault, SIMULATOR_FAULT_CODE } from '../common/tiktok-fault';
import { FaultService, INVENTORY_FAULT_KINDS } from '../faults/fault.service';
import { logInventory } from '../inventory/inventory-log';
import { emitInventoryChanged } from '../inventory/inventory-webhook';
import { SCOPE_INVENTORY_WRITE } from '../oauth/scopes';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessClock } from '../clock/clock';
import { WebhookEmitter } from '../webhooks/webhook-emitter.service';
import { RequireScope, TiktokApiGuard, TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

/** Main / secondary error codes. These two numbers are the EXAMPLE values printed in the official OAS; their meaning is unverified. */
const MAIN_ERROR = 12052990;
const EXTRA_ERROR = 12052097;
/** Simulator accepts zero stock; the current Partner Center quantity bounds are inconsistent. */
const MIN_QUANTITY = 0;
const MAX_QUANTITY = 99_999;
const MAX_SKUS_PER_REQUEST = 100;
const BLOCKED_PRODUCT_STATUSES = new Set(['FREEZE', 'DELETED']);

interface ExtraError {
  code: number;
  message: string;
  warehouse_id: string;
}
interface SkuError {
  code: number;
  message: string;
  detail: { sku_id: string; extra_errors: ExtraError[] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /product/202309/products/{product_id}/inventory/update (official OAS: schemas/ops/product.inventory_update.*).
 *
 * Semantics (simulator model, unverified where noted):
 * - The quantity is an ABSOLUTE value that replaces the stored one, so repeating the same request is harmless (a retry after a timeout is safe).
 * - Each SKU is applied atomically (all of its warehouses or none). A request is NOT all-or-nothing across SKUs: the OAS response is a list of per-SKU
 *   errors inside a code-0 envelope, so the valid SKUs are applied and the failing ones are listed in data.errors (unverified).
 * - Per OAS text: every SKU must belong to this product, the product must not be FREEZE/DELETED, the inventory list must name EVERY warehouse
 *   assigned to the SKU (none omitted, none foreign), `warehouse_id` is optional only when a single warehouse is assigned, quantity is in [0, 99999] (the OAS says from 1; DECISIONS D6.1).
 * - Everything is scoped to the token's shop: ids of another shop are indistinguishable from unknown ids.
 * - Fault rules TIMEOUT_BEFORE_WRITE / TIMEOUT_AFTER_WRITE (connection dropped without an answer) and APP_ERROR_200 (HTTP 200, non-zero code, nothing written)
 *   are consumed here only (see FaultService.INVENTORY_FAULT_KINDS).
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class InventoryController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FaultService) private readonly faults: FaultService,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
  ) {}

  @Post('product/202309/products/:productId/inventory/update')
  @HttpCode(200)
  @UseGuards(TiktokApiGuard)
  @RequireScope(SCOPE_INVENTORY_WRITE)
  async update(@Req() req: TiktokRequest, @Param('productId') productId: string, @Res({ passthrough: true }) res: Response) {
    const shop = req.tiktok!.shop;
    const requestId = req.requestId ?? 'unknown';
    const path = req.originalUrl.split('?')[0];
    const body = this.parseBody(req.body);
    const product = await this.prisma.product.findUnique({
      where: { shopId_externalId: { shopId: shop.id, externalId: productId } },
      include: { skus: true },
    });
    // Product error codes are undocumented: simulator test fault, not a TikTok code.
    if (!product) throw new TiktokFault(404, 'product_not_found', 'product does not exist in this shop');

    const fault = await this.faults.consume('API', shop.id, path, INVENTORY_FAULT_KINDS);
    const attempt = (outcome: string, total: number, applied: number, failed: number) =>
      this.prisma.inventoryUpdateAttempt.create({ data: { shopId: shop.id, productId: product.externalId, requestId, outcome, itemsTotal: total, itemsApplied: applied, itemsFailed: failed } });

    if (fault?.kind === 'TIMEOUT_BEFORE_WRITE') {
      await attempt('TIMEOUT_BEFORE_WRITE', body.length, 0, 0);
      await this.dropConnection(req, fault.params);
      return {};
    }
    if (fault?.kind === 'APP_ERROR_200') {
      await attempt('APP_ERROR_200', body.length, 0, body.length);
      // Application-level failure inside an HTTP 200: code is the simulator sentinel (TikTok codes are undocumented).
      return { code: SIMULATOR_FAULT_CODE, message: '[simulator test-fault] application error returned with HTTP 200; nothing was written', request_id: requestId, data: {}, simulator_fault: { kind: 'app_error_200', documented_in_tiktok_contract: false } };
    }

    const levelsBySku = new Map<string, { warehouseId: string; externalId: string }[]>();
    const assigned = await this.prisma.inventoryLevel.findMany({ where: { sku: { productId: product.id } }, include: { warehouse: { select: { externalId: true } } }, orderBy: { id: 'asc' } });
    for (const l of assigned) levelsBySku.set(l.skuId, [...(levelsBySku.get(l.skuId) ?? []), { warehouseId: l.warehouseId, externalId: l.warehouse.externalId }]);

    const errors: SkuError[] = [];
    const seen = new Set<string>();
    let applied = 0;
    for (const item of body) {
      const sku = product.skus.find((s) => s.externalId === item.id);
      const duplicate = seen.has(item.id);
      seen.add(item.id);
      if (BLOCKED_PRODUCT_STATUSES.has(product.status)) {
        errors.push(this.skuError(item.id, `the product is ${product.status}; its inventory cannot be updated`, []));
        continue;
      }
      if (!sku) {
        errors.push(this.skuError(item.id, 'the SKU does not belong to this product', []));
        continue;
      }
      if (duplicate) {
        errors.push(this.skuError(item.id, 'the SKU appears more than once in the request', []));
        continue;
      }
      const assignedHere = levelsBySku.get(sku.id) ?? [];
      const extra = this.checkWarehouses(item, assignedHere.map((a) => a.externalId));
      if (extra.length > 0) {
        errors.push(this.skuError(item.id, 'the inventory of this SKU was not updated', extra));
        continue;
      }
      await this.applySku(shop, product.externalId, sku.id, sku.externalId, item, assignedHere, requestId);
      applied++;
    }
    const afterWriteTimeout = fault?.kind === 'TIMEOUT_AFTER_WRITE';
    const outcome = afterWriteTimeout ? 'TIMEOUT_AFTER_WRITE' : errors.length === 0 ? 'APPLIED' : applied > 0 ? 'PARTIAL' : 'REJECTED';
    await attempt(outcome, body.length, applied, errors.length);

    if (afterWriteTimeout) {
      // The write above is committed; the caller never sees the answer. A retry (absolute values) must be safe.
      await this.dropConnection(req, fault.params);
      return {};
    }
    res.status(200);
    return { code: 0, message: 'Success', request_id: requestId, data: { errors } };
  }

  private parseBody(raw: unknown): { id: string; inventory: { warehouse_id?: string; quantity: unknown }[] }[] {
    const bad = (m: string) => new TiktokFault(400, 'invalid_input', m);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('request body must be a JSON object');
    const skus = (raw as { skus?: unknown }).skus;
    if (!Array.isArray(skus) || skus.length === 0 || skus.length > MAX_SKUS_PER_REQUEST) throw bad(`skus must be an array of 1 to ${MAX_SKUS_PER_REQUEST} items`);
    return skus.map((s) => {
      if (!s || typeof s !== 'object') throw bad('each skus item must be an object');
      const { id, inventory } = s as { id?: unknown; inventory?: unknown };
      if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw bad('skus[].id must be a non-empty string');
      if (!Array.isArray(inventory) || inventory.length === 0 || inventory.length > 50) throw bad('skus[].inventory must be a non-empty array');
      return {
        id,
        inventory: inventory.map((i) => {
          if (!i || typeof i !== 'object') throw bad('each inventory item must be an object');
          const { warehouse_id: wid, quantity } = i as { warehouse_id?: unknown; quantity?: unknown };
          if (wid !== undefined && typeof wid !== 'string') throw bad('inventory[].warehouse_id must be a string');
          return { warehouse_id: wid as string | undefined, quantity };
        }),
      };
    });
  }

  /** Secondary errors, one per offending warehouse; empty when the SKU entry is valid. */
  private checkWarehouses(item: { inventory: { warehouse_id?: string; quantity: unknown }[] }, assigned: string[]): ExtraError[] {
    const extra: ExtraError[] = [];
    const named = new Set<string>();
    for (const inv of item.inventory) {
      const wid = inv.warehouse_id ?? (assigned.length === 1 ? assigned[0] : '');
      if (wid === '') {
        extra.push({ code: EXTRA_ERROR, message: 'warehouse_id is required when the SKU is stored in more than one warehouse', warehouse_id: '' });
        continue;
      }
      if (!assigned.includes(wid)) {
        extra.push({ code: EXTRA_ERROR, message: 'the warehouse is not assigned to this SKU', warehouse_id: wid });
        continue;
      }
      if (named.has(wid)) {
        extra.push({ code: EXTRA_ERROR, message: 'the warehouse appears more than once', warehouse_id: wid });
        continue;
      }
      named.add(wid);
      if (typeof inv.quantity !== 'number' || !Number.isInteger(inv.quantity) || inv.quantity < MIN_QUANTITY || inv.quantity > MAX_QUANTITY) {
        extra.push({ code: EXTRA_ERROR, message: `quantity must be an integer in [${MIN_QUANTITY}, ${MAX_QUANTITY}]`, warehouse_id: wid });
      }
    }
    for (const wid of assigned) {
      if (!named.has(wid) && !extra.some((e) => e.warehouse_id === wid)) extra.push({ code: EXTRA_ERROR, message: 'every warehouse assigned to the SKU must be included', warehouse_id: wid });
    }
    return extra;
  }

  private skuError(skuId: string, message: string, extra: ExtraError[]): SkuError {
    return { code: MAIN_ERROR, message, detail: { sku_id: skuId, extra_errors: extra } };
  }

  /** One transaction per SKU: lock its stock rows, replace the quantities, log before/after (a no-op retry is logged as such). */
  private async applySku(shop: { id: string; tiktokShopId: string }, productId: string, skuId: string, skuExternalId: string, item: { inventory: { warehouse_id?: string; quantity: unknown }[] }, assigned: { warehouseId: string; externalId: string }[], requestId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; warehouseId: string; quantity: number }[]>`SELECT id, "warehouseId", quantity FROM "InventoryLevel" WHERE "skuId" = ${skuId} ORDER BY id FOR UPDATE`;
      const log: Parameters<typeof logInventory>[1] = [];
      let changed = false;
      for (const inv of item.inventory) {
        const target = assigned.length === 1 && inv.warehouse_id === undefined ? assigned[0] : assigned.find((a) => a.externalId === inv.warehouse_id)!;
        const row = rows.find((r) => r.warehouseId === target.warehouseId)!;
        const quantity = inv.quantity as number;
        if (row.quantity !== quantity) {
          changed = true;
          await tx.inventoryLevel.update({ where: { id: row.id }, data: { quantity } });
        }
        log.push({ shopId: shop.id, skuId, warehouseId: target.warehouseId, before: row.quantity, after: quantity, source: 'API', noop: row.quantity === quantity, requestId, note: 'absolute update' });
      }
      await logInventory(tx, log);
      if (changed) {
        await emitInventoryChanged(tx, new WebhookEmitter(this.clock, this.faults), this.clock, shop, { id: skuId, externalId: skuExternalId, productExternalId: productId }, 'OPEN_API', requestId);
      }
    });
  }

  /** Close the connection without answering, as a client-side timeout would look. */
  private async dropConnection(req: TiktokRequest, params: unknown): Promise<void> {
    const delay = Math.min(Math.max(Number((params as { delayMs?: number } | null)?.delayMs ?? 1000), 0), 30_000);
    if (delay > 0) await sleep(delay);
    req.socket.destroy();
  }
}
