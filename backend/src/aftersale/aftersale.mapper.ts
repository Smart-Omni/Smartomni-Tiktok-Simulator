import type { AftersaleRecord } from '@prisma/client';
import { AftersaleRow } from './aftersale.service';

const secs = (d: Date): number => Math.floor(d.getTime() / 1000);
const vnd = (n: number): string => String(n);

function refund(currency: string, subtotal: number, shipping: number) {
  return { currency, refund_subtotal: vnd(subtotal), refund_shipping_fee: vnd(shipping), refund_tax: '0', refund_total: vnd(subtotal + shipping) };
}

const REASON_TEXT_VI: Record<string, string> = {
  CHANGED_MIND: 'Đổi ý, không muốn mua nữa',
  DAMAGED_ITEM: 'Hàng bị lỗi hoặc hư hỏng',
  NOT_AS_DESCRIBED: 'Sản phẩm không đúng mô tả',
  WRONG_ITEM: 'Giao sai hàng',
  OTHER: 'Lý do khác',
  ITEM_AS_DESCRIBED: 'Sản phẩm đúng mô tả',
  RETURN_WINDOW_EXPIRED: 'Hết thời hạn đổi trả',
  ITEM_USED_OR_DAMAGED: 'Sản phẩm đã qua sử dụng hoặc bị hư hỏng',
  ALREADY_SHIPPED: 'Đơn hàng đã giao cho đơn vị vận chuyển',
};

const REASON_TEXT_EN: Record<string, string> = {
  CHANGED_MIND: 'Changed mind',
  DAMAGED_ITEM: 'Damaged item',
  NOT_AS_DESCRIBED: 'Not as described',
  WRONG_ITEM: 'Wrong item',
  OTHER: 'Other reason',
  ITEM_AS_DESCRIBED: 'The item matches its description',
  RETURN_WINDOW_EXPIRED: 'The request is outside the return window',
  ITEM_USED_OR_DAMAGED: 'The returned item is used or damaged',
  ALREADY_SHIPPED: 'The order has already been handed to the carrier',
};

export function getReturnReasonText(reason: string, locale?: string): string {
  if (locale?.toLowerCase().startsWith('vi')) {
    return REASON_TEXT_VI[reason] ?? reason;
  }
  return REASON_TEXT_EN[reason] ?? reason;
}

/** `data.return_orders[]` item of Search Returns (OAS 202602 / 202309). Amounts are strings. */
export function returnItem(r: AftersaleRow, locale?: string) {
  return {
    return_id: r.externalId,
    order_id: r.order.externalId,
    return_status: r.status,
    return_type: r.type,
    role: r.role,
    return_reason: r.reason,
    return_reason_text: getReturnReasonText(r.reason, locale),
    arbitration_status: r.arbitrationStatus ?? 'NO_ARBITRATION',
    ...(r.sellerProposedReturnType ? { seller_proposed_return_type: r.sellerProposedReturnType } : {}),
    create_time: secs(r.createdAt),
    update_time: secs(r.updatedAt),
    refund_amount: refund(r.currency, r.refundSubtotal, r.refundShipping),
    ...(r.returnTrackingNumber ? { return_tracking_number: r.returnTrackingNumber } : {}),
    return_line_items: r.lines.map((l) => ({
      return_line_item_id: l.externalId,
      order_line_item_id: l.orderLine.externalId,
      product_name: l.orderLine.productName,
      sku_id: l.orderLine.skuExternalId,
      sku_name: l.orderLine.skuName,
      seller_sku: l.orderLine.sellerSku,
      refund_amount: refund(r.currency, l.refundSubtotal, 0),
    })),
  };
}

/** `data.cancellations[]` item of Search Cancellations (OAS: schemas/ops/cancellation.search.response.json). */
export function cancellationItem(r: AftersaleRow) {
  const perLineShipping = 0; // shipping is refunded once, on the request total
  return {
    cancel_id: r.externalId,
    order_id: r.order.externalId,
    cancel_status: r.status,
    cancel_type: r.type,
    role: r.role,
    cancel_reason: r.reason,
    cancel_reason_text: r.reason,
    create_time: secs(r.createdAt),
    update_time: secs(r.updatedAt),
    refund_amount: refund(r.currency, r.refundSubtotal, r.refundShipping),
    cancel_line_items: r.lines.map((l) => ({
      cancel_line_item_id: l.externalId,
      order_line_item_id: l.orderLine.externalId,
      product_name: l.orderLine.productName,
      sku_id: l.orderLine.skuExternalId,
      sku_name: l.orderLine.skuName,
      seller_sku: l.orderLine.sellerSku,
      refund_amount: refund(r.currency, l.refundSubtotal, perLineShipping),
    })),
  };
}

/** Get Return Records item. `event` is always ORDER_RETURN per the OAS description; `role` maps the test-console actor to OPERATOR. */
export function recordItem(rec: AftersaleRecord) {
  return { create_time: secs(rec.at), description: `${rec.fromStatus ?? 'NEW'} -> ${rec.toStatus}`, event: 'ORDER_RETURN', note: rec.note, reason_text: rec.note, role: rec.actor };
}
