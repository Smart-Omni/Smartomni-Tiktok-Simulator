import { Prisma, Shop } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BusinessClock } from '../clock/clock';
import { WebhookEmitter } from '../webhooks/webhook-emitter.service';

/** Queue an absolute SKU snapshot in the same transaction as the stock write. */
export async function emitInventoryChanged(
  tx: Prisma.TransactionClient,
  emitter: WebhookEmitter,
  clock: BusinessClock,
  shop: Pick<Shop, 'id' | 'tiktokShopId'>,
  sku: { id: string; externalId: string; productExternalId: string },
  source: string,
  requestId?: string | null,
): Promise<void> {
  const levels = await tx.inventoryLevel.findMany({ where: { skuId: sku.id }, include: { warehouse: { select: { externalId: true } } }, orderBy: { warehouse: { externalId: 'asc' } } });
  const warehouses = levels.map((l) => ({ warehouse_id: l.warehouse.externalId, available_quantity: l.quantity }));
  await emitter.emit(tx, shop, 'INVENTORY_CHANGED_BY_SHOP', {
    event_id: randomUUID(),
    product_id: sku.productExternalId,
    sku_id: sku.externalId,
    quantity_snapshot_after_change: {
      available_quantity: warehouses.reduce((sum, w) => sum + w.available_quantity, 0),
      warehouses,
    },
    change_detail: [{ idempotency_key: randomUUID(), trigger_source: source, occurrence_time: Math.floor(clock.now().getTime() / 1000) }],
  }, requestId);
}
