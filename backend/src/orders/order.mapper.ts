import type { Order, OrderLine } from '@prisma/client';

export type OrderWithLines = Order & { lines: OrderLine[]; buyer: { externalId: string; name: string }; warehouse?: { externalId: string } | null };

const secs = (d: Date | null | undefined): number | undefined => (d ? Math.floor(d.getTime() / 1000) : undefined);
const vnd = (n: number): string => String(n);
/** Time a paid order has to be shipped, the same window as the Shopee simulator. */
const SHIP_SLA_MS = 48 * 3600 * 1000;
const defined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

/** `data.orders[]` item for Get Order List / Get Order Detail (OAS: schemas/ops/order.*.response.json). Money fields are strings. */
export function orderItem(o: OrderWithLines) {
  const hasAddress = o.status !== 'UNPAID'; // OAS: recipient_address is not available under UNPAID (the simulator has no ON_HOLD, DECISIONS H6)
  const subTotal = o.originalProductPrice - o.sellerDiscount - o.platformDiscount;
  const shippingFee = o.originalShippingFee - o.shippingFeeDiscount;
  return defined({
    id: o.externalId,
    status: o.status,
    create_time: secs(o.createdAt),
    update_time: secs(o.updatedAt),
    paid_time: secs(o.paidAt),
    rts_sla_time: o.paidAt ? secs(new Date(o.paidAt.getTime() + SHIP_SLA_MS)) : undefined,
    rts_time: secs(o.rtsAt),
    collection_time: secs(o.collectionAt),
    delivery_time: secs(o.deliveredAt),
    cancel_time: secs(o.cancelledAt),
    cancel_reason: o.cancelReason ?? undefined,
    cancellation_initiator: o.cancellationInitiator ?? undefined,
    is_buyer_request_cancel: o.buyerRequestedCancel,
    is_on_hold_order: false, // OAS field kept for SmartOmni; the simulator never holds an order (DECISIONS H4)
    user_id: o.buyer.externalId,
    buyer_nickname: o.buyer.name,
    buyer_message: o.buyerMessage,
    payment_method_name: o.paymentMethodName,
    warehouse_id: o.warehouse?.externalId,
    payment: {
      currency: o.currency,
      original_total_product_price: vnd(o.originalProductPrice),
      seller_discount: vnd(o.sellerDiscount),
      platform_discount: vnd(o.platformDiscount),
      sub_total: vnd(subTotal),
      original_shipping_fee: vnd(o.originalShippingFee),
      shipping_fee: vnd(shippingFee),
      shipping_fee_platform_discount: vnd(0),
      shipping_fee_seller_discount: vnd(o.shippingFeeDiscount),
      product_tax: vnd(o.tax),
      tax: vnd(o.tax),
      total_amount: vnd(subTotal + shippingFee + o.tax),
    },
    recipient_address: hasAddress
      ? {
          name: o.recipientName,
          phone_number: o.recipientPhone,
          address_detail: o.addressLine,
          address_line1: o.addressLine,
          full_address: `${o.addressLine}, ${o.district}, ${o.city}`,
          postal_code: o.postalCode,
          region_code: 'VN',
        }
      : undefined,
    line_items: o.lines.map((l) =>
      defined({
        id: l.externalId,
        product_id: l.productExternalId,
        product_name: l.productName,
        sku_id: l.skuExternalId,
        sku_name: l.skuName,
        seller_sku: l.sellerSku,
        currency: o.currency,
        original_price: vnd(l.originalPrice),
        sale_price: vnd(l.salePrice),
        seller_discount: vnd(l.sellerDiscount),
        platform_discount: vnd(l.platformDiscount),
        package_id: l.packageId ?? undefined,
        display_status: l.displayStatus,
      }),
    ),
    packages: [...new Set(o.lines.map((l) => l.packageId).filter((id): id is string => !!id))].map((id) => ({ id })),
  });
}
