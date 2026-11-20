# cURL samples (unverified: official-OAS schemas, docv2/scopes/error codes unread)

Schemas, params and fixtures come from the official bundled OAS (see `../contracts/README.md`); every operation is still `unverified`. Per-operation expected bodies: `../contracts/fixtures/ops/<operation-id>.json` (case `success`). Signing rule and its (indirect) evidence: `../contracts/signing/README.md`. Uploads (multipart) cannot be signed: rule unverified, so no upload sample.

Environment (no real secrets; export in your shell, do not commit):

```bash
export BASE_URL=http://localhost:8090
export APP_KEY=test_app_key_not_real
export APP_SECRET=test_app_secret_not_real
export ACCESS_TOKEN=test_access_token_not_real
export SHOP_CIPHER=TEST_CIPHER_0001
```

Signing helper (GET and JSON body). `StringToSign = secret + path + sorted(name+value excluding sign/access_token) + raw body + secret`. Pass the query as `name=value` words already in sorted order (this helper does not sort):

```bash
# usage: sign_api <path> <body-or-empty> <sorted name=value> ...
sign_api() {
  local path="$1" body="$2"; shift 2
  local s="${APP_SECRET}${path}"
  for kv in "$@"; do s="${s}${kv%%=*}${kv#*=}"; done
  printf '%s' "${s}${body}${APP_SECRET}" | openssl dgst -sha256 -hmac "$APP_SECRET" | awk '{print $NF}'
}
```

## GET authorized shops (`auth.shops`, GET /authorization/202309/shops)

```bash
P=/authorization/202309/shops; TS=$(date +%s)
SIGN=$(sign_api "$P" "" app_key=$APP_KEY timestamp=$TS)
curl -s "${BASE_URL}${P}?app_key=${APP_KEY}&timestamp=${TS}&access_token=${ACCESS_TOKEN}&sign=${SIGN}" \
  -H "x-tts-access-token: ${ACCESS_TOKEN}" -H "Content-Type: application/json"
```

With the fixed values `timestamp=1700000000`, no `shop_cipher` and no `version` the digest equals vector 1 in `contracts/signing/test-vectors.json`.

## GET order detail (`order.detail`, GET /order/202507/orders, required query `ids`)

```bash
P=/order/202507/orders; TS=$(date +%s); IDS=576000000000000001
SIGN=$(sign_api "$P" "" app_key=$APP_KEY ids=$IDS shop_cipher=$SHOP_CIPHER timestamp=$TS)
curl -s "${BASE_URL}${P}?app_key=${APP_KEY}&timestamp=${TS}&ids=${IDS}&shop_cipher=${SHOP_CIPHER}&access_token=${ACCESS_TOKEN}&sign=${SIGN}" \
  -H "x-tts-access-token: ${ACCESS_TOKEN}" -H "Content-Type: application/json"
```

## POST with a JSON body (`product.search`, POST /product/202502/products/search, required query `page_size` 1-100)

The raw body enters the signature after the sorted query and before the trailing secret. Sign and send byte-identical text:

```bash
P=/product/202502/products/search; TS=$(date +%s)
BODY='{"status":"ACTIVATE"}'
SIGN=$(sign_api "$P" "$BODY" app_key=$APP_KEY page_size=10 shop_cipher=$SHOP_CIPHER timestamp=$TS)
curl -s -X POST "${BASE_URL}${P}?app_key=${APP_KEY}&timestamp=${TS}&page_size=10&shop_cipher=${SHOP_CIPHER}&access_token=${ACCESS_TOKEN}&sign=${SIGN}" \
  -H "x-tts-access-token: ${ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary "$BODY"
```

Next page: repeat with `page_token=<next_page_token from the previous response>` (add it to both the signature and the URL, sorted by name). The last page returns `next_page_token: ""`.

## PUT webhook address (`event.webhooks_put`, PUT /event/202309/webhooks)

```bash
P=/event/202309/webhooks; TS=$(date +%s)
BODY='{"address":"https://example.test/hook","event_type":"ORDER_STATUS_CHANGE"}'
SIGN=$(sign_api "$P" "$BODY" app_key=$APP_KEY shop_cipher=$SHOP_CIPHER timestamp=$TS)
curl -s -X PUT "${BASE_URL}${P}?app_key=${APP_KEY}&timestamp=${TS}&shop_cipher=${SHOP_CIPHER}&access_token=${ACCESS_TOKEN}&sign=${SIGN}" \
  -H "x-tts-access-token: ${ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary "$BODY"
```

`DELETE /event/202309/webhooks` also carries a JSON body `{"event_type": "..."}` (per the OAS); sign it the same way.

