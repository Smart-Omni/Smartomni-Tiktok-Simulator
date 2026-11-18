# Support matrix

Generated from `contracts/manifest.json` (contract status) and the TikTok-router controllers (simulator implementation). **No operation is `supported`**: the official Partner Center pages (Common parameters, scopes, error codes, webhook payloads) were not readable, so every operation stays `unverified` or `unsupported`. "implemented" means the simulator serves the route with the official-OAS shape; it does NOT prove real TikTok behaviour.

| Operation | Method | Path / topic | Contract status | Simulator |
|---|---|---|---|---|
| auth.shops | GET | /authorization/202309/shops | unverified | implemented |
| product.search | POST | /product/202502/products/search | unverified | implemented |
| product.detail | GET | /product/202309/products/{product_id} | unverified | implemented |
| product.media_upload | POST | /product/202309/images/upload | unverified | not implemented |
| product.file_upload | POST | /product/202309/files/upload | unverified | not implemented |
| logistics.warehouses | GET | /logistics/202309/warehouses | unverified | implemented |
| product.inventory_update | POST | /product/202309/products/{product_id}/inventory/update | unverified | implemented |
| order.search | POST | /order/202309/orders/search | unverified | implemented |
| order.detail | GET | /order/202507/orders | unverified | implemented |
| fulfillment.tracking | GET | /fulfillment/202309/orders/{order_id}/tracking | unverified | implemented |
| fulfillment.shipping_documents | GET | /fulfillment/202309/packages/{package_id}/shipping_documents | unverified | implemented |
| fulfillment.package_detail | GET | /fulfillment/202309/packages/{package_id} | unverified | implemented |
| fulfillment.package_ship | POST | /fulfillment/202309/packages/{package_id}/ship | unverified | implemented |
| return.search | POST | /return_refund/202309/returns/search | unverified | implemented |
| return.approve | POST | /return_refund/202309/returns/{return_id}/approve | unverified | implemented |
| return.reject | POST | /return_refund/202309/returns/{return_id}/reject | unverified | implemented |
| return.records | GET | /return_refund/202309/returns/{return_id}/records | unverified | implemented |
| return.reject_reasons | GET | /return_refund/202309/reject_reasons | unverified | implemented |
| return.aftersale_eligibility | GET | /return_refund/202512/orders/{order_id}/aftersale_eligibility | unverified | implemented |
| cancellation.search | POST | /return_refund/202309/cancellations/search | unverified | implemented |
| cancellation.approve | POST | /return_refund/202309/cancellations/{cancel_id}/approve | unverified | implemented |
| cancellation.reject | POST | /return_refund/202309/cancellations/{cancel_id}/reject | unverified | implemented |
| cs.conversations | GET | /customer_service/202309/conversations | unverified | implemented |
| cs.messages | GET | /customer_service/202309/conversations/{conversation_id}/messages | unverified | implemented |
| cs.conversation_detail | GET | /customer_service/202601/conversations/{conversation_id} | unverified | implemented |
| cs.send_message | POST | /customer_service/202606/conversations/{conversation_id}/messages | unverified | refused with 501 `unsupported_operation` (no schema snapshot) |
| cs.send_message_202309 | POST | /customer_service/202309/conversations/{conversation_id}/messages | unverified | implemented |
| cs.image_upload | POST | /customer_service/202309/images/upload | unverified | refused with 501 `unsupported_operation` (multipart signing unverified) |
| promotion.coupon_search | POST | /promotion/202406/coupons/search | unverified | implemented |
| promotion.coupon_detail | GET | /promotion/202406/coupons/{coupon_id} | unverified | implemented |
| event.webhooks_get | GET | /event/202309/webhooks | unverified | implemented |
| event.webhooks_put | PUT | /event/202309/webhooks | unverified | implemented |
| event.webhooks_delete | DELETE | /event/202309/webhooks | unverified | implemented |
| product.category_attributes | GET | /product/202309/categories/{category_id}/attributes | unverified | implemented |
| product.category_rules | GET | /product/202309/categories/{category_id}/rules | unverified | implemented |
| product.update_price | POST | /product/202309/products/{product_id}/prices/update | unverified | implemented |
| product.inventory_search | POST | /product/202309/inventory/search | unverified | implemented |
| product.delete | DELETE | /product/202309/products | unverified | implemented |
| product.recover | POST | /product/202309/products/recover | unverified | implemented |
| fulfillment.package_search | POST | /fulfillment/202309/packages/search | unverified | implemented |
| fulfillment.package_batch_ship | POST | /fulfillment/202309/packages/ship | unverified | implemented |
| return.create | POST | /return_refund/202309/returns | unverified | implemented |
| return.refund_calculate | POST | /return_refund/202309/refunds/calculate | unverified | implemented |
| cancellation.seller_cancel | POST | /return_refund/202309/cancellations | unverified | implemented |
| cs.read_message | POST | /customer_service/202309/conversations/{conversation_id}/messages/read | unverified | implemented |
| cs.create_conversation | POST | /customer_service/202309/conversations | unverified | implemented |
| auth.authorization_url | GET | (unknown) | unsupported | not implemented (unsupported/unknown contract) |
| auth.token_get | GET | /api/v2/token/get | unverified | implemented |
| auth.token_refresh | GET | /api/v2/token/refresh | unverified | implemented |
| return.rma_202604 | - | (unknown) | unsupported | not implemented (unsupported/unknown contract) |
| promotion.coupon_create | - | (none) | unsupported | not implemented (unsupported/unknown contract) |
| webhook.ORDER_STATUS_CHANGE | webhook (to SmartOmni) | ORDER_STATUS_CHANGE | unverified | emitted |
| webhook.RECIPIENT_ADDRESS_UPDATE | webhook (to SmartOmni) | RECIPIENT_ADDRESS_UPDATE | unverified | not emitted (no phase scope / unverified payload) |
| webhook.PACKAGE_UPDATE | webhook (to SmartOmni) | PACKAGE_UPDATE | unverified | emitted |
| webhook.CANCELLATION_STATUS_CHANGE | webhook (to SmartOmni) | CANCELLATION_STATUS_CHANGE | unverified | emitted |
| webhook.RETURN_STATUS_CHANGE | webhook (to SmartOmni) | RETURN_STATUS_CHANGE | unverified | emitted |
| webhook.REVERSE_STATUS_UPDATE | webhook (to SmartOmni) | REVERSE_STATUS_UPDATE | unverified | not emitted (no phase scope / unverified payload) |
| webhook.PRODUCT_STATUS_CHANGE | webhook (to SmartOmni) | PRODUCT_STATUS_CHANGE | unverified | not emitted (no phase scope / unverified payload) |
| webhook.SELLER_DEAUTHORIZATION | webhook (to SmartOmni) | SELLER_DEAUTHORIZATION | unverified | not emitted (no phase scope / unverified payload) |
| webhook.UPCOMING_AUTHORIZATION_EXPIRATION | webhook (to SmartOmni) | UPCOMING_AUTHORIZATION_EXPIRATION | unverified | not emitted (no phase scope / unverified payload) |
| webhook.NEW_CONVERSATION | webhook (to SmartOmni) | NEW_CONVERSATION | unverified | emitted |
| webhook.NEW_MESSAGE | webhook (to SmartOmni) | NEW_MESSAGE | unverified | emitted |

31 HTTP operations implemented (2 more routes exist only to refuse explicitly) of 38 listed.

## Blocked or unsupported on purpose

- `auth.authorization_url`: unsupported (URL not in readable sources); the simulator uses its own consent page.
- `promotion.coupon_create`: unsupported and locked: no create route exists; coupons are created only through `/demo`.
- `return.rma_202604`: unsupported; it does not replace Search Returns.
- `cs.send_message` (202606): no schema snapshot; 202309 is implemented instead.
- Upload operations (`product.media_upload`, `product.file_upload`, `cs.image_upload`): multipart signing unverified; refused explicitly.
- SmartOmni-side items of phases 05-09: BLOCKED in this repo (see `docs/smartomni-requirements/`).
