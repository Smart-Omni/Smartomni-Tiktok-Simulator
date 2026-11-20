# Phase 05 - SmartOmni-side requirements (not implemented here)

The simulator side is implemented in this repo. The items below belong to the SmartOmni platform repo (reference only for this work) and are BLOCKED here. Contract facts they rely on are all `unverified` in `contracts/manifest.json`.

1. **Webhook receiver** (Integration): verify `Authorization` = lowercase hex `HMAC_SHA256(app_secret, app_secret + path + timestamp + raw body)` on the raw bytes before parsing (`path` = request path, `timestamp` = the `timestamp` header, at most 5 minutes from real time; this is what `WebhookHmacValidator.validateTikTokWebhook` already does, see DECISIONS.md D9); reject with 401 otherwise; do not enqueue business work for bad signature/payload. Take the app secret from `TiktokProperties` (TikTok connections have a null `app_secret_encrypted`). Resolve the tenant from the connection linked to `shop_id` (never from the body).
2. **Idempotency**: dedupe on `tts_notification_id` with a unique constraint; upsert orders by (tenant, connection, external order id); two concurrent webhooks must create one order.
3. **Event mapping**: `data.order_id`, `data.order_status`, `data.update_time`; call Get Order Detail (`GET /order/202507/orders?ids=`) for the full order; map `line_items[].sku_id` to internal SKUs through the Phase 04 link table; unmapped SKUs park the order for reconciliation (never "first SKU").
4. **No state regression**: keep the source status and `update_time`; ignore an event whose `update_time` is older than the stored one (simulate with the REORDER fault in the Test Console).
5. **Polling backfill** (Quartz): `POST /order/202309/orders/search` with `update_time_ge` (inclusive) / `update_time_lt` (exclusive) windows and `page_token`; advance the checkpoint only after the page is durably stored.
6. **Stock debit request**: idempotency key per (order, line); retry after timeout must not debit twice (Phase 06 executes it).
7. **Local guards**: block local "completed/returned" marking that contradicts the marketplace status.