## Webhook delivery check (`webhook.ORDER_STATUS_CHANGE`; envelope provisional, signature = SmartOmni's rule, see DECISIONS.md D9)

`Authorization` = hex `HMAC-SHA256(app_secret, app_secret + path + timestamp + raw body)`, where `path` is the pathname of `$CALLBACK_URL` and `timestamp` is the `timestamp` header (real time; SmartOmni rejects more than 5 minutes of skew):

```bash
CALLBACK_URL=http://localhost:8080/api/v1/integrations/tiktok/webhooks
CB_PATH=/api/v1/integrations/tiktok/webhooks; TS=$(date +%s)
BODY='{"type":1,"tts_notification_id":"test-notification-0001","shop_id":"7000000000000000001","timestamp":1700000000,"data":{"order_id":"576000000000000001","order_status":"AWAITING_SHIPMENT"}}'
SIG=$(printf '%s' "${APP_SECRET}${CB_PATH}${TS}${BODY}" | openssl dgst -sha256 -hmac "$APP_SECRET" | awk '{print $NF}')
curl -i -X POST "$CALLBACK_URL" -H "Authorization: ${SIG}" -H "timestamp: ${TS}" -H "Content-Type: application/json" --data-binary "$BODY"
```

Error and edge cases (invalid input, expired token, missing scope) are test faults without documented codes; see `../contracts/fixtures/errors.json`.

## Phase 05-09 additions (simulator behaviour on unverified contracts)

Use the same `sign_api` helper. All of these need a token that holds the matching placeholder scope (`sim.order.read`, `sim.event.manage`, `sim.inventory.write`, `sim.fulfillment.*`, `sim.aftersale.*`, `sim.conversation.*`, `sim.promotion.read`; see `backend/src/oauth/scopes.ts`).

```bash
# Orders: search (page_size required; sort_field create_time|update_time; sort_order ASC|DESC; body filters)
P=/order/202309/orders/search; TS=$(date +%s); BODY='{"order_status":"AWAITING_SHIPMENT"}'
SIGN=$(sign_api "$P" "$BODY" app_key=$APP_KEY page_size=20 shop_cipher=$SHOP_CIPHER sort_order=ASC timestamp=$TS)
curl -s -X POST "${BASE_URL}${P}?app_key=${APP_KEY}&timestamp=${TS}&page_size=20&sort_order=ASC&shop_cipher=${SHOP_CIPHER}&sign=${SIGN}" \
  -H "x-tts-access-token: ${ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary "$BODY"

# Subscribe to order events (the receiver verifies Authorization = HMAC-SHA256(app_secret, app_secret + path + timestamp + raw body))
P=/event/202309/webhooks; TS=$(date +%s); BODY='{"event_type":"ORDER_STATUS_CHANGE","address":"http://localhost:8080/webhook"}'
SIGN=$(sign_api "$P" "$BODY" app_key=$APP_KEY shop_cipher=$SHOP_CIPHER timestamp=$TS)
curl -s -X PUT "${BASE_URL}${P}?app_key=${APP_KEY}&timestamp=${TS}&shop_cipher=${SHOP_CIPHER}&sign=${SIGN}" \
  -H "x-tts-access-token: ${ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary "$BODY"

# Absolute inventory update (retry-safe: sets the quantity, never decrements)
P=/product/202309/products/$PRODUCT_ID/inventory/update; TS=$(date +%s)
BODY="{\"skus\":[{\"id\":\"$SKU_ID\",\"inventory\":[{\"warehouse_id\":\"$WAREHOUSE_ID\",\"quantity\":12}]}]}"
SIGN=$(sign_api "$P" "$BODY" app_key=$APP_KEY shop_cipher=$SHOP_CIPHER timestamp=$TS)
curl -s -X POST "${BASE_URL}${P}?app_key=${APP_KEY}&timestamp=${TS}&shop_cipher=${SHOP_CIPHER}&sign=${SIGN}" \
  -H "x-tts-access-token: ${ACCESS_TOKEN}" -H "Content-Type: application/json" --data-binary "$BODY"
```

Test Console / admin calls (token from your `.env`):

```bash
curl -s -X POST http://localhost:8090/test-admin/orders/release-due -H "x-test-admin-token: $TEST_ADMIN_TOKEN"
curl -s -X POST http://localhost:8090/test-admin/faults -H "x-test-admin-token: $TEST_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"target":"WEBHOOK","kind":"REORDER","pathMatch":"ORDER_STATUS_CHANGE","remaining":1,"params":{"holdMs":60000}}'
curl -s -X POST http://localhost:8090/test-admin/scenarios/loyalty-orders -H "x-test-admin-token: $TEST_ADMIN_TOKEN" -H "content-type: application/json" -d '{"shopId":"<shop row id>"}'
```
