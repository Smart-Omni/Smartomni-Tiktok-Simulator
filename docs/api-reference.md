# Tài liệu API: SmartOmni TikTok Shop Simulator

Tài liệu này mô tả toàn bộ HTTP API của simulator (backend NestJS, cổng `8090`): cách xác thực, cách ký request, định dạng phản hồi và lỗi, webhook, lỗi giả lập, cùng tham chiếu đầy đủ cho 172 operation.

**Nguồn sự thật.** Phần tham chiếu (mục 7 đến 11) được sinh từ `docs/openapi.json` tại commit `c09a274` và **không tự cập nhật**: khi route thay đổi, cần sinh lại phần này. `docs/openapi.json` do `backend/src/openapi/` tạo và được `backend/test/openapi.e2e-spec.ts` đối chiếu với route thật. Phần mô tả chung (mục 1 đến 6) được viết từ mã nguồn trong `backend/src/`. Khi tài liệu này và mã nguồn khác nhau, mã nguồn đúng. Trong phần tham chiếu, tiêu đề và tóm tắt viết bằng tiếng Việt; cột mô tả tham số, trường body, mô tả mã phản hồi và ghi chú kỹ thuật được trích nguyên văn (tiếng Anh) từ OpenAPI để không sai lệch khi dịch.

> **Lưu ý quan trọng.** Simulator mô phỏng hình dạng API của TikTok Shop, nhưng mọi operation vẫn ở trạng thái `unverified` trong `contracts/manifest.json`. Tên scope (`sim.*`), mã lỗi, URL trang đồng ý và thân lỗi đều do simulator tự định nghĩa, không phải giá trị thật của TikTok. Các sai khác có chủ đích được ghi trong `DECISIONS.md`.

## Mục lục

1. [Tổng quan](#1-tổng-quan)
2. [Luồng tích hợp nhanh cho SmartOmni](#2-luồng-tích-hợp-nhanh-cho-smartomni)
3. [Ký request (router TikTok)](#3-ký-request-router-tiktok)
4. [OAuth, token và scope](#4-oauth-token-và-scope)
5. [Phản hồi, lỗi và phân trang](#5-phản-hồi-lỗi-và-phân-trang)
6. [Mô hình nghiệp vụ: đơn hàng, đồng hồ, webhook, lỗi giả lập](#6-mô-hình-nghiệp-vụ)
7. [Tham chiếu endpoint: router TikTok](#7-tham-chiếu-endpoint-router-tiktok)
8. [Tham chiếu endpoint: `/demo/*`](#8-tham-chiếu-endpoint-demo)
9. [Tham chiếu endpoint: `/test-admin/*`](#9-tham-chiếu-endpoint-test-admin)
10. [Endpoint giả lập ngoài ba router](#10-endpoint-giả-lập-ngoài-ba-router)
11. [Health check](#11-health-check)
12. [Tài liệu liên quan](#12-tài-liệu-liên-quan)

## 1. Tổng quan

### 1.1. Địa chỉ gốc

| Môi trường | Base URL | Ghi chú |
|---|---|---|
| API trực tiếp (Docker hoặc `npm start`) | `http://localhost:8090` | SmartOmni gọi thẳng vào đây. |
| Qua UI (nginx trong Docker, hoặc Vite dev) | `http://localhost:3090` | Cùng origin với UI; proxy `/demo`, `/test-admin`, `/health` sang `:8090`. Proxy **tự chèn** header `x-test-admin-token`, nên trình duyệt và Playwright không cần giữ token admin. |
| Swagger UI | `http://localhost:8090/api-docs` | "Try it out" không tự tính được `sign`; dùng curl mẫu hoặc Postman cho request cần ký. |

Request và response dùng JSON (`Content-Type: application/json`), trừ ba endpoint upload `multipart/form-data` và hai endpoint trả file (PDF nhãn vận chuyển, ảnh).

### 1.2. Ba router trên cùng một API

Ba nhóm route được tách riêng có chủ đích. `backend/test/routers.e2e-spec.ts` kiểm tra rằng router TikTok không import module của `/demo` hay `/test-admin`.

| Router | Tiền tố | Ai gọi | Xác thực |
|---|---|---|---|
| **TikTok** | `/api/v2/token/*`, `/authorization/*`, `/product/*`, `/order/*`, `/fulfillment/*`, `/logistics/*`, `/return_refund/*`, `/customer_service/*`, `/promotion/*`, `/event/*` | SmartOmni (thay cho TikTok Shop thật) | Ký request + `x-tts-access-token` (mục 3). Riêng hai endpoint token dùng `app_key` + `app_secret`. |
| **Demo** | `/demo/*` | UI Seller Center và Buyer (Tiptop Shop) | Header `x-demo-session` (một số endpoint công khai) |
| **Test admin** | `/test-admin/*` | Test Console, Playwright, người kiểm thử | Header `x-test-admin-token` = biến môi trường `TEST_ADMIN_TOKEN` |

Ngoài ra còn hai nhóm nhỏ: `/health/*` (không xác thực) và các endpoint giả lập `/api/v2/media/upload`, `/api/v2/simulator/dispute*` (không xác thực, mục 10).

Đường dẫn không tồn tại trả `404` mặc định của NestJS. Simulator không giả vờ hỗ trợ endpoint mà nó không có.

### 1.3. Header dùng chung

| Header | Hướng | Ý nghĩa |
|---|---|---|
| `x-request-id` | request, response | Gửi kèm (tối đa 100 ký tự `[\w.:-]`) để theo dõi; nếu không gửi, server tự sinh UUID. Luôn được trả lại trong response, ghi vào `HttpRequestLog` và nằm trong trường `request_id` của envelope TikTok. |
| `x-tts-access-token` | request | Access token cho router TikTok. |
| `x-demo-session` | request | Token phiên demo (mục 1.4). |
| `x-test-admin-token` | request | Token admin. |

Mọi request (trừ health probe và các lần console đọc định kỳ) được lưu vào `HttpRequestLog`. Token, secret, chữ ký, header authorization và token phiên bị che (`backend/src/common/redaction.ts`) **trước khi** lưu.

### 1.4. Phiên demo (`x-demo-session`)

1. `GET /demo/identities` liệt kê seller và buyer có thể đăng nhập.
2. `POST /demo/sessions` với `{"role":"SELLER","sellerId":"...","shopId":"..."}` hoặc `{"role":"BUYER","buyerId":"..."}` trả `sessionToken`. Token chỉ được trả **một lần**; DB chỉ lưu SHA-256 của nó.
3. Gửi token trong header `x-demo-session`. Phiên sống `DEMO_SESSION_TTL_MS` (mặc định 8 giờ).
4. `DELETE /demo/sessions/current` để đăng xuất.

Quy tắc truy cập: phiên **SELLER** chỉ truy cập shop của chính mình (shop khác trả `403`). Phiên **BUYER** truy cập được mọi shop đang `ACTIVE` trên marketplace (mua hàng chéo shop). UI lưu token trong sessionStorage với khóa `sim.demo-session.{ROLE}`. Phiên demo **không** liên quan đến đăng nhập SmartOmni hay xác thực TikTok.

## 2. Luồng tích hợp nhanh cho SmartOmni

SmartOmni chỉ cần đổi base URL và thông tin app để trỏ vào simulator:

| Cấu hình SmartOmni | Giá trị |
|---|---|
| Base URL API TikTok | `http://localhost:8090` |
| URL trang ủy quyền | `http://localhost:3090/seller/authorize` |
| `app_key` / `app_secret` | `SEED_APP_KEY` / `SEED_APP_SECRET` trong `.env` của simulator |
| Redirect URI | phải nằm trong `SEED_APP_REDIRECT_URIS` (so khớp chính xác) |

Các bước:

1. **Ủy quyền.** Mở `http://localhost:3090/seller/authorize?app_key=<key>&state=<state>[&redirect_uri=<uri đã đăng ký>]`. Seller demo đăng nhập, xem shop và scope rồi bấm đồng ý hoặc từ chối. Trang này gọi `GET`/`POST /demo/authorization/consent`.
2. **Callback.** Trình duyệt được chuyển về redirect URI với `?code=<auth_code>&state=<state>`, hoặc `?error=access_denied&state=<state>` nếu seller từ chối. Mỗi code chỉ dùng được một lần và sống `OAUTH_AUTH_CODE_TTL_MS` (mặc định 5 phút).
3. **Đổi token.** `GET /api/v2/token/get?app_key=...&app_secret=...&auth_code=...&grant_type=authorized_code` trả `access_token`, `refresh_token` và hai mốc hết hạn.
4. **Gọi API.** Ký mọi request (mục 3) và gửi `x-tts-access-token`. Gọi `GET /authorization/202309/shops` trước để lấy `shop_cipher`.
5. **Đăng ký webhook.** `PUT /event/202309/webhooks` với `{"event_type":"ORDER_STATUS_CHANGE","address":"<url nhận>"}`, lặp lại cho từng topic cần nghe.
6. **Làm mới token.** Trước khi access token hết hạn, gọi `GET /api/v2/token/refresh?app_key=...&app_secret=...&refresh_token=...`. Cả hai token đều được xoay vòng; refresh token cũ mất hiệu lực ngay.

## 3. Ký request (router TikTok)

Mọi endpoint của router TikTok, trừ `/api/v2/token/get` và `/api/v2/token/refresh`, yêu cầu:

| Vị trí | Tên | Bắt buộc | Mô tả |
|---|---|---|---|
| query | `app_key` | có | App key đã seed |
| query | `timestamp` | có | Unix **giây** (chỉ chữ số, tối đa 12 ký tự) |
| query | `sign` | có | Chữ ký HMAC, hex |
| query | `shop_cipher` | không | Nếu gửi thì phải đúng shop của access token, sai thì `403 shop_cipher_mismatch` |
| header | `x-tts-access-token` | có | Access token |

### 3.1. Thuật toán

```text
string_to_sign = app_secret
               + path                      (không kèm query, ví dụ /order/202309/orders/search)
               + với mỗi tham số query, trừ `sign` và `access_token`, sắp xếp theo tên tăng dần: name + value
               + raw_body                  (đúng từng byte đã gửi; rỗng nếu không có body)
               + app_secret

sign = hex( HMAC-SHA256(key = app_secret, message = string_to_sign) )
```

Quy tắc chi tiết (`backend/src/tiktok/signature.ts`, `tiktok-api.guard.ts`):

- Query được đọc từ URL thô, không qua parser `qs` của Express. Một tên tham số lặp lại hai lần làm request bị từ chối (`400 invalid_input`), vì chuỗi ký sẽ không rõ ràng.
- Body được ký đúng như byte nhận được. Hãy ký và gửi cùng một chuỗi (ví dụ dùng `--data-binary` với curl), đừng serialize JSON hai lần.
- `timestamp` được so với **AuthClock** (giờ thật, không bị `/test-admin/clock` ảnh hưởng). Lệch quá `OAUTH_SIGNATURE_WINDOW_MS` (mặc định 5 phút) theo cả hai hướng (quá khứ hoặc tương lai) thì trả `401 stale_timestamp`.
- So sánh chữ ký dùng thời gian hằng (timing-safe) và không phân biệt hoa thường.

Thứ tự kiểm tra của guard: đủ tham số bắt buộc → `app_key` tồn tại → `timestamp` → chữ ký → access token (tồn tại, chưa thu hồi, chưa hết hạn) → token thuộc đúng app → scope của operation → `shop_cipher` (nếu có). Không có đường tắt nào chỉ dành cho simulator.

### 3.2. Ví dụ đối chiếu (test vector 1)

Lấy từ `contracts/signing/test-vectors.json`; dùng để kiểm tra phần cài đặt của bạn:

| | Giá trị |
|---|---|
| `app_secret` | `test_app_secret_not_real` |
| path | `/authorization/202309/shops` |
| query | `app_key=test_app_key_not_real`, `timestamp=1700000000` (cộng `access_token`, `sign`, cả hai bị bỏ qua) |
| body | rỗng |
| `string_to_sign` | `test_app_secret_not_real/authorization/202309/shopsapp_keytest_app_key_not_realtimestamp1700000000test_app_secret_not_real` |
| `sign` | `cb9b186515f05b8801458ccdc53e778fdbb129678979f21548d9629c1d823284` |

### 3.3. Mã mẫu (Node.js)

```js
const { createHmac } = require('crypto');

function sign(appSecret, path, query, rawBody = '') {
  const keys = Object.keys(query).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  const s = appSecret + path + keys.map((k) => k + query[k]).join('') + rawBody + appSecret;
  return createHmac('sha256', appSecret).update(s).digest('hex');
}

// POST /order/202309/orders/search?page_size=20
const path = '/order/202309/orders/search';
const body = JSON.stringify({ order_status: 'AWAITING_SHIPMENT' });
const query = { app_key: APP_KEY, timestamp: String(Math.floor(Date.now() / 1000)), page_size: '20', shop_cipher: SHOP_CIPHER };
query.sign = sign(APP_SECRET, path, query, body);
await fetch(`http://localhost:8090${path}?${new URLSearchParams(query)}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-tts-access-token': ACCESS_TOKEN },
  body, // đúng chuỗi đã ký
});
```

Mẫu curl cho shell có trong `docs/curl-samples.md`; collection Postman ở `docs/postman-collection.json`.

## 4. OAuth, token và scope

### 4.1. Vòng đời token

| Thành phần | Thời gian sống (mặc định) | Biến môi trường |
|---|---|---|
| Auth code | 5 phút, dùng một lần | `OAUTH_AUTH_CODE_TTL_MS` |
| Access token | 1 giờ | `OAUTH_ACCESS_TOKEN_TTL_MS` |
| Refresh token | 30 ngày | `OAUTH_REFRESH_TOKEN_TTL_MS` |
| Cửa sổ `timestamp` khi ký | ±5 phút | `OAUTH_SIGNATURE_WINDOW_MS` |

Phản hồi của `/api/v2/token/get` và `/api/v2/token/refresh`:

```json
{
  "code": 0,
  "message": "success",
  "request_id": "…",
  "data": {
    "access_token": "…",
    "access_token_expire_in": 1763640000,
    "refresh_token": "…",
    "refresh_token_expire_in": 1766228400,
    "open_id": "…"
  }
}
```

- `access_token_expire_in` và `refresh_token_expire_in` là **mốc thời gian tuyệt đối** (Unix giây), không phải số giây còn lại. Điều này chưa được xác nhận với TikTok.
- Refresh xoay vòng cả hai token. Nếu hai request dùng cùng một refresh token cùng lúc, chỉ một request thành công; request còn lại nhận `400 refresh_token_invalid`.
- `grant_type` được chấp nhận nhưng không bị kiểm tra.
- DB chỉ lưu hash SHA-256 của token. Token cấp trước khi restart vẫn dùng được.
- Thu hồi ủy quyền: app tự gọi `DELETE /authorization/202403/shops` (request có ký; thu hồi mọi token đang hoạt động của app với shop đó và phát webhook `SELLER_DEAUTHORIZATION` với `reason: "DEAUTHORIZED_BY_APP"`), hoặc người kiểm thử giả lập seller gỡ app bằng `POST /test-admin/tokens/{id}/revoke`. Sau đó gọi API trả `401 authorization_revoked`, refresh trả `400 authorization_revoked`.

### 4.2. Scope

Scope là **giá trị giữ chỗ do simulator đặt** (tiền tố `sim.`), không phải tên scope thật của TikTok. App seed mặc định được cấp tất cả scope sau (đổi bằng `SEED_APP_SCOPES`):

| Scope | Dùng cho |
|---|---|
| `sim.authorized_shops.read` | Danh sách shop đã ủy quyền |
| `sim.product.read` / `sim.product.write` | Đọc / ghi sản phẩm, danh mục, thương hiệu |
| `sim.order.read` | Đơn hàng |
| `sim.event.manage` | Đăng ký webhook |
| `sim.inventory.write` | Cập nhật tồn kho |
| `sim.fulfillment.read` / `sim.fulfillment.write` | Kiện hàng, tracking, nhãn / giao kiện |
| `sim.aftersale.read` / `sim.aftersale.write` | Hủy đơn, trả hàng, hoàn tiền |
| `sim.conversation.read` / `sim.conversation.write` | Chat CSKH |
| `sim.promotion.read` | Coupon |

Scope yêu cầu của từng endpoint nằm ở dòng **Scope** trong phần tham chiếu. Token cấp trước khi một scope được thêm vào sẽ không có scope đó (`403 missing_scope`); seller cần ủy quyền lại.

## 5. Phản hồi, lỗi và phân trang

### 5.1. Router TikTok: thành công

```json
{ "code": 0, "message": "Success", "request_id": "…", "data": { … } }
```

Hai endpoint token trả `"message": "success"` (chữ thường). Đừng so sánh `message`; hãy kiểm tra `code === 0`.

### 5.2. Router TikTok: lỗi

Mã lỗi thật của TikTok chưa được công bố, nên simulator **không bịa** mã. Mọi lỗi dùng cùng hình dạng envelope với `code = -1` (giá trị riêng của simulator), cùng khối `simulator_fault`:

```json
{
  "code": -1,
  "message": "[simulator test-fault] access token has expired",
  "request_id": "…",
  "simulator_fault": {
    "kind": "token_expired",
    "documented_in_tiktok_contract": false,
    "listed_in_contract_fixtures": true
  }
}
```

**Phía client nên rẽ nhánh theo HTTP status + `simulator_fault.kind`, không theo `code`.**

| `kind` | HTTP | Khi nào |
|---|---|---|
| `invalid_input` | 400 | Thiếu tham số bắt buộc, tham số lặp, sai kiểu, filter không hỗ trợ |
| `unknown_app_key` | 401 | `app_key` không tồn tại |
| `stale_timestamp` | 401 | `timestamp` ngoài cửa sổ cho phép |
| `bad_signature` | 401 | Chữ ký sai |
| `token_invalid` | 401 / 403 | Token không nhận ra (401) hoặc cấp cho app khác (403) |
| `token_expired` | 401 | Access token hết hạn |
| `authorization_revoked` | 401 / 400 | Seller đã hủy ủy quyền (400 khi refresh) |
| `missing_scope` | 403 | Token thiếu scope của operation |
| `shop_cipher_mismatch` | 403 | `shop_cipher` không thuộc shop của token |
| `invalid_app_credentials` | 401 | `app_key`/`app_secret` sai (endpoint token) |
| `auth_code_invalid` / `auth_code_expired` / `auth_code_used` | 400 | Auth code sai app, hết hạn hoặc đã dùng |
| `refresh_token_invalid` / `refresh_token_expired` | 400 | Refresh token sai, đã dùng hoặc hết hạn |
| `product_not_found`, `order_not_found`, `package_not_found`, `warehouse_not_found`, `delivery_option_not_found`, `conversation_not_found`, `coupon_not_found`, `aftersale_not_found` | 404 | Không tìm thấy tài nguyên trong shop của token |
| `package_not_arranged`, `order_not_shippable`, `cannot_send_message`, `invalid_decision` | 400 | Vi phạm quy tắc nghiệp vụ (xem phần tham chiếu) |
| `unsupported_operation` | 501 | Operation được khai báo nhưng chưa hỗ trợ |

Chỉ bốn kind `invalid_input`, `token_expired`, `missing_scope`, `bad_signature` có trong `contracts/fixtures/errors.json`. Các kind còn lại do simulator thêm.

**Ngoại lệ:** lỗi tiêm bằng luật `HTTP_ERROR` (mục 6.5) trả thân `{"simulatorFault": true, "message": "Injected by /test-admin/faults", "status": <status>}`, **không** theo envelope trên. Lỗi `APP_ERROR_200` của cập nhật tồn kho trả HTTP `200` với `code: -1`.

### 5.3. `/demo/*` và `/test-admin/*`: lỗi

Hai router này dùng thân lỗi mặc định của NestJS:

```json
{ "statusCode": 403, "message": "This session cannot access another shop", "error": "Forbidden" }
```

- Lỗi validate (zod) trả `400`: `{"message": "Validation failed", "issues": [{"path": "skus.0.priceVnd", "message": "…"}]}`.
- Lỗi quy tắc nghiệp vụ trả `{"code": "invalid_transition", "message": "…"}` (không có `statusCode`/`error`).
- Thiếu hoặc sai `x-demo-session` / `x-test-admin-token` trả `401`.

### 5.4. Phân trang (router TikTok)

Các endpoint `.../search` dùng phân trang keyset:

- `page_size` (bắt buộc, 1 đến 100) và `page_token` (không bắt buộc) trên query. Cả hai cũng đi vào chuỗi ký.
- Response có `data.next_page_token`. Trang cuối trả `""`.
- `page_token` là chuỗi mờ (base64url JSON). Token sinh ra cho một kiểu sắp xếp khác, hoặc bị sửa, trả `400 invalid_input`.
- Bộ lọc thời gian: `*_ge` bao gồm mốc, `*_lt` không bao gồm, đều tính bằng Unix giây.

## 6. Mô hình nghiệp vụ

### 6.1. Trạng thái đơn hàng

Bảng chuyển trạng thái là mô hình của simulator (OAS chỉ liệt kê trạng thái, không có quy tắc chuyển), nằm trong `backend/src/orders/order-state.ts`:

| Từ | Có thể sang |
|---|---|
| `UNPAID` | `ON_HOLD`, `CANCELLED` |
| `ON_HOLD` | `AWAITING_SHIPMENT`, `CANCELLED` |
| `AWAITING_SHIPMENT` | `PARTIALLY_SHIPPING`, `AWAITING_COLLECTION`, `CANCELLED` |
| `PARTIALLY_SHIPPING` | `AWAITING_COLLECTION`, `CANCELLED` |
| `AWAITING_COLLECTION` | `IN_TRANSIT`, `CANCELLED` |
| `IN_TRANSIT` | `DELIVERED` |
| `DELIVERED` | `COMPLETED` |
| `COMPLETED`, `CANCELLED` | (trạng thái cuối) |

- Thanh toán đưa đơn sang `ON_HOLD`. Đơn giữ ở đó `ORDER_HOLD_MINUTES` phút (mặc định 30, tính theo đồng hồ nghiệp vụ), rồi được giải phóng sang `AWAITING_SHIPMENT` bởi timer nền (`ORDER_LIFECYCLE_INTERVAL_MS`) hoặc `POST /test-admin/orders/release-due`. Đơn `ON_HOLD` chưa giao được.
- `recipient_address` không có trong response khi đơn ở `UNPAID`/`ON_HOLD`.
- Checkout idempotent theo `checkoutKey`: gửi lại cùng key trả về đúng đơn cũ.
- Kiện hàng (fulfillment) đi theo trạng thái đơn thông qua listener chạy trong cùng transaction DB.
- Mọi thay đổi trạng thái được ghi lịch sử (xem `GET /demo/shops/{shopId}/orders/{orderId}`, `GET /test-admin/orders/{ref}/audit`).

### 6.2. Tồn kho

- Checkout **giữ chỗ** tồn kho; hủy đơn **hoàn lại** tồn kho.
- `POST /product/202309/products/{productId}/inventory/update` đặt **số lượng tuyệt đối** cho từng (SKU, kho), không cộng trừ, nên gọi lại an toàn.
- Mỗi thay đổi ghi một dòng `InventoryChange` trong cùng transaction, dưới khóa dòng. Lịch sử xem ở `/demo/shops/{shopId}/inventory/history` hoặc `/test-admin/inventory/history`.

### 6.3. Hai đồng hồ

| Đồng hồ | Dùng cho | Điều khiển được? |
|---|---|---|
| **BusinessClock** | Mốc thời gian nghiệp vụ: tạo/cập nhật đơn, hạn giữ đơn, hạn trả hàng (`RETURN_WINDOW_DAYS`, mặc định 15), timestamp trong webhook | Có: `PUT /test-admin/clock` (`setTo`, `advanceMs`, `freeze`, `reset`). Offset lưu trong DB nên không mất khi restart. |
| **AuthClock** | Hạn token, auth code, cửa sổ `timestamp` khi ký | Không, luôn là giờ thật |

Lease và lịch gửi lại của worker webhook cũng dùng giờ thật.

### 6.4. Webhook

**Đăng ký.** `PUT /event/202309/webhooks` với `event_type` và `address`. Chỉ topic đã đăng ký mới được gửi. Topic chấp nhận: `ORDER_STATUS_CHANGE`, `INVENTORY_CHANGED_BY_SHOP`, `RECIPIENT_ADDRESS_UPDATE`, `PACKAGE_UPDATE`, `PRODUCT_STATUS_CHANGE`, `SELLER_DEAUTHORIZATION`, `UPCOMING_AUTHORIZATION_EXPIRATION`, `CANCELLATION_STATUS_CHANGE`, `RETURN_STATUS_CHANGE`, `NEW_CONVERSATION`, `NEW_MESSAGE`, `PRODUCT_INFORMATION_CHANGE`, `PRODUCT_CREATION`, `PRODUCT_CATEGORY_CHANGE`, `NEW_MESSAGE_LISTENER`, `INVOICE_STATUS_CHANGE`, `PRODUCT_AUDIT_STATUS_CHANGE`, `REVERSE_STATUS_UPDATE`, `DISPUTE_STATUS_CHANGE`.

**Envelope.**

```json
{
  "type": 1,
  "tts_notification_id": "1f0c…-uuid",
  "shop_id": "7000000000000000001",
  "timestamp": 1763600000,
  "data": { "order_id": "576…", "order_status": "AWAITING_SHIPMENT", "is_on_hold_order": false, "update_time": 1763600000 }
}
```

`timestamp` lấy theo BusinessClock. Giá trị `type` theo topic (`backend/src/webhooks/webhook-emitter.service.ts`). Chỉ `type` 1 là đã đối chiếu được với nguồn; các giá trị khác chưa xác minh:

| Topic thực sự được phát | `type` | Nguồn phát |
|---|---|---|
| `ORDER_STATUS_CHANGE` | 1 | Tạo đơn, mỗi lần đổi trạng thái |
| `PACKAGE_UPDATE` | 3 | Đổi trạng thái kiện |
| `REVERSE_STATUS_UPDATE` | 4 | Hậu mãi (cùng lúc với `RETURN_STATUS_CHANGE`) |
| `PRODUCT_STATUS_CHANGE` | 5 | Tạo, sửa, kích hoạt, ngừng, xóa, khôi phục sản phẩm |
| `SELLER_DEAUTHORIZATION` | 6 | `DELETE /authorization/202403/shops` |
| `CANCELLATION_STATUS_CHANGE` | 11 | Yêu cầu hủy đơn |
| `RETURN_STATUS_CHANGE` | 12 | Yêu cầu trả hàng |
| `NEW_CONVERSATION` | 13 | Hội thoại mới, nhân viên CSKH vào/rời |
| `NEW_MESSAGE` | 14 | Tin nhắn mới |
| `DISPUTE_STATUS_CHANGE` | 15 | Tranh chấp được duyệt (mục 10) |
| `INVENTORY_CHANGED_BY_SHOP` | 71 | Seller đổi tồn kho trên UI |
| `PRODUCT_CREATION` | 0 (chưa có trong bảng) | Tạo sản phẩm qua API |

**Header khi gửi.**

| Header | Giá trị |
|---|---|
| `Content-Type` | `application/json` |
| `Authorization` | `hex(HMAC-SHA256(app_secret, path + timestamp + raw_body))`, chữ thường. `path` là pathname của URL nhận (nếu không parse được thì là `/webhook`), `timestamp` giống header `timestamp`. |
| `timestamp` | Bằng trường `timestamp` trong envelope |
| `x-simulator-webhook-id` | id của job |
| `x-simulator-attempt` | Số thứ tự lần gửi, bắt đầu từ 1 |
| `x-request-id` | Request đã gây ra sự kiện (nếu có) |

> **Lưu ý:** `README.md` (mục "Orders and webhooks") và `docs/curl-samples.md` vẫn mô tả công thức cũ `HMAC-SHA256(app_secret, app_key + raw_body)`. Công thức đó đã bị thay ở commit `593e223`; hãy dùng công thức trong bảng trên.
>
> `timestamp` (cũng là một phần của chữ ký) lấy theo **BusinessClock**. Sau khi tua đồng hồ bằng `PUT /test-admin/clock`, bên nhận nào kiểm tra độ tươi của `timestamp` theo giờ thật sẽ từ chối sự kiện.

Chỉ job gắn với một app (tức phát từ đăng ký webhook) mới có header `Authorization`. Job tạo tay qua `POST /test-admin/webhooks`, job tranh chấp và job gửi lại bằng `/test-admin/webhooks/{jobId}/replay` **không được ký**.

**Giao nhận.**

- Sự kiện được ghi trong cùng transaction với thay đổi trạng thái (outbox). Worker nhận job bằng `FOR UPDATE SKIP LOCKED`, có lease và fencing token.
- Mỗi lần gửi timeout sau `WEBHOOK_REQUEST_TIMEOUT_MS` (10 giây). HTTP 2xx là thành công; lỗi được thử lại với backoff `min(WEBHOOK_MAX_BACKOFF_MS, WEBHOOK_BASE_BACKOFF_MS × 2^(lần−1))`, mặc định 2 giây nhân đôi, tối đa 5 phút. Hết `maxAttempts` (mặc định 5) thì job chuyển `DEAD`.
- Địa chỉ `localhost`/`127.0.0.1` được đổi thành `HOST_CALLBACK_BASE_URL` khi chạy trong Docker (`WEBHOOK_REWRITE_LOCALHOST=true`).
- Bên nhận nên **khử trùng lặp theo `tts_notification_id`** (có thể nhận trùng do retry hoặc lỗi `DUPLICATE`) và đối soát định kỳ bằng API đọc.
- Lịch sử job và từng lần gửi: `GET /test-admin/webhooks`.

### 6.5. Lỗi giả lập (`/test-admin/faults`)

Luật lỗi tạo bằng `POST /test-admin/faults` với `target`, `kind`, `pathMatch` (tùy chọn), `params`, `remaining` (số lần còn áp dụng; `null` là vô hạn) và `shopId` (tùy chọn; `null` là mọi shop). Lỗi chỉ ảnh hưởng router TikTok và worker webhook, không bao giờ ảnh hưởng `/demo` hay `/test-admin`.

| `kind` | `target` | `pathMatch` | `params` | Tác dụng |
|---|---|---|---|---|
| `HTTP_ERROR` | `API` | tiền tố path | `status` (mặc định 500) | Trả status đó với thân `{simulatorFault: true, …}` |
| `HTTP_ERROR` | `WEBHOOK` | đúng tên topic | `status` | Lần gửi bị coi như bên nhận trả status đó |
| `DELAY` | `API` / `WEBHOOK` | như trên | `delayMs` (mặc định 1000, tối đa 30000) | Trì hoãn rồi xử lý bình thường |
| `DROP` | `WEBHOOK` | topic | | Không gửi; job kết thúc ngay, không thử lại |
| `DUPLICATE` | `WEBHOOK` | topic | | Gửi sự kiện hai lần |
| `REORDER` | `WEBHOOK` | topic | `holdMs` (mặc định 5000, tối đa 600000) | Giữ sự kiện lại khi đưa vào hàng đợi để sự kiện sau vượt lên trước |
| `TIMEOUT_BEFORE_WRITE` | `API` | path cập nhật tồn kho | | Cắt kết nối, không ghi gì |
| `TIMEOUT_AFTER_WRITE` | `API` | path cập nhật tồn kho | | Ghi xong rồi mới cắt kết nối |
| `APP_ERROR_200` | `API` | path cập nhật tồn kho | | HTTP 200 với `code: -1`, không ghi gì |

`DROP` và `DUPLICATE` với `target: API` không có tác dụng. Ba kind cuối chỉ được handler cập nhật tồn kho xử lý.

**Hạn chế hiện tại:** với `target: API`, luật `HTTP_ERROR` và `DELAY` có `shopId` **không bao giờ khớp**. Middleware áp lỗi chạy trước guard xác thực, nên lúc đó chưa biết shop của request; chỉ luật có `shopId: null` (mọi shop) có tác dụng. Ba kind tồn kho không bị ảnh hưởng vì handler tồn kho truyền shop trực tiếp.

### 6.6. Reset, seed và dữ liệu mẫu

- `POST /test-admin/seed` chạy seed idempotent (tự chạy khi khởi động nếu `SEED_ON_START=true`). Seed cập nhật lại `app_secret`, redirect URI và scope của app theo `.env`, và không động vào dữ liệu nghiệp vụ.
- Reset làm hai bước: `POST /test-admin/reset/prepare {scope, shopId?}` trả danh sách sẽ xóa và một token xác nhận ngắn hạn (`RESET_CONFIRM_TTL_MS`, 2 phút); `POST /test-admin/reset {scope, shopId?, confirmationToken}` thực hiện. Scope: `LOGS`, `WEBHOOKS`, `SHOP`, `ALL`. Reset từ chối chạy nếu tên database không chứa `simulator`.

### 6.7. Biến môi trường ảnh hưởng đến API

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `8090` | Cổng API |
| `DATABASE_URL` | (bắt buộc) | PostgreSQL |
| `TEST_ADMIN_TOKEN` | (bắt buộc, tối thiểu 8 ký tự) | Token cho `/test-admin` |
| `PUBLIC_API_BASE_URL` | `http://localhost:<PORT>` | Gốc của các URL tuyệt đối trả về (ảnh, PDF) |
| `SEED_APP_KEY` / `SEED_APP_SECRET` | `smartomni-dev-app-key` / `smartomni-dev-app-secret-fake` | App seed |
| `SEED_APP_REDIRECT_URIS` | callback SmartOmni local, `smartomni://oauth/tiktok` | Redirect URI hợp lệ (phân tách bằng dấu phẩy) |
| `SEED_APP_SCOPES` | tất cả scope `sim.*` | Scope cấp cho app seed |
| `OAUTH_*_TTL_MS`, `OAUTH_SIGNATURE_WINDOW_MS` | xem mục 4.1 | Thời hạn token và cửa sổ ký |
| `ORDER_HOLD_MINUTES` | `30` | Thời gian giữ đơn sau thanh toán |
| `ORDER_SHIPPING_FEE_VND` | `25000` | Phí vận chuyển |
| `RETURN_WINDOW_DAYS` | `15` | Hạn yêu cầu trả hàng |
| `DEMO_SESSION_TTL_MS` | 8 giờ | Thời hạn phiên demo |
| `WEBHOOK_WORKER_ENABLED` | `true` | Bật worker webhook |
| `WEBHOOK_BASE_BACKOFF_MS` / `WEBHOOK_MAX_BACKOFF_MS` | `2000` / `300000` | Backoff khi gửi lại |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | `10000` | Timeout mỗi lần gửi |
| `WEBHOOK_REWRITE_LOCALHOST`, `HOST_CALLBACK_BASE_URL` | | Đổi địa chỉ localhost khi chạy trong Docker |

## 7. Tham chiếu endpoint: router TikTok

Mọi endpoint dưới đây (trừ hai endpoint token) dùng xác thực ký TikTok (mục 3). Bảng **Tham số** bỏ qua các tham số ký chung `app_key`, `timestamp`, `sign`, `shop_cipher`.

### 7.1. Xác thực và shop

#### `GET /api/v2/token/get`

Đổi auth_code lấy access token + refresh token. _(Exchange auth_code for tokens)_

- Xác thực: `app_key` + `app_secret` trên query (không ký)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `app_key` | query | có | string |  |
| `app_secret` | query | có | string |  |
| `grant_type` | query |  | string | Accepted but NOT enforced (contract does not pin its value). |
| `auth_code` | query | có | string | One-time authorization code issued for this app. |

**Phản hồi**:

- `200`: Token pair.
- `400`: invalid_input, auth_code_invalid (unknown or other app), auth_code_used, auth_code_expired.
- `401`: invalid_app_credentials: app_key/app_secret rejected.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Authenticates the app with app_key/app_secret (OAuthService.authenticateApp) then calls OAuthService.exchangeCode with `auth_code`, returning a new access/refresh token pair. Shapes are provisional (contracts/schemas/token-response.json, unverified).

</details>

#### `GET /api/v2/token/refresh`

Làm mới token bằng refresh token. _(Refresh tokens)_

- Xác thực: `app_key` + `app_secret` trên query (không ký)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `app_key` | query | có | string |  |
| `app_secret` | query | có | string |  |
| `grant_type` | query |  | string | Accepted but NOT enforced (contract does not pin its value). |
| `refresh_token` | query | có | string |  |

**Phản hồi**:

- `200`: New token pair.
- `400`: invalid_input, refresh_token_invalid (unknown, other app, or already used), authorization_revoked, refresh_token_expired.
- `401`: invalid_app_credentials: app_key/app_secret rejected.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Authenticates the app, then OAuthService.refresh rotates the refresh token (single use) and issues a new token pair.

</details>

#### `GET /authorization/202309/shops`

Lấy danh sách shop đã ủy quyền cho app. _(Get authorized shops)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.authorized_shops.read`

**Phản hồi**:

- `200`: Single-element shop list.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Returns only the shop bound to the presented access token (from the guard principal). `region: VN` and `seller_type: LOCAL` for seeded shops are unverified.

</details>

#### `DELETE /authorization/202403/shops`

Hủy ủy quyền shop (seller gỡ app). _(Deauthorize Shop (202403))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.authorized_shops.read`

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Revokes every active token of the calling app for this shop at once and queues SELLER_DEAUTHORIZATION in the same transaction. Later calls with those tokens fail with 401 authorization_revoked.

</details>

### 7.2. Sản phẩm, danh mục, tồn kho

#### `POST /product/202502/products/search`

Tìm kiếm sản phẩm. _(Search products)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query | có | integer [min 1, max 100] | Required integer in [1, 100] (validated against /^\d{1,4}$/ then range). |
| `page_token` | query |  | string | Opaque cursor (base64url JSON) from a previous response `next_page_token`; any other value gives 400 invalid_input. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `status` |  | string: `ALL`, `DRAFT`, `PENDING`, `FAILED`, `ACTIVATE`, `SELLER_DEACTIVATED`, `PLATFORM_DEACTIVATED`, `FREEZE`, `DELETED` | Default ALL |
| `seller_skus` |  | string[] [maxItems 100] | Each 1-200 chars |
| `sku_ids` |  | string[] [maxItems 100] | Each 1-200 chars |
| `create_time_ge` |  | integer | Unix seconds, inclusive |
| `create_time_le` |  | integer | Unix seconds, inclusive |
| `update_time_ge` |  | integer | Unix seconds, inclusive |
| `update_time_le` |  | integer | Unix seconds, inclusive |

Ví dụ:

```json
{
  "status": "ACTIVATE",
  "seller_skus": [
    "TEE-BLK-M"
  ]
}
```

**Phản hồi**:

- `200`: Page of products. `next_page_token` is "" on the last page.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp. Also invalid_input: page_size missing/out of [1,100], bad page_token, body not an object, unsupported/unknown filter, bad status/seller_skus/sku_ids/time values.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Keyset-paginated product list of the token shop (ordered by internal seq). page_size/page_token come from the query string; filters from the JSON body. Body fields not implemented (audit_status, category_version, listing_platforms, listing_quality_tiers, return_draft_version, sns_filter) or unknown fields are rejected with 400 rather than ignored.

</details>

#### `GET /product/202309/products/{productId}`

Chi tiết sản phẩm. _(Get product detail)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `productId` | path | có | string | External product id. |

**Phản hồi**:

- `200`: Product detail (superset of the search item).
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.
- `404`: product_not_found: unknown id or product of another shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Looks up the product by (shop, external id) via Prisma and maps it with productDetail(). A product of another shop is indistinguishable from an unknown id.

</details>

#### `POST /product/202309/products/{productId}/inventory/update`

Cập nhật tồn kho (số lượng tuyệt đối). _(Update inventory)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.inventory.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `productId` | path | có | string |  |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `skus` | có | object[] [minItems 1, maxItems 100] |  |
| `skus[].id` | có | string | SKU id, 1-200 chars |
| `skus[].inventory` | có | object[] [minItems 1, maxItems 50] |  |
| `skus[].inventory[].warehouse_id` |  | string |  |
| `skus[].inventory[].quantity` | có | integer [min 1, max 99999] | Integer 1..99999 |

Ví dụ:

```json
{
  "skus": [
    {
      "id": "1729000000000000101",
      "inventory": [
        {
          "warehouse_id": "7000000000000000001",
          "quantity": 30
        }
      ]
    }
  ]
}
```

**Phản hồi**:

- `200`: Code 0 with per-SKU errors (empty when all applied). With a fault rule the body may instead be code -1 (APP_ERROR_200) or the connection is dropped (no response).
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp. Also invalid_input: body not an object, skus not an array of 1-100, skus[].id invalid, inventory not a non-empty array (max 50), warehouse_id not a string.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.
- `404`: product_not_found: unknown id or product of another shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Absolute (idempotent) stock replacement per SKU, one DB transaction per SKU; failing SKUs are listed in data.errors inside a code-0 HTTP 200 (valid SKUs are still applied). Every warehouse assigned to a SKU must be listed (warehouse_id optional only if exactly one is assigned); quantity integer in [1, 99999]; FREEZE/DELETED products are rejected per SKU. Test-fault rules TIMEOUT_BEFORE_WRITE/TIMEOUT_AFTER_WRITE destroy the socket without a response, and APP_ERROR_200 returns HTTP 200 with code -1 and nothing written.

</details>

#### `POST /product/202309/products/{productId}/prices/update`

Cập nhật giá SKU. _(Update Price (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `productId` | path | có | string |  |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `skus` |  | object[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Updates SKU prices of an ACTIVATE product in one transaction (a bad SKU rejects the whole batch). VND integer amounts; existing orders keep their snapshot prices.

</details>

#### `POST /product/202309/inventory/search`

Tra cứu tồn kho. _(Inventory Search (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.read`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `product_ids` |  | string[] |  |
| `sku_ids` |  | string[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Inventory by product_ids (max 100) or sku_ids (max 600; wins when both are sent). Ids of other shops are ignored. total_committed_quantity counts units of open orders (UNPAID to AWAITING_COLLECTION).

</details>

#### `POST /product/202309/products`

Tạo sản phẩm. _(Create Product)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Phản hồi**:

- `200`: Created product

#### `DELETE /product/202309/products`

Xóa sản phẩm (hàng loạt). _(Delete Products (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.write`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `product_ids` |  | string[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Soft delete (status DELETED, still visible to Search Products with that status). FREEZE and unknown ids are returned in errors; valid ids are still processed. Carts of the deleted SKUs are emptied.

</details>

#### `POST /product/202309/products/recover`

Khôi phục sản phẩm đã xóa. _(Recover Products (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.write`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `product_ids` |  | string[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

DELETED -> SELLER_DEACTIVATED. Other states are returned in errors.

</details>

#### `POST /product/202509/products/{productId}/partial_edit`

Sửa một phần sản phẩm. _(Partial Edit Product (202509))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `productId` | path | có | string |  |

**Body** (`application/json`):

Kiểu: object

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Same merge as Edit Product: only the fields sent change. An empty body is 400.

</details>

#### `GET /product/202309/categories/{categoryId}/attributes`

Thuộc tính của danh mục. _(Get Attributes)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `categoryId` | path | có | string | Leaf category id. |
| `locale` | query |  | string |  |
| `category_version` | query |  | string |  |

**Phản hồi**:

- `200`: Attributes list
- `400`: invalid_input: category is not an existing leaf category, or locale is malformed.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

OAS: GET /product/202309/categories/{category_id}/attributes. category_id must be a leaf category.

</details>

#### `GET /product/202309/categories/{categoryId}/rules`

Quy tắc đăng bán của danh mục. _(Get Category Rules)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `categoryId` | path | có | string | Leaf category id. |
| `locale` | query |  | string |  |
| `category_version` | query |  | string |  |

**Phản hồi**:

- `200`: Category rules
- `400`: invalid_input: category is not an existing leaf category, or locale is malformed.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

OAS: GET /product/202309/categories/{category_id}/rules. category_id must be a leaf category.

</details>

#### `GET /product/202309/attributes`

Thuộc tính sản phẩm (đường dẫn cũ, đã gỡ). _(Get Product Attributes (removed))_

- Xác thực: không cần
- **Đã gỡ**: đường dẫn cũ, chỉ trả lỗi; dùng bản theo `categories/{categoryId}`.

**Phản hồi**:

- `200`: Never returned.
- `501`: unsupported_operation

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Not an official path. Always 501 unsupported_operation, no guard (DECISIONS DA-3).

</details>

#### `GET /product/202309/rules`

Quy tắc sản phẩm (đường dẫn cũ, đã gỡ). _(Get Product Rules (removed))_

- Xác thực: không cần
- **Đã gỡ**: đường dẫn cũ, chỉ trả lỗi; dùng bản theo `categories/{categoryId}`.

**Phản hồi**:

- `200`: Never returned.
- `501`: unsupported_operation

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Not an official path. Always 501 unsupported_operation, no guard (DECISIONS DA-3).

</details>

#### `GET /product/202309/brands`

Danh sách thương hiệu. _(Get Brands)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query | có | integer [min 1, max 100] | Integer in [1, 100]. |
| `page_token` | query |  | string |  |
| `category_id` | query |  | string |  |
| `is_authorized` | query |  | boolean |  |
| `brand_name` | query |  | string | Case-insensitive prefix filter. |
| `category_version` | query |  | string |  |

**Phản hồi**:

- `200`: Brands page
- `400`: invalid_input: page_size missing or out of range, bad page_token, unknown category_id.

#### `GET /product/202309/categories`

Danh sách danh mục. _(Get Categories)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `locale` | query |  | string |  |
| `keyword` | query |  | string | Substring filter on local_name. |
| `category_version` | query |  | string |  |
| `include_prohibited_categories` | query |  | boolean |  |

**Phản hồi**:

- `200`: Categories
- `400`: invalid_input: malformed locale or boolean.

#### `PUT /product/202509/products/{productId}`

Sửa toàn bộ sản phẩm. _(Edit Product)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `productId` | path | có | string | Product ID |

**Phản hồi**:

- `200`: Updated product

#### `POST /product/202309/products/activate`

Kích hoạt sản phẩm. _(Activate Products)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Phản hồi**:

- `200`: Activated products result

#### `POST /product/202309/products/deactivate`

Ngừng kích hoạt sản phẩm. _(Deactivate Products)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Phản hồi**:

- `200`: Deactivated products result

#### `POST /product/202309/products/listing_check`

Kiểm tra điều kiện đăng bán sản phẩm. _(Check Product Listing)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Phản hồi**:

- `200`: Listing check result

#### `POST /product/202309/images/upload`

Tải ảnh sản phẩm lên. _(Upload Product Image)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Phản hồi**:

- `200`: Uploaded image info

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

A multipart JPEG/PNG/WebP (any part, max 5 MB, recognised by its bytes) is stored like a Seller Center upload (MediaAsset of the token shop) and the answer carries its real `uri` (`sim-media/{id}`), `url`, `width` and `height` (DECISIONS DA-14). Any other request gets the old placeholder answer; nothing is written to disk.

</details>

#### `POST /product/202309/files/upload`

Tải tệp sản phẩm lên. _(Upload Product File)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Phản hồi**:

- `200`: Uploaded file info

### 7.3. Kho và phương thức giao hàng

#### `GET /logistics/202309/warehouses`

Danh sách kho. _(Get warehouse list)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.product.read`

**Phản hồi**:

- `200`: Warehouses.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Lists warehouses of the token shop (default first, then by code); no pagination. Uses scope sim.product.read.

</details>

#### `GET /logistics/202309/warehouses/{warehouseId}/delivery_options`

Phương thức giao hàng của kho. _(Get Warehouse Delivery Options (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `warehouseId` | path | có | string |  |
| `scope` | query |  | string | WAREHOUSE or ALL; the result is the same. |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Static simulator options (STANDARD, EXPRESS). The warehouse id is the TikTok-style id from Get Warehouse List.

</details>

#### `GET /logistics/202309/delivery_options/{deliveryOptionId}/shipping_providers`

Đơn vị vận chuyển của một phương thức giao hàng. _(Get Shipping Providers (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `deliveryOptionId` | path | có | string |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Carriers of a simulator delivery option; unknown option is 404 delivery_option_not_found.

</details>

### 7.4. Đơn hàng

#### `POST /order/202309/orders/search`

Tìm kiếm đơn hàng (phân trang). _(Search orders)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.order.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query | có | integer [min 1, max 100] | Required integer in [1, 100] (validated against /^\d{1,4}$/ then range). |
| `page_token` | query |  | string | Opaque cursor (base64url JSON) from a previous response `next_page_token`; any other value gives 400 invalid_input. |
| `sort_field` | query |  | string: `create_time`, `update_time` |  |
| `sort_order` | query |  | string: `ASC`, `DESC` |  |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `order_status` |  | string: `UNPAID`, `ON_HOLD`, `AWAITING_SHIPMENT`, `PARTIALLY_SHIPPING`, `AWAITING_COLLECTION`, `IN_TRANSIT`, `DELIVERED`, `COMPLETED`, `CANCELLED` |  |
| `buyer_user_id` |  | string |  |
| `is_buyer_request_cancel` |  | boolean |  |
| `warehouse_ids` |  | string[] [maxItems 100] |  |
| `create_time_ge` |  | integer | Unix seconds, inclusive |
| `create_time_lt` |  | integer | Unix seconds, exclusive |
| `update_time_ge` |  | integer | Unix seconds, inclusive |
| `update_time_lt` |  | integer | Unix seconds, exclusive |

Ví dụ:

```json
{
  "order_status": "AWAITING_SHIPMENT",
  "create_time_ge": 1700000000
}
```

**Phản hồi**:

- `200`: Page of orders; `next_page_token` is "" on the last page.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp. Also invalid_input: page_size missing/out of [1,100], bad sort_field/sort_order/page_token, unsupported or unknown filter, wrong types.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Keyset-paginated order list of the token shop, sorted by sort_field/sort_order with seq as tiebreaker; a page_token issued for a different sort is rejected. Time filters: *_ge inclusive, *_lt exclusive. Filter `shipping_type` and unknown body fields are rejected with 400.

</details>

#### `GET /order/202507/orders`

Chi tiết đơn hàng theo danh sách id. _(Get order detail)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.order.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ids` | query | có | string | Comma-separated order ids, 1 to 50. |

**Phản hồi**:

- `200`: Matching orders (ordered by seq).
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp. Also invalid_input: ids missing or more than 50.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Looks up orders by external id within the token shop (ids de-duplicated, max 50). Unknown ids and other shops' ids are simply absent from the result (unverified behaviour).

</details>

#### `GET /order/202407/orders/{orderId}/price_detail`

Chi tiết giá của đơn hàng. _(Get Price Detail (202407))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.order.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `orderId` | path | có | string |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Pure read of the order price columns, all amounts are VND strings. Shipping is shared over the lines; tax, COD and distance fees are "0".

</details>

### 7.5. Giao vận (kiện hàng)

#### `GET /fulfillment/202309/orders/{orderId}/tracking`

Hành trình vận chuyển của đơn. _(Get Order Tracking (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `orderId` | path | có | string |  |

**Phản hồi**:

- `200`: Tracking events.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: order_not_found: unknown order or order of another shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Returns the order's TrackingEvent rows (oldest first) from `FulfillmentService.trackingOf`, mapping each to a description and millisecond timestamp.

</details>

#### `GET /fulfillment/202309/packages/{packageId}/shipping_documents`

Lấy chứng từ vận chuyển (nhãn PDF) của kiện. _(Get Package Shipping Document (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `packageId` | path | có | string |  |
| `document_type` | query | có | string: `SHIPPING_LABEL`, `PACKING_SLIP`, `SHIPPING_LABEL_AND_PACKING_SLIP` |  |
| `document_format` | query |  | string: `PDF` | Only PDF accepted. |
| `document_size` | query |  | string: `A6`, `A5` | Validated but ignored (simulator renders its own size). |

**Phản hồi**:

- `200`: Document URL.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: invalid_input (document_type missing/unsupported, document_format not PDF, document_size not A6/A5) or package_not_arranged (no tracking number yet).
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: package_not_found: not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Validates document_type/format/size, loads the package, then `FulfillmentService.documentFor` creates (or reuses, idempotent per package+type) a document token; `doc_url` points at a /demo/files PDF. A package whose shipment is not arranged has no label.

</details>

#### `GET /fulfillment/202309/packages/{packageId}`

Chi tiết kiện hàng. _(Get Package Detail (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `packageId` | path | có | string |  |

**Phản hồi**:

- `200`: Package detail.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: package_not_found: not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Loads the package with its order via `FulfillmentService.packageOf` plus the order warehouse and package lines, and builds the response inline in the controller. shipping_type is always TIKTOK, split_and_combine_tag always DEFAULT, region_code always VN.

</details>

#### `POST /fulfillment/202309/packages/{packageId}/ship`

Giao một kiện cho đơn vị vận chuyển. _(Ship Package (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `packageId` | path | có | string |  |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `handover_method` |  | string: `PICKUP`, `DROP_OFF` |  |
| `pickup_slot` |  |  | Accepted by the field allow-list; not read by the handler. |
| `self_shipment` |  |  | Not supported: any value (even null) gives 400. |

Ví dụ:

```json
{
  "handover_method": "PICKUP"
}
```

**Phản hồi**:

- `200`: Shipment arranged.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: invalid_input (non-object body, unknown field, bad handover_method, self_shipment present) or order_not_shippable (message starts with the rule code, e.g. order_on_hold, order_cancelled).
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: package_not_found: not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Finds the package, then `FulfillmentService.arrangeShipment(shop, orderId, 'SELLER', requestId, handover_method)`. Works only for an order in AWAITING_SHIPMENT; repeating on an already arranged package succeeds without creating a second package. Empty body is allowed.

</details>

#### `POST /fulfillment/202309/packages/search`

Tìm kiếm kiện hàng. _(Search Package (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query | có | integer [min 1, max 50] |  |
| `page_token` | query |  | string |  |
| `sort_field` | query |  | string | create_time (default) or update_time. |
| `sort_order` | query |  | string | DESC (default) or ASC. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `create_time_ge` |  | integer |  |
| `create_time_lt` |  | integer |  |
| `update_time_ge` |  | integer |  |
| `update_time_lt` |  | integer |  |
| `package_status` |  | string |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Keyset pagination on (create or update time, id). page_size [1, 50] is required. Status values are the package statuses the simulator stores (TO_FULFILL before shipment is arranged, then PROCESSING, FULFILLING, COMPLETED, CANCELLED).

</details>

#### `POST /fulfillment/202309/packages/ship`

Giao nhiều kiện cùng lúc. _(Batch Ship Packages (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.write`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `packages` |  | object[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Arranges each package like Ship Package, one transaction per package. Failures (unknown package, wrong state, self_shipment) are listed in errors and never block the other packages.

</details>

#### `GET /fulfillment/202309/packages/{packageId}/handover_time_slots`

Khung giờ bàn giao kiện. _(Get Package Handover Time Slots (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `packageId` | path | có | string |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Three pickup slots (09:00-12:00 Vietnam time) on the next three business-clock days; drop-off is always possible; van collection is UK only (false). A COMPLETED or CANCELLED package is 400.

</details>

#### `POST /fulfillment/202309/packages/{packageId}/shipping_info/update`

Cập nhật thông tin vận chuyển của kiện. _(Update Package Shipping Info (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `packageId` | path | có | string |  |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `tracking_number` |  | string |  |
| `shipping_provider_id` |  | string |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Replaces tracking_number and carrier of an arranged package that is not COMPLETED/CANCELLED; cached shipping documents are dropped; PACKAGE_UPDATE is emitted. shipping_provider_id must be a simulator carrier (see Get Shipping Providers).

</details>

#### `POST /fulfillment/202309/packages/deliver`

Cập nhật trạng thái giao kiện. _(Update Package Delivery Status (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.fulfillment.write`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `packages` |  | object[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

DELIVERY_SUCCESS moves an IN_TRANSIT order to DELIVERED (repeat = no-op); DELIVERY_FAILED (fail_delivery_reason required) only records a tracking event. Failures are listed per package.

</details>

### 7.6. Hậu mãi: hủy đơn, trả hàng, hoàn tiền

#### `POST /return_refund/202309/returns/search`

Tìm kiếm yêu cầu trả hàng. _(Search Returns (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query |  | integer [min 10, max 50] | Integer in [10, 50], default 10. |
| `page_token` | query |  | string | Opaque cursor returned as `next_page_token` (base64url JSON issued by this API). A malformed token or one issued for a different sort gives 400 invalid_input. |
| `sort_field` | query |  | string: `create_time`, `update_time` |  |
| `sort_order` | query |  | string: `ASC`, `DESC` |  |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `buyer_user_ids` |  | string[] |  |
| `create_time_ge` |  | integer | Unix seconds, >= 0 |
| `create_time_lt` |  | integer | Unix seconds |
| `locale` |  | string | accepted, not used for filtering |
| `order_ids` |  | string[] |  |
| `return_ids` |  | string[] |  |
| `return_status` |  | string: `RETURN_OR_REFUND_REQUEST_PENDING`, `REFUND_OR_RETURN_REQUEST_REJECT`, `AWAITING_BUYER_SHIP`, `BUYER_SHIPPED_ITEM`, `REJECT_RECEIVE_PACKAGE`, `RETURN_OR_REFUND_REQUEST_SUCCESS`, `RETURN_OR_REFUND_REQUEST_CANCEL`, `RETURN_OR_REFUND_REQUEST_COMPLETE`[] |  |
| `return_types` |  | string: `REFUND`, `RETURN_AND_REFUND`, `REPLACEMENT`[] |  |
| `update_time_ge` |  | integer |  |
| `update_time_lt` |  | integer |  |

Ví dụ:

```json
{
  "return_status": [
    "RETURN_OR_REFUND_REQUEST_PENDING"
  ],
  "create_time_ge": 1759000000
}
```

**Phản hồi**:

- `200`: Page of returns.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: page_size outside [10, 50] or non-integer, bad sort_field/sort_order, bad/foreign page_token, unknown or unsupported body field, non-array filter, status/type outside the documented enum, negative or non-integer time.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Filters live in the JSON body, paging/sorting in the query. Queries AftersaleRequest rows of kind RETURN for the token's shop with a (sort key, seq) cursor and maps rows with `returnItem`. `total_count` ignores the cursor. Search Returns stays 202309; `return.rma_202604` is not served.

</details>

#### `GET /return_refund/202309/returns/{returnId}/records`

Lịch sử trạng thái của yêu cầu trả hàng. _(Get Return Records (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `returnId` | path | có | string | External return id (as returned in `return_id`). |

**Phản hồi**:

- `200`: Status history.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: 404 aftersale_not_found: the id does not exist in the token's shop (another shop's id is indistinguishable).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Verifies the return belongs to the shop (`mustOwn`), then returns its AftersaleRecord history oldest first via `AftersaleService.records` and `recordItem`.

</details>

#### `POST /return_refund/202309/returns/{returnId}/approve`

Duyệt yêu cầu trả hàng. _(Approve Return (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `returnId` | path | có | string | External return id (as returned in `return_id`). |
| `idempotency_key` | query |  | string | 1-100 characters. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `decision` |  | string: `APPROVE_REFUND`, `APPROVE_RETURN`, `APPROVE_RECEIVED_PACKAGE` | max 500 chars |
| `buyer_keep_item` |  |  | Not modelled: any non-null value gives 400. |
| `partial_refund` |  |  | Not modelled: any non-null value gives 400. |

Ví dụ:

```json
{
  "decision": "APPROVE_RETURN"
}
```

**Phản hồi**:

- `200`: Approved (or already in the target state).
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: invalid_decision (decision does not match return type or status is not the required source status) or invalid_input (unsupported_decision, unknown field, buyer_keep_item/partial_refund set, bad idempotency_key).
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: 404 aftersale_not_found: the id does not exist in the token's shop (another shop's id is indistinguishable).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Calls `AftersaleService.approveReturn` as SELLER. If `decision` is omitted it is inferred (REFUND -> APPROVE_REFUND; RETURN_AND_REFUND -> APPROVE_RECEIVED_PACKAGE when BUYER_SHIPPED_ITEM else APPROVE_RETURN). Only APPROVE_REFUND, APPROVE_RETURN and APPROVE_RECEIVED_PACKAGE are modelled. `buyer_keep_item` and `partial_refund` are refused. Repeats may be deduplicated by `idempotency_key` (query, 1-100 chars); exact dedup semantics live in `decide()` and were not verified here.

</details>

#### `POST /return_refund/202309/returns/{returnId}/reject`

Từ chối yêu cầu trả hàng. _(Reject Return (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `returnId` | path | có | string | External return id (as returned in `return_id`). |
| `idempotency_key` | query |  | string | 1-100 characters. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `decision` |  | string: `REJECT_REFUND`, `REJECT_RETURN`, `REJECT_RECEIVED_PACKAGE` | REJECT_REFUND \| REJECT_RETURN \| REJECT_RECEIVED_PACKAGE (max 500 chars) |
| `reject_reason` | có | string: `ITEM_AS_DESCRIBED`, `RETURN_WINDOW_EXPIRED`, `ITEM_USED_OR_DAMAGED`, `ALREADY_SHIPPED`, `OTHER` [maxLength 500] | required |
| `comment` |  | string [maxLength 500] |  |
| `images` |  | object[] |  |

Ví dụ:

```json
{
  "reject_reason": "ITEM_AS_DESCRIBED",
  "comment": "Item matches the listing"
}
```

**Phản hồi**:

- `200`: Rejected.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: invalid_input (reject_reason missing or not one of the simulator names, unsupported_decision, unknown field) or invalid_decision (wrong type/status for the decision).
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: 404 aftersale_not_found: the id does not exist in the token's shop (another shop's id is indistinguishable).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Requires `reject_reason` (one of the names from Get Reject Reasons). Calls `AftersaleService.rejectReturn` as SELLER; `decision` is inferred when omitted (REJECT_RECEIVED_PACKAGE if BUYER_SHIPPED_ITEM, else REJECT_REFUND / REJECT_RETURN by type). `images` is accepted by the field allow-list but ignored.

</details>

#### `GET /return_refund/202309/reject_reasons`

Danh sách lý do từ chối. _(Get Reject Reasons (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `return_or_cancel_id` | query | có | string | Return or cancellation id. |

**Phản hồi**:

- `200`: Reject reasons.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: return_or_cancel_id missing.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: 404 aftersale_not_found: the id does not exist in the token's shop (another shop's id is indistinguishable).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Checks `return_or_cancel_id` exists in the shop (either kind) and returns the static REJECT_REASONS list. The names are simulator choices, not TikTok values.

</details>

#### `GET /return_refund/202512/orders/{orderId}/aftersale_eligibility`

Kiểm tra điều kiện hậu mãi của đơn (bản 202512). _(Get Aftersale Eligibility (202512))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `orderId` | path | có | string | External order id. |
| `initiate_aftersale_user` | query |  | string: `SELLER`, `BUYER` | Validated but does not change the result. |
| `request_types` | query |  | string | Comma-separated subset of CANCEL, REFUND, RETURN_AND_REFUND. Default: all three. |

**Phản hồi**:

- `200`: Per-SKU eligibility.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: initiate_aftersale_user not SELLER/BUYER, or request_types empty/contains a value outside CANCEL, REFUND, RETURN_AND_REFUND.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: order_not_found: order does not exist in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Calls `AftersaleService.eligibility` for the shop's order and groups units by SKU. CANCEL is eligible only for AWAITING_SHIPMENT orders; REFUND/RETURN_AND_REFUND only for DELIVERED/COMPLETED orders inside the business-clock return window, and only for units without an active aftersale request. `ineligible_code` -1 is a simulator sentinel.

</details>

#### `POST /return_refund/202309/cancellations/search`

Tìm kiếm yêu cầu hủy đơn. _(Search Cancellations (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query |  | integer [min 1, max 50] | Integer in [1, 50], default 10. |
| `page_token` | query |  | string | Opaque cursor returned as `next_page_token` (base64url JSON issued by this API). A malformed token or one issued for a different sort gives 400 invalid_input. |
| `sort_field` | query |  | string: `create_time`, `update_time` |  |
| `sort_order` | query |  | string: `ASC`, `DESC` |  |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `buyer_user_ids` |  | string[] |  |
| `cancel_ids` |  | string[] |  |
| `cancel_status` |  | string: `CANCELLATION_REQUEST_PENDING`, `CANCELLATION_REQUEST_SUCCESS`, `CANCELLATION_REQUEST_CANCELLED`, `CANCELLATION_REQUEST_COMPLETE`[] |  |
| `cancel_types` |  | string: `CANCEL`, `BUYER_CANCEL`[] |  |
| `create_time_ge` |  | integer | Unix seconds, >= 0 |
| `create_time_lt` |  | integer |  |
| `locale` |  | string |  |
| `order_ids` |  | string[] |  |
| `update_time_ge` |  | integer |  |
| `update_time_lt` |  | integer |  |

Ví dụ:

```json
{
  "cancel_status": [
    "CANCELLATION_REQUEST_PENDING"
  ]
}
```

**Phản hồi**:

- `200`: Page of cancellations.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: page_size outside [1, 50], bad sort/page_token, unknown body field, status/type outside enum, bad time or list values.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Same mechanism as Search Returns but for kind CANCELLATION, mapped with `cancellationItem`; page_size range is [1, 50].

</details>

#### `POST /return_refund/202309/cancellations/{cancelId}/approve`

Duyệt yêu cầu hủy đơn. _(Approve Cancellation (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `cancelId` | path | có | string | External cancellation id (as returned in `cancel_id`). |

**Phản hồi**:

- `200`: Approved.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: invalid_decision: the cancellation is in a state that cannot be approved (e.g. CANCELLED), or invalid_input for other order rule errors.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: 404 aftersale_not_found: the id does not exist in the token's shop (another shop's id is indistinguishable).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Calls `AftersaleService.approveCancellation` as SELLER: transitions the ORDER to CANCELLED (stock restored by the order service). Already SUCCESS/COMPLETE is a no-op success. The request body is not read.

</details>

#### `POST /return_refund/202309/cancellations/{cancelId}/reject`

Từ chối yêu cầu hủy đơn. _(Reject Cancellation (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `cancelId` | path | có | string | External cancellation id (as returned in `cancel_id`). |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `reject_reason` | có | string: `ITEM_AS_DESCRIBED`, `RETURN_WINDOW_EXPIRED`, `ITEM_USED_OR_DAMAGED`, `ALREADY_SHIPPED`, `OTHER` [maxLength 500] | required |
| `comment` |  | string [maxLength 500] |  |
| `images` |  | object[] |  |

Ví dụ:

```json
{
  "reject_reason": "ALREADY_SHIPPED",
  "comment": "Parcel is with the carrier"
}
```

**Phản hồi**:

- `200`: Rejected.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: reject_reason missing/invalid, unknown field, or invalid_decision (request not PENDING).
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: 404 aftersale_not_found: the id does not exist in the token's shop (another shop's id is indistinguishable).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Requires `reject_reason` (simulator reject-reason name). Calls `AftersaleService.rejectCancellation` as SELLER: PENDING -> CANCELLED, clears the order's buyerRequestedCancel flag. Already CANCELLED is a no-op success. `images` is allowed but ignored.

</details>

#### `POST /return_refund/202309/cancellations`

Seller chủ động hủy đơn. _(Seller Cancel Order (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.write`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `order_id` |  | string |  |
| `cancel_reason` |  | string |  |
| `order_line_item_ids` |  | string[] |  |
| `skus` |  | object[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.
- `404`: aftersale_not_found / order not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Cancels a whole order on behalf of the seller. Allowed in UNPAID, ON_HOLD and AWAITING_SHIPMENT without a package; partial lines are rejected (VN). Repeating the call returns the same cancel_id.

</details>

#### `POST /return_refund/202309/returns`

Tạo yêu cầu trả hàng. _(Create Return (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `idempotency_key` | query |  | string | 1-100 characters. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `order_id` |  | string |  |
| `return_type` |  | string | REFUND \| RETURN_AND_REFUND |
| `return_reason` |  | string |  |
| `order_line_item_ids` |  | string[] |  |
| `skus` |  | object[] |  |
| `refund_total` |  | string | VND integer string |
| `currency` |  | string | VND |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.
- `404`: order not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Creates a return on behalf of the buyer (role SELLER) for a DELIVERED/COMPLETED order in the return window. `idempotency_key` query: a repeat returns the same return_id. refund_total must not exceed the refundable amount.

</details>

#### `POST /return_refund/202309/refunds/calculate`

Tính số tiền hoàn. _(Calculate Refund (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.aftersale.read`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `order_id` |  | string |  |
| `request_type` |  | string | CANCEL \| REFUND \| RETURN_AND_REFUND |
| `order_line_item_ids` |  | string[] |  |
| `skus` |  | object[] |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Pure read: refund_subtotal = sum of what was paid per free unit; shipping refunded for CANCEL or the whole order; tax 0 (VN). Amounts are strings.

</details>

#### `POST /return_refund/202602/returns/search`

Tìm kiếm yêu cầu trả hàng (bản 202602). _(Search Returns 202602)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Phản hồi**:

- `200`: Returns search list

#### `GET /return_refund/202602/orders/{orderId}/aftersale_eligibility`

Kiểm tra điều kiện hậu mãi của đơn (bản 202602). _(Get Aftersale Eligibility 202602)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `orderId` | path | có | string | Order ID |

**Phản hồi**:

- `200`: Aftersale eligibility info

### 7.7. Chăm sóc khách hàng (chat)

#### `GET /customer_service/202309/conversations`

Danh sách hội thoại. _(Get Conversation List (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query | có | integer [min 1, max 20] | Integer in [1, 20]. |
| `page_token` | query |  | string | Opaque cursor returned as `next_page_token` (base64url JSON issued by this API). A malformed token or one issued for a different sort gives 400 invalid_input. |

**Phản hồi**:

- `200`: Page of conversations.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: page_size missing, non-integer or outside [1, 20]; malformed page_token.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Lists the shop's conversations in creation order (`seq` ascending, cursor = last seq). For each, loads the latest message and `ChatService.unreadFor`, mapped with `conversationItem`. `page_size` is required.

</details>

#### `POST /customer_service/202309/conversations`

Tạo hội thoại. _(Create Conversation (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.write`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `buyer_user_id` |  | string |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Returns the buyer's conversation with the shop, creating it when missing. NEW_CONVERSATION is emitted only on creation.

</details>

#### `GET /customer_service/202309/conversations/{conversationId}/messages`

Tin nhắn của một hội thoại. _(Get Conversation Messages (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `conversationId` | path | có | string |  |
| `page_size` | query | có | integer [min 1, max 10] | Integer in [1, 10]. |
| `page_token` | query |  | string | Opaque cursor returned as `next_page_token` (base64url JSON issued by this API). A malformed token or one issued for a different sort gives 400 invalid_input. |
| `sort_field` | query |  | string: `create_time`, `index` |  |
| `sort_order` | query |  | string: `ASC`, `DESC` |  |
| `need_data` | query |  | string: `true`, `false` | Only the literal "true" enables `data`. |

**Phản hồi**:

- `200`: Page of messages.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: page_size missing/outside [1, 10], bad sort_field/sort_order, bad page_token or token issued for another sort.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: conversation_not_found: not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Verifies the conversation belongs to the shop (`ChatService.ownedByShop`), then pages ChatMessage rows by (create_time or index, seq) with a cursor bound to the chosen sort. `need_data=true` adds an empty `data` string to each message.

</details>

#### `POST /customer_service/202309/conversations/{conversationId}/messages`

Gửi tin nhắn. _(Send Message (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `conversationId` | path | có | string |  |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `type` | có | string: `TEXT`, `IMAGE`, `VIDEO`, `PRODUCT_CARD`, `ORDER_CARD`, `RETURN_REFUND_CARD`, `COUPON_CARD`, `LOGISTICS_CARD` | Other documented types are refused |
| `content` | có | string | JSON string, e.g. "{\"content\":\"Hello\"}" |

Ví dụ:

```json
{
  "type": "TEXT",
  "content": "{\"content\":\"Your parcel ships tomorrow.\"}"
}
```

**Phản hồi**:

- `200`: Message stored.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: invalid_input (type not documented, non-TEXT type, content not a string / invalid JSON / wrong shape / empty / >2000 chars, chat rule error) or cannot_send_message (can_send_message is false).
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: conversation_not_found: not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

TEXT only. `content` is a JSON-serialized string `{"content":"<1-2000 chars>"}` with exactly that one key. Checks `canSendMessage`, then `ChatService.postText(..., 'SHOP', text)`. NOT idempotent: sending twice stores two messages. If the Test Console `dropSendResponse` flag is set, the message is stored and its event emitted but the socket is destroyed before any response (client sees a connection reset).

</details>

#### `GET /customer_service/202601/conversations/{conversationId}`

Chi tiết hội thoại (bản 202601). _(Get Conversation Detail (202601))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `conversationId` | path | có | string |  |

**Phản hồi**:

- `200`: Conversation detail.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: conversation_not_found: not in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Looks the conversation up via `ChatService.ownedByShop` and returns id, creation time, participants and the unread count.

</details>

#### `POST /customer_service/202606/conversations/{conversationId}/messages`

Gửi tin nhắn (bản 202606), chưa hỗ trợ. _(Send Message (202606) - not implemented)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- **Chưa hỗ trợ**: luôn trả lỗi `unsupported_operation`.

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `conversationId` | path | có | string |  |

**Body** (`application/json`):

Kiểu: object

**Phản hồi**:

- `200`: Never returned.
- `501`: unsupported_operation: Send Message 202606 has no verified schema snapshot; use 202309.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Always throws TiktokFault 501 unsupported_operation (no schema snapshot in contracts/). The handler has NO TiktokApiGuard, so it answers 501 before any signature/token check; the body is not read.

</details>

#### `POST /customer_service/202309/images/upload`

Tải ảnh cho chat, chưa hỗ trợ. _(Upload Image (202309) - not implemented)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- **Chưa hỗ trợ**: luôn trả lỗi `unsupported_operation`.

**Body** (`multipart/form-data`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `data` |  | string (binary) | image file (ignored) |

**Phản hồi**:

- `200`: Never returned.
- `501`: unsupported_operation: Upload Image (multipart) is unsupported.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Always throws TiktokFault 501 unsupported_operation because multipart request signing is unverified. The handler reads no body (multipart or otherwise) and has NO TiktokApiGuard, so it answers 501 without authentication.

</details>

#### `POST /customer_service/202309/conversations/{conversationId}/messages/read`

Đánh dấu đã đọc tin nhắn. _(Read Message (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.write`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `conversationId` | path | có | string |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Marks every buyer message as read; unread_count becomes 0 until the buyer writes again.

</details>

#### `GET /customer_service/202309/agents/settings`

Xem cài đặt nhân viên CSKH. _(Get Agent Settings (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.read`

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

One simulated agent per shop; the flag is stored on the shop.

</details>

#### `PUT /customer_service/202309/agents/settings`

Cập nhật cài đặt nhân viên CSKH. _(Update Agent Settings (202309))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.conversation.write`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `can_accept_chat` |  | boolean |  |

**Phản hồi**:

- `200`: Success envelope.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid, missing_scope or shop_cipher_mismatch.

### 7.8. Khuyến mãi (coupon)

#### `POST /promotion/202406/coupons/search`

Tìm kiếm coupon. _(Search Coupon List (202406))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.promotion.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `page_size` | query |  | integer [min 1, max 100] | Integer in [1, 100], default 50. |
| `page_token` | query |  | string | Opaque cursor returned as `next_page_token` (base64url JSON issued by this API). A malformed token or one issued for a different sort gives 400 invalid_input. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `status` |  | string: `NOT_START`, `ONGOING`, `EXPIRED`, `DEACTIVATED`[] |  |
| `display_type` |  | string: `REGULAR`, `LIVE`, `CREATOR_EXCLUSIVE`, `CHAT`, `PROMO_CODE`[] |  |
| `title_keyword` |  | string [minLength 1, maxLength 100] | substring match on title |

Ví dụ:

```json
{
  "status": [
    "ONGOING"
  ],
  "title_keyword": "Welcome"
}
```

**Phản hồi**:

- `200`: Page of coupons.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint. Also: page_size outside [1, 100], malformed page_token, unknown body field, array >20 items or non-strings, undocumented status/display_type value, title_keyword not 1-100 chars.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Read-only. Builds a Prisma filter from the body (status is derived from the window, deactivation flag and the BUSINESS clock), pages by `seq` ascending, and maps rows with `couponSearchItem`. `total_count` ignores the cursor. There is no create/update route.

</details>

#### `GET /promotion/202406/coupons/{couponId}`

Chi tiết coupon. _(Get Coupon (202406))_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.promotion.read`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `couponId` | path | có | string |  |

**Phản hồi**:

- `200`: Coupon detail.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, non-seconds timestamp, or a validation failure of the endpoint.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the endpoint scope) or shop_cipher_mismatch.
- `404`: coupon_not_found: unknown id or a coupon of another shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Finds the coupon by (shop, externalId) and returns `couponDetail` (search item plus display_channels and usage_stats; claimed_count equals redeemed_count in the simulator).

</details>

### 7.9. Đăng ký webhook (Events API)

#### `GET /event/202309/webhooks`

Danh sách đăng ký webhook. _(List webhook subscriptions)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.event.manage`

**Phản hồi**:

- `200`: Subscriptions.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Lists WebhookSubscription rows for (token shop, token app), ordered by event type.

</details>

#### `PUT /event/202309/webhooks`

Tạo hoặc cập nhật đăng ký webhook. _(Create or update a webhook subscription)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.event.manage`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `event_type` | có | string: `ORDER_STATUS_CHANGE`, `RECIPIENT_ADDRESS_UPDATE`, `PACKAGE_UPDATE`, `PRODUCT_STATUS_CHANGE`, `SELLER_DEAUTHORIZATION`, `UPCOMING_AUTHORIZATION_EXPIRATION`, `CANCELLATION_STATUS_CHANGE`, `RETURN_STATUS_CHANGE`, `NEW_CONVERSATION`, `NEW_MESSAGE`, `PRODUCT_INFORMATION_CHANGE`, `PRODUCT_CREATION`, `PRODUCT_CATEGORY_CHANGE`, `NEW_MESSAGE_LISTENER`, `INVOICE_STATUS_CHANGE`, `PRODUCT_AUDIT_STATUS_CHANGE`, `REVERSE_STATUS_UPDATE` | Webhook topic documented in the official OAS |
| `address` | có | string (uri) [maxLength 255] | Absolute http(s) URL, max 255 chars |

Ví dụ:

```json
{
  "event_type": "ORDER_STATUS_CHANGE",
  "address": "http://smartomni.local/hooks/tiktok"
}
```

**Phản hồi**:

- `200`: Stored; empty data.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp. Also invalid_input: event_type not a documented topic; address missing, over 255 chars, not an absolute URL or not http(s).
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Upserts the subscription for (shop, app, event_type) with the given address and business-clock timestamps. Any documented topic is accepted and stored, but the simulator may not emit all of them (ORDER_STATUS_CHANGE is the Phase 05 topic).

</details>

#### `DELETE /event/202309/webhooks`

Xóa đăng ký webhook. _(Delete a webhook subscription)_

- Xác thực: Ký TikTok (`x-tts-access-token` + `app_key`/`timestamp`/`sign`)
- Scope: `sim.event.manage`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `event_type` | có | string: `ORDER_STATUS_CHANGE`, `RECIPIENT_ADDRESS_UPDATE`, `PACKAGE_UPDATE`, `PRODUCT_STATUS_CHANGE`, `SELLER_DEAUTHORIZATION`, `UPCOMING_AUTHORIZATION_EXPIRATION`, `CANCELLATION_STATUS_CHANGE`, `RETURN_STATUS_CHANGE`, `NEW_CONVERSATION`, `NEW_MESSAGE`, `PRODUCT_INFORMATION_CHANGE`, `PRODUCT_CREATION`, `PRODUCT_CATEGORY_CHANGE`, `NEW_MESSAGE_LISTENER`, `INVOICE_STATUS_CHANGE`, `PRODUCT_AUDIT_STATUS_CHANGE`, `REVERSE_STATUS_UPDATE` | Webhook topic documented in the official OAS |

Ví dụ:

```json
{
  "event_type": "ORDER_STATUS_CHANGE"
}
```

**Phản hồi**:

- `200`: Deleted (or nothing to delete); empty data.
- `400`: invalid_input: missing app_key/timestamp/sign/x-tts-access-token, repeated query parameter, or non-numeric timestamp. Also invalid_input: event_type not a documented topic.
- `401`: unknown_app_key, stale_timestamp, bad_signature, token_invalid, authorization_revoked or token_expired.
- `403`: token_invalid (token issued to another app_key), missing_scope (token lacks the required scope) or shop_cipher_mismatch.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

deleteMany for (shop, app, event_type); succeeds even if no subscription existed. event_type is read from the JSON body of the DELETE request.

</details>

## 8. Tham chiếu endpoint: `/demo/*`

### 8.1. Phiên đăng nhập, shop và ủy quyền

#### `GET /demo/identities`

Danh sách seller và buyer có thể đăng nhập. _(List sellers and buyers available for sign-in)_

- Xác thực: không cần

**Phản hồi**:

- `200`: Sellers with shops, and buyers.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Public. Reads all sellers (with their shops) and all buyers from the database, ordered by name; returns names and ids only, no tokens or contact data. Feeds the "sign in as" picker of the demo UIs.

</details>

#### `POST /demo/sessions`

Tạo phiên demo (đăng nhập seller hoặc buyer). _(Create a demo session (sign in as seller or buyer))_

- Xác thực: không cần

**Body** (`application/json`, bắt buộc):

Dạng 1:

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `role` | có | string: `SELLER` |  |
| `sellerId` | có | string | min 1 char |
| `shopId` |  | string | optional; must belong to the seller |

Dạng 2:

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `role` | có | string: `BUYER` |  |
| `buyerId` | có | string | min 1 char |


Ví dụ:

```json
{
  "role": "SELLER",
  "sellerId": "seller_1"
}
```

**Phản hồi**:

- `201`: Session created. Send `sessionToken` as `x-demo-session` on later calls.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Also: the seller has no such shop.
- `404`: Unknown seller (`Unknown seller`) or buyer (`Unknown buyer`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Public. Body is a zod union on `role`. SELLER: looks up the seller (404 if unknown) and picks `shopId` if given, else the seller's first shop (400 if the seller has no such shop). BUYER: looks up the buyer (404) and uses the buyer's shop. Stores only the SHA-256 hash of a random 32-byte token; the raw `sessionToken` is returned once. TTL comes from DEMO_SESSION_TTL_MS (default 8 h).

</details>

#### `DELETE /demo/sessions/current`

Kết thúc phiên hiện tại. _(End the current session)_

- Xác thực: Header `x-demo-session`

**Phản hồi**:

- `200`: Session deleted.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Deletes the DemoSession row of the calling token (log out).

</details>

#### `GET /demo/me`

Thông tin phiên hiện tại. _(Who am I)_

- Xác thực: Header `x-demo-session`

**Phản hồi**:

- `200`: Principal.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Returns the role and shop of the session, and the buyer profile for BUYER sessions (buyer is null for SELLER).

</details>

#### `GET /demo/shops/{shopId}`

Hồ sơ shop kèm danh sách kho. _(Shop profile with warehouses)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Shop with its warehouses.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop only (assertOwnShop). Available to both roles.

</details>

#### `GET /demo/shops/{shopId}/products`

Danh sách sản phẩm rút gọn (id, tên, SKU và giá). _(Simple product list (id, title, SKUs with price))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Products.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop only, either role. Plain list of every product of the shop ordered by title (including non-active ones) with SKUs ordered by seller SKU. For the seller catalog with stock use GET /demo/shops/{shopId}/catalog; for the buyer view use /storefront/products.

</details>

#### `GET /demo/shops/{shopId}/buyers`

Danh sách buyer của shop (chỉ seller). _(List buyers of the shop (seller only))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Buyers.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session. (`Only a seller session can list buyers`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop and SELLER role required. Lists buyers of the shop ordered by name.

</details>

#### `GET /demo/authorization/consent`

Dữ liệu trang đồng ý ủy quyền của seller. _(Seller consent page data)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `app_key` | query | có | string [minLength 1, maxLength 200] |  |
| `redirect_uri` | query |  | string [maxLength 2000] |  |
| `state` | query |  | string [maxLength 512] |  |

**Phản hồi**:

- `200`: Consent context.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Also: unknown app_key, unregistered redirect_uri, invalid state.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The session is not a SELLER session.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER session required (guarded, not public). The shop comes from the session. Calls OAuthService.consentContext: 400 if `app_key` is unknown, if `redirect_uri` is not exactly one of the app's registered URIs (or the app has none), or if `state` is longer than 512 chars / contains control characters. Without `redirect_uri` the first registered URI is used. Returns what the consent page displays; nothing secret.

</details>

#### `POST /demo/authorization/consent`

Đồng ý hoặc từ chối ủy quyền app. _(Accept or deny the app authorization)_

- Xác thực: Header `x-demo-session`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `app_key` | có | string [minLength 1, maxLength 200] |  |
| `redirect_uri` |  | string [maxLength 2000] |  |
| `state` |  | string [maxLength 512] |  |
| `decision` | có | string: `accept`, `deny` |  |

Ví dụ:

```json
{
  "app_key": "sim_app_key",
  "redirect_uri": "https://smartomni.local/tiktok/callback",
  "state": "xyz123",
  "decision": "accept"
}
```

**Phản hồi**:

- `201`: Decision recorded.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Also: unknown app_key, unregistered redirect_uri, invalid state.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The session is not a SELLER session.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER session required. Validates app_key/redirect_uri/state like the GET, then on `accept` stores a single-use authorization code (hashed, TTL from config) for the session's shop and builds the redirect URL with `code` (+ echoed `state`); on `deny` the URL carries `error=access_denied`. The caller then sends the browser to `redirectUrl`; the app exchanges the code through the TikTok-router token endpoint.

</details>

### 8.2. Sản phẩm, danh mục và ảnh

#### `GET /demo/catalog`

Danh mục sản phẩm công khai của marketplace. _(Public marketplace product catalog)_

- Xác thực: không cần

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `q` | query |  | string | Search term for product title or description. |
| `shopId` | query |  | string | Filter products by shop id. |
| `limit` | query |  | string | Maximum products to return (1-100, default 20). |
| `cursor` | query |  | string | Monotonic listing sequence cursor for keyset pagination. |

**Phản hồi**:

- `200`: Marketplace products.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Public, browsable by anyone. Returns active products across all active shops on the marketplace.

</details>

#### `GET /demo/catalog/{shopId}/{productId}`

Chi tiết sản phẩm công khai. _(Public marketplace product detail)_

- Xác thực: không cần

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `productId` | path | có | string | Marketplace product id (externalId) or row UUID. |

**Phản hồi**:

- `200`: Product detail with shop info.
- `404`: Product not available.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Public. Returns product detail with shop information.

</details>

#### `GET /demo/shops/{shopId}/catalog`

Danh mục sản phẩm của seller, kèm tồn kho theo kho. _(Seller catalog with stock per warehouse)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Catalog.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session. (`Only a seller session can change the catalog`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop and SELLER role required. Returns all products (including DELETED ones, soft-deleted) in creation order with SKUs and per-warehouse stock, plus the shop's warehouses.

</details>

#### `GET /demo/shops/{shopId}/catalog/categories`

Cây danh mục cho trang sản phẩm. _(Category tree for the product page)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Tree.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. The categories of the TikTok router (GET /product/202309/categories, same data in `backend/src/catalog-meta`) with permission AVAILABLE, as a tree from the roots.

</details>

#### `GET /demo/shops/{shopId}/catalog/categories/{categoryId}/attributes`

Thuộc tính của một danh mục lá. _(Product attributes of a leaf category)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `categoryId` | path | có | string | Leaf category id. |

**Phản hồi**:

- `200`: Attributes.
- `400`: Not a leaf category, or not AVAILABLE.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown category (`Unknown category`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. PRODUCT_PROPERTY attributes of the category (same data as the TikTok Get Attributes), camelCase.

</details>

#### `GET /demo/shops/{shopId}/catalog/categories/{categoryId}/rules`

Quy tắc đăng bán của một danh mục lá. _(Listing rules of a leaf category)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `categoryId` | path | có | string | Leaf category id. |

**Phản hồi**:

- `200`: Rules.
- `400`: Not a leaf category, or not AVAILABLE.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown category.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. From the TikTok Get Category Rules data.

</details>

#### `GET /demo/shops/{shopId}/catalog/brands`

Danh sách thương hiệu cho trang sản phẩm. _(Brands for the product page)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Brands.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. The TikTok Get Brands data; `authorized` is `authorized_status === AUTHORIZED`.

</details>

#### `POST /demo/shops/{shopId}/catalog/products`

Tạo sản phẩm kèm SKU. _(Create a product with SKUs)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `title` | có | string | 1-500 chars (trimmed) |
| `description` |  | string | max 10000; default "" |
| `status` |  | string: `DRAFT`, `ACTIVATE`, `SELLER_DEACTIVATED`, `DELETED` | default ACTIVATE |
| `skus` | có | object[] [minItems 1, maxItems 100] |  |
| `skus[].sellerSku` | có | string | 1-100 chars (trimmed) |
| `skus[].name` | có | string | 1-200 chars (trimmed) |
| `skus[].attributeName` |  | string | 1-100 chars; defaults to "Phân loại" |
| `skus[].priceVnd` | có | integer [min 1, max 2000000000] | 1..2,000,000,000 |
| `skus[].stock` |  | map<string, integer [min 0, max 99999]> | Map of warehouse external id to quantity (0..99999). Unknown warehouse id => 400 `Unknown warehouse <id>`. |
| `categoryId` |  | string | Leaf category id from GET .../catalog/categories (AVAILABLE only) |
| `brandId` |  | string, nullable | Brand id from GET .../catalog/brands; null clears it |
| `images` |  | string[] [minItems 1, maxItems 9] |  |
| `productAttributes` |  | object[] [maxItems 100] | Attributes of the category only. Every attribute the category marks required needs a value; a single-selection attribute takes one value; a value without `id` is allowed only for customizable attributes. Changing the category without sending attributes clears them. |
| `productAttributes[].id` | có | string |  |
| `productAttributes[].values` | có | object[] [minItems 1, maxItems 50] |  |
| `productAttributes[].values[].id` |  | string | Value id from the category attribute `values` (omit for a custom value) |
| `productAttributes[].values[].name` |  | string | Value name (required for a custom value) |
| `packageWeight` |  | object, nullable |  |
| `packageWeight.value` | có | number |  |
| `packageWeight.unit` |  | string: `KILOGRAM`, `POUND` | default KILOGRAM |
| `packageDimensions` |  | object, nullable | Required when the category rules say `packageDimensionsRequired`. null clears it. |
| `packageDimensions.length` | có | number |  |
| `packageDimensions.width` | có | number |  |
| `packageDimensions.height` | có | number |  |
| `packageDimensions.unit` |  | string: `CENTIMETER`, `INCH` | default CENTIMETER |

Ví dụ:

```json
{
  "title": "Ao thun co tron",
  "description": "Cotton 100%",
  "status": "ACTIVATE",
  "skus": [
    {
      "sellerSku": "TSHIRT-M",
      "name": "Size M",
      "attributeName": "Kich thuoc",
      "priceVnd": 125000,
      "stock": {
        "7300000000000001": 40
      }
    }
  ]
}
```

**Phản hồi**:

- `201`: Created product.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Also: unknown warehouse in `stock`. Also: listing rules (one `message` joining every reason): unknown or non-leaf category, unknown brand, image not uploaded by this shop, missing required attribute, attribute or value not of the category, missing package dimensions.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. In one transaction creates the product (new marketplace id) and each SKU, with one inventory row per shop warehouse (quantity from `stock`, default 0). Timestamps use the business clock. Any unknown warehouse key in `stock` => 400 and nothing is created.

</details>

#### `PATCH /demo/shops/{shopId}/catalog/products/{productId}`

Sửa thông tin sản phẩm. _(Edit product fields)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `productId` | path | có | string | Product row id (`id` in catalog responses, UUID), not the marketplace externalId. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `title` |  | string | 1-500 |
| `description` |  | string | max 10000 |
| `status` |  | string: `DRAFT`, `ACTIVATE`, `SELLER_DEACTIVATED`, `DELETED` |  |
| `isNotForSale` |  | boolean |  |
| `categoryId` |  | string | Leaf category id from GET .../catalog/categories (AVAILABLE only) |
| `brandId` |  | string, nullable | Brand id from GET .../catalog/brands; null clears it |
| `images` |  | string[] [minItems 1, maxItems 9] |  |
| `productAttributes` |  | object[] [maxItems 100] | Attributes of the category only. Every attribute the category marks required needs a value; a single-selection attribute takes one value; a value without `id` is allowed only for customizable attributes. Changing the category without sending attributes clears them. |
| `productAttributes[].id` | có | string |  |
| `productAttributes[].values` | có | object[] [minItems 1, maxItems 50] |  |
| `productAttributes[].values[].id` |  | string | Value id from the category attribute `values` (omit for a custom value) |
| `productAttributes[].values[].name` |  | string | Value name (required for a custom value) |
| `packageWeight` |  | object, nullable |  |
| `packageWeight.value` | có | number |  |
| `packageWeight.unit` |  | string: `KILOGRAM`, `POUND` | default KILOGRAM |
| `packageDimensions` |  | object, nullable | Required when the category rules say `packageDimensionsRequired`. null clears it. |
| `packageDimensions.length` | có | number |  |
| `packageDimensions.width` | có | number |  |
| `packageDimensions.height` | có | number |  |
| `packageDimensions.unit` |  | string: `CENTIMETER`, `INCH` | default CENTIMETER |

Ví dụ:

```json
{
  "status": "SELLER_DEACTIVATED"
}
```

**Phản hồi**:

- `200`: Updated product.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Also: the product is DELETED. Also: listing rules (one `message` joining every reason): unknown or non-leaf category, unknown brand, image not uploaded by this shop, missing required attribute, attribute or value not of the category, missing package dimensions. The listing rules run only when a listing field is sent; stored values stand in for the ones not sent.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown product (`Unknown product`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. Product is found by its row id within the shop (another shop's product is reported as unknown, 404). A DELETED product cannot be edited (400). Body fields are all optional but at least one is required.

</details>

#### `DELETE /demo/shops/{shopId}/catalog/products/{productId}`

Xóa mềm sản phẩm. _(Soft-delete a product)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `productId` | path | có | string | Product row id (UUID). |

**Phản hồi**:

- `200`: Product with status DELETED.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown product.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. Sets the status to DELETED (the row stays and remains visible to the TikTok Search Products). Repeating it is accepted.

</details>

#### `POST /demo/shops/{shopId}/catalog/products/{productId}/skus`

Thêm SKU vào sản phẩm. _(Add a SKU to a product)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `productId` | path | có | string | Product row id (UUID). |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `sellerSku` | có | string | 1-100 chars (trimmed) |
| `name` | có | string | 1-200 chars (trimmed) |
| `attributeName` |  | string | 1-100 chars; defaults to "Phân loại" |
| `priceVnd` | có | integer [min 1, max 2000000000] | 1..2,000,000,000 |
| `stock` |  | map<string, integer [min 0, max 99999]> | Map of warehouse external id to quantity (0..99999). Unknown warehouse id => 400 `Unknown warehouse <id>`. |

Ví dụ:

```json
{
  "sellerSku": "TSHIRT-L",
  "name": "Size L",
  "priceVnd": 130000,
  "stock": {
    "7300000000000001": 25
  }
}
```

**Phản hồi**:

- `201`: Product including the new SKU.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Also: deleted product, >100 SKUs, unknown warehouse.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown product.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. 404 for an unknown product, 400 if the product is DELETED, already has 100 SKUs, or `stock` names an unknown warehouse. Creates the SKU with an inventory row for every warehouse.

</details>

#### `PATCH /demo/shops/{shopId}/catalog/skus/{skuId}`

Sửa một SKU (giá, tên, trạng thái, tồn kho). _(Edit one SKU (price, name, status, stock))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `skuId` | path | có | string | SKU row id (`skus[].id` in catalog responses, UUID). |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `sellerSku` |  | string | 1-100 |
| `name` |  | string | 1-200 |
| `attributeName` |  | string | 1-100 |
| `priceVnd` |  | integer [min 1, max 2000000000] | 1..2,000,000,000 |
| `status` |  | string: `NORMAL`, `DEACTIVATED` |  |
| `stock` |  | map<string, integer [min 0, max 99999]> | Map of warehouse external id to quantity (0..99999). Unknown warehouse id => 400 `Unknown warehouse <id>`. |

Ví dụ:

```json
{
  "priceVnd": 99000,
  "stock": {
    "7300000000000001": 55
  }
}
```

**Phản hồi**:

- `200`: The parent product with all its SKUs.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Also: deleted product, unknown warehouse.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown SKU (`Unknown SKU`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. Changes only this SKU. Stock keys are warehouse external ids (unknown => 400); each changed warehouse row is locked, an inventory-history entry (source SELLER) is logged and the level upserted. Product `updatedAt` is bumped. 404 if the SKU is not in the shop; 400 if its product is DELETED.

</details>

#### `GET /demo/shops/{shopId}/storefront/products`

Danh sách sản phẩm trên cửa hàng (phía buyer). _(Buyer storefront product list)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Storefront products.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, either role (no role check in the code). Only products with status ACTIVATE and not `isNotForSale`, in creation order. Each SKU shows `available` (SKU NORMAL and total stock > 0) and total `stock`, without the warehouse breakdown. `imageUrl` points to the public media endpoint.

</details>

#### `GET /demo/shops/{shopId}/storefront/products/{productId}`

Chi tiết sản phẩm trên cửa hàng (phía buyer). _(Buyer storefront product detail)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `productId` | path | có | string | Marketplace product id (externalId). |

**Phản hồi**:

- `200`: Product (same shape as one storefront list item).
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).
- `404`: Product not available (`This product is not available`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, either role. Looks the product up by MARKETPLACE id (externalId) so a link built from a catalog externalProductId works. 404 when it does not exist in the shop, is not ACTIVATE, or is `isNotForSale`.

</details>

#### `POST /demo/shops/{shopId}/media/images`

Tải ảnh sản phẩm lên. _(Upload a product image)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`multipart/form-data`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `file` | có | string (binary) | JPEG, PNG or WebP, max 5 MB |

**Phản hồi**:

- `201`: Stored image.
- `400`: No `file` part, or the bytes are not a JPEG, PNG or WebP image.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `413`: The file is larger than 5 MB (multer limit).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Own shop, SELLER only. multipart/form-data with one part `file`. The format is read from the bytes (magic numbers), never from the declared type or file name: only JPEG, PNG and WebP are accepted, at most 5 MB. Width and height are read from the image header. The picture is stored in PostgreSQL (`MediaAsset`, belongs to the shop). Use the returned `uri` in `images` of the create/edit product endpoints.

</details>

#### `GET /demo/media/images/{id}`

Lấy ảnh sản phẩm đã tải lên. _(Uploaded product image)_

- Xác thực: không cần

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `id` | path | có | string | MediaAsset id (UUID), the part after `sim-media/` in the uri. |

**Phản hồi**:

- `200`: The image bytes.
- `404`: Malformed or unknown id.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Public (an <img> cannot send the session header). Serves the stored bytes with their `Content-Type` and `Cache-Control: public, max-age=31536000, immutable` (an id never changes content).

</details>

#### `GET /demo/media/products/{file}`

Ảnh sản phẩm mặc định (SVG). _(Placeholder product image (SVG))_

- Xác thực: không cần

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `file` | path | có | string | Product row id, optionally followed by `.svg`. |

**Phản hồi**:

- `200`: SVG image.
- `404`: Malformed id or unknown product.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Public (no guard; an <img> cannot send the session header). `file` is the product ROW id (UUID, 36 chars of [0-9a-f-]) with an optional `.svg` suffix; anything else is 404. Generates a 600x600 SVG whose colour and text derive from the title (first 28 chars). Sent with `Content-Type: image/svg+xml` and `Cache-Control: no-store`.

</details>

### 8.3. Giỏ hàng, đặt hàng và đơn hàng

#### `GET /demo/cart`

Giỏ hàng marketplace của buyer, nhóm theo shop. _(Marketplace buyer cart grouped by shop)_

- Xác thực: Header `x-demo-session`

**Phản hồi**:

- `200`: Cart grouped by shop.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The session is not a BUYER session (buyerOf).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. Returns all items currently in the buyer's cart grouped by shop.

</details>

#### `GET /demo/buyer/orders`

Đơn hàng của buyer trên mọi shop. _(Marketplace buyer orders across all shops)_

- Xác thực: Header `x-demo-session`

**Phản hồi**:

- `200`: Buyer orders.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The session is not a BUYER session (buyerOf).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. Returns all orders placed by the buyer across all shops with shop details.

</details>

#### `GET /demo/shops/{shopId}/cart`

Giỏ hàng của buyer tại một shop. _(Buyer cart)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Cart.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER session only (buyerOf => 403 for sellers). Reads the buyer's cart lines via OrdersService.cart and totals them.

</details>

#### `PUT /demo/shops/{shopId}/cart/items`

Đặt số lượng cho một dòng trong giỏ. _(Set the quantity of a cart line)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `skuId` | có | string | SKU marketplace id (1-100 chars) |
| `quantity` | có | integer [min 0, max 20] | 0..20; 0 removes |

Ví dụ:

```json
{
  "skuId": "7510123456789013",
  "quantity": 2
}
```

**Phản hồi**:

- `200`: Updated cart.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`).
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).
- `404`: Unknown SKU in this shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. Upserts the buyer's cart line for the SKU (marketplace id, looked up within the session shop); `quantity` 0 removes the line. Responds with the updated cart. Stock is not checked here (only at checkout).

</details>

#### `POST /demo/shops/{shopId}/checkout`

Đặt hàng (tạo đơn UNPAID). _(Checkout (create an UNPAID order))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `checkoutKey` | có | string [minLength 8, maxLength 100] | Client-generated idempotency key, 8-100 chars |
| `items` |  | object[] [maxItems 50] | If omitted the cart is used. |
| `items[].skuId` | có | string | SKU marketplace id |
| `items[].quantity` | có | integer [min 1, max 20] | 1..20 |
| `recipient` |  | object |  |
| `recipient.name` | có | string | 1-200 chars (trimmed) |
| `recipient.phone` | có | string | 5-30 chars (trimmed) |
| `recipient.addressLine` | có | string | 1-300 chars |
| `recipient.district` | có | string | 1-100 chars |
| `recipient.city` | có | string | 1-100 chars |
| `recipient.postalCode` |  | string, nullable | max 20 chars |
| `buyerMessage` |  | string | max 500 |
| `couponCode` |  | string [minLength 1, maxLength 20] | 1-20 chars; case-insensitive |

Ví dụ:

```json
{
  "checkoutKey": "co-7f3a9c21-0001",
  "items": [
    {
      "skuId": "7510123456789013",
      "quantity": 2
    }
  ],
  "couponCode": "SALE10"
}
```

**Phản hồi**:

- `201`: The order (new or replayed).
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or an order/coupon rule error (see description).
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. Items come from `items` or, if omitted, from the cart (cart is cleared only for a non-replayed cart checkout). Recipient defaults to the buyer's saved address. Idempotent per (buyer, checkoutKey): a repeat returns the original order with `replayed: true`. OrdersService.checkout merges quantities, then in one transaction validates SKUs/ACTIVATE status, picks ONE enabled warehouse that can fill every item (default warehouse first), decrements stock, optionally redeems `couponCode`, and creates the order UNPAID. Rule violations are 400 with `{code, message}` codes: invalid_quantity, empty_order, too_many_units (>50 units total), unknown_sku, not_for_sale, insufficient_stock, and coupon_not_found/deactivated/not_started/expired/min_spend/not_eligible/no_discount/exhausted.

</details>

#### `POST /demo/shops/{shopId}/orders/{orderId}/pay`

Thanh toán giả lập. _(Fake payment)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `orderId` | path | có | string | Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID. |

**Phản hồi**:

- `201`: Order after payment.
- `400`: Order is CANCELLED (`order_cancelled`).
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).
- `404`: Unknown order (or not this buyer's).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only, own order. UNPAID -> ON_HOLD with `paidAt` and `releaseAt` (business clock + configured hold minutes); the lifecycle worker later moves it to AWAITING_SHIPMENT. Any status other than UNPAID returns the order unchanged with `replayed: true`, except CANCELLED which is 400 `order_cancelled`. Not a TikTok API.

</details>

#### `POST /demo/shops/{shopId}/orders/{orderId}/cancel`

Hủy đơn (buyer hủy/yêu cầu hủy, hoặc seller hủy). _(Cancel an order (buyer cancel / request, or seller cancel))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `orderId` | path | có | string | Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `reason` |  | string [minLength 1, maxLength 300] | 1-300 chars; default "no reason given" |

Ví dụ:

```json
{
  "reason": "Changed my mind"
}
```

**Phản hồi**:

- `201`: Order after the cancel (or after the request was recorded).
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or cancel_not_allowed / invalid_transition.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).
- `404`: Unknown order (buyer: not own order; seller: not in this shop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Both roles. BUYER (own order): UNPAID or ON_HOLD cancels immediately (stock and coupon redemption released); AWAITING_SHIPMENT does NOT cancel but opens an aftersale cancellation request that the seller must approve (the returned order shows `buyerRequestedCancel: true`); an already CANCELLED order is returned as is; any other status is 400 `cancel_not_allowed`. SELLER: transitions the order to CANCELLED through the state machine (invalid transition => 400 `invalid_transition`, e.g. already CANCELLED, IN_TRANSIT, DELIVERED or COMPLETED). Body is optional; `reason` defaults to "no reason given".

</details>

#### `GET /demo/shops/{shopId}/orders`

Danh sách đơn hàng. _(List orders)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Orders.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Buyer: own orders (OrdersService.listForBuyer). Seller: orders of the shop (listForShop, default take 100, no query parameters).

</details>

#### `GET /demo/shops/{shopId}/orders/{orderId}`

Chi tiết đơn kèm lịch sử trạng thái. _(Order detail with status history)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `orderId` | path | có | string | Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID. |

**Phản hồi**:

- `200`: Order and its transitions.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).
- `404`: Unknown order.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Seller: any order of the shop. Buyer: only own orders (others are 404, never 403). `history` is the OrderAudit trail.

</details>

### 8.4. Vận chuyển

#### `POST /demo/shops/{shopId}/orders/{orderId}/arrange-shipment`

Sắp xếp vận chuyển (seller). _(Arrange shipment (seller))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `orderId` | path | có | string | Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID. |

**Phản hồi**:

- `201`: Fulfillment view.
- `400`: order_on_hold / order_cancelled / order_not_shippable.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown order.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only. FulfillmentService.arrangeShipment: UNPAID/ON_HOLD => 400 `order_on_hold`, CANCELLED => 400 `order_cancelled`, AWAITING_SHIPMENT => moves to AWAITING_COLLECTION (creating tracking number and tracking event), already shipped orders return the existing package (repeat is a no-op); other statuses 400 `order_not_shippable`. Responds with the fulfillment view.

</details>

#### `POST /demo/shops/{shopId}/orders/{orderId}/advance-shipment`

Đẩy vận chuyển thêm một bước (seller). _(Advance one carrier step (seller))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `orderId` | path | có | string | Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID. |

**Phản hồi**:

- `201`: Fulfillment view after the step.
- `400`: nothing_to_advance.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown order.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only. Simulates the carrier: AWAITING_COLLECTION -> IN_TRANSIT -> DELIVERED. Any other order status is 400 `nothing_to_advance`. DELIVERED is not COMPLETED.

</details>

#### `GET /demo/shops/{shopId}/orders/{orderId}/fulfillment`

Kiện hàng và hành trình của đơn. _(Package and tracking of an order)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `orderId` | path | có | string | Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID. |

**Phản hồi**:

- `200`: Fulfillment view.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).
- `404`: Unknown order.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Both roles. Buyer: only own orders (otherwise 404) and no seller-only fields (`package.canArrange` omitted, `canArrange` false). Seller: any order of the shop. `package` is null until a package exists (created when the order reaches AWAITING_SHIPMENT). `blockedReason` is order_on_hold, order_unpaid or null.

</details>

#### `POST /demo/shops/{shopId}/orders/{orderId}/shipping-label`

Lấy hoặc tạo URL nhãn vận chuyển (seller). _(Get/generate a shipping document URL (seller))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `orderId` | path | có | string | Marketplace order id (`id` of an order view, i.e. Order.externalId), not the row UUID. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `documentType` |  | string: `SHIPPING_LABEL`, `PACKING_SLIP`, `SHIPPING_LABEL_AND_PACKING_SLIP` | default SHIPPING_LABEL |

Ví dụ:

```json
{
  "documentType": "SHIPPING_LABEL"
}
```

**Phản hồi**:

- `201`: Document location.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or package_not_arranged.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown order, or the order has no package yet.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only. 404 if the order or its package does not exist. FulfillmentService.documentFor generates (once per package+type, idempotent) a fake PDF stamped "TEST DATA" and returns its public URL; 400 `package_not_arranged` when the package has no tracking number yet. Body optional; `documentType` defaults to SHIPPING_LABEL.

</details>

#### `GET /demo/files/shipping-documents/{file}`

Tải nhãn vận chuyển (PDF). _(Download a shipping document (PDF))_

- Xác thực: không cần

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `file` | path | có | string | 48 lowercase hex chars, optional `.pdf` suffix (from the `url` returned by shipping-label). |

**Phản hồi**:

- `200`: PDF bytes.
- `404`: Unknown token or file missing.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Public (no guard): the 48-hex-char token in the URL is the capability. `.pdf` suffix is stripped; a malformed or unknown token, or an unreadable file, is 404. Streams the stored PDF with `Content-Type: application/pdf`, `Content-Disposition: inline; filename="shipping-document-TEST.pdf"` and `Cache-Control: no-store`. Content is test data only.

</details>

### 8.5. Hậu mãi

#### `GET /demo/shops/{shopId}/aftersale`

Danh sách yêu cầu hậu mãi. _(List aftersale requests)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Requests and reason lists.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Both roles. Seller: the latest 200 requests (cancellations and returns) of the shop, newest first. Buyer: only requests on own orders. Also returns the reason pick-lists.

</details>

#### `POST /demo/shops/{shopId}/aftersale/returns`

Buyer: yêu cầu trả hàng/hoàn tiền. _(Buyer: request a return/refund)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `orderId` | có | string | Order marketplace id (1-100) |
| `items` | có | object[] [minItems 1, maxItems 50] |  |
| `items[].skuId` | có | string | SKU marketplace id |
| `items[].quantity` | có | integer [min 1, max 50] | 1..50 |
| `returnType` | có | string: `REFUND`, `RETURN_AND_REFUND` |  |
| `reason` |  | string | 1-300 chars; default OTHER. Suggested: CHANGED_MIND, DAMAGED_ITEM, NOT_AS_DESCRIBED, WRONG_ITEM, OTHER (not enforced) |

Ví dụ:

```json
{
  "orderId": "576011223344556677",
  "items": [
    {
      "skuId": "751000000000001",
      "quantity": 1
    }
  ],
  "returnType": "REFUND",
  "reason": "DAMAGED_ITEM"
}
```

**Phản hồi**:

- `201`: Created request (status RETURN_OR_REFUND_REQUEST_PENDING).
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or return_not_allowed / return_window_closed / units_unavailable.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).
- `404`: Unknown order (not this buyer's).
- `409`: A unit is already in an active aftersale request (`unit_already_requested`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. AftersaleService.createReturn: the order must be the buyer's (404) and DELIVERED/COMPLETED inside the return window (business clock) => else 400 `return_not_allowed` / `return_window_closed`; picks the requested number of units per SKU that are not already in an active request (400 `units_unavailable`; DB unique-index race => 409 `unit_already_requested`). Refund = what was paid for those units. The order status is not changed.

</details>

#### `POST /demo/shops/{shopId}/aftersale/cancellations`

Buyer: yêu cầu hủy đơn đã thanh toán. _(Buyer: request cancellation of a paid order)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `orderId` | có | string | 1-100 |
| `reason` |  | string | 1-300 chars; default CHANGED_MIND |

Ví dụ:

```json
{
  "orderId": "576011223344556677",
  "reason": "CHANGED_MIND"
}
```

**Phản hồi**:

- `201`: Pending cancellation request.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or cancel_not_allowed.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).
- `404`: Unknown order.
- `409`: A unit is already in an active aftersale request (`unit_already_requested`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. For an AWAITING_SHIPMENT order creates a CANCELLATION request (pending seller approval) and flags the order `buyerRequestedCancel`; repeating while one is pending returns the same request. Other order statuses => 400 `cancel_not_allowed`; unknown/foreign order => 404. UNPAID/ON_HOLD orders are cancelled directly with POST .../orders/{orderId}/cancel instead.

</details>

#### `POST /demo/shops/{shopId}/aftersale/{id}/cancel`

Buyer: rút lại yêu cầu trả hàng. _(Buyer: withdraw a return request)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `id` | path | có | string | Aftersale request marketplace id (`id` of an aftersale view). |

**Phản hồi**:

- `201`: Request after withdrawal.
- `400`: invalid_decision (request not in a cancellable status).
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).
- `404`: Unknown return request (or not on this buyer's order).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. Applies to RETURN requests only (a cancellation id is 404). Moves PENDING or AWAITING_BUYER_SHIP -> RETURN_OR_REFUND_REQUEST_CANCEL and frees the units; already cancelled is returned unchanged; other statuses 400 `invalid_decision`.

</details>

#### `POST /demo/shops/{shopId}/aftersale/{id}/ship-back`

Buyer: gửi hàng trả cho đơn vị vận chuyển. _(Buyer: hand the approved return to the carrier)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `id` | path | có | string | Aftersale request marketplace id. |

**Phản hồi**:

- `201`: Request after shipping back.
- `400`: invalid_decision (request is not AWAITING_BUYER_SHIP).
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a BUYER session (buyerOf).
- `404`: Unknown return request.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only, RETURN requests only. AWAITING_BUYER_SHIP -> BUYER_SHIPPED_ITEM and assigns a fake `SIMRET...` return tracking number; already shipped is returned unchanged; other statuses 400 `invalid_decision`.

</details>

#### `POST /demo/shops/{shopId}/aftersale/{id}/approve`

Seller: duyệt yêu cầu hủy hoặc trả hàng. _(Seller: approve a cancellation or return)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `id` | path | có | string | Aftersale request marketplace id. |

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `decision` |  | string: `APPROVE_REFUND`, `APPROVE_RETURN`, `APPROVE_RECEIVED_PACKAGE` | max 60; returns only |

Ví dụ:

```json
{
  "decision": "APPROVE_REFUND"
}
```

**Phản hồi**:

- `201`: Decision applied (or already in effect).
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or invalid_decision / unsupported_decision.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown aftersale request.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only. Looks the request up by id in the shop (404). CANCELLATION: PENDING -> cancels the order (stock restored) and the request becomes SUCCESS; already SUCCESS/COMPLETE => `changed: false`; other statuses 400 `invalid_decision`. RETURN: `decision` optional (inferred from type/status); supported APPROVE_REFUND (REFUND, PENDING->SUCCESS), APPROVE_RETURN (RETURN_AND_REFUND, PENDING->AWAITING_BUYER_SHIP), APPROVE_RECEIVED_PACKAGE (RETURN_AND_REFUND, BUYER_SHIPPED_ITEM->SUCCESS); others 400 `unsupported_decision`, mismatched type 400 `invalid_decision`. Repeating a decision that is already in effect returns `changed: false`. Stock is never added back for returns by the simulator.

</details>

#### `POST /demo/shops/{shopId}/aftersale/{id}/reject`

Seller: từ chối yêu cầu hủy hoặc trả hàng. _(Seller: reject a cancellation or return)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `id` | path | có | string | Aftersale request marketplace id. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `reason` | có | string: `ITEM_AS_DESCRIBED`, `RETURN_WINDOW_EXPIRED`, `ITEM_USED_OR_DAMAGED`, `ALREADY_SHIPPED`, `OTHER` | 1-100 chars; must be a reject-reason name |
| `comment` |  | string | max 500 |
| `decision` |  | string: `REJECT_REFUND`, `REJECT_RETURN`, `REJECT_RECEIVED_PACKAGE` | max 60; returns only |

Ví dụ:

```json
{
  "reason": "ITEM_AS_DESCRIBED",
  "comment": "Item matches the listing photos."
}
```

**Phản hồi**:

- `201`: Rejection applied (or already in effect).
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or invalid_reject_reason / invalid_decision / unsupported_decision.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown aftersale request.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only. `reason` must be one of the reject reasons (ITEM_AS_DESCRIBED, RETURN_WINDOW_EXPIRED, ITEM_USED_OR_DAMAGED, ALREADY_SHIPPED, OTHER) else 400 `invalid_reject_reason`. CANCELLATION: PENDING -> CANCELLATION_REQUEST_CANCELLED (order flag cleared). RETURN: `decision` inferred (REJECT_REFUND / REJECT_RETURN from PENDING, REJECT_RECEIVED_PACKAGE from BUYER_SHIPPED_ITEM); wrong state 400 `invalid_decision`, unknown decision 400 `unsupported_decision`. Repeating an applied rejection returns `changed: false`.

</details>

#### `POST /demo/shops/{shopId}/aftersale/{id}/dispute`

Buyer: khiếu nại (mở tranh chấp). _(Buyer Dispute Trigger)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop ID |
| `id` | path | có | string | Aftersale request ID |

**Phản hồi**:

- `200`: Dispute raised result

#### `POST /demo/shops/{shopId}/aftersale/{id}/arbitrate`

Phân xử tranh chấp (gọi bằng phiên demo, không phải token admin). _(Admin / Operator Arbitrate Trigger)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop ID |
| `id` | path | có | string | Aftersale request ID |

**Phản hồi**:

- `200`: Arbitration result

### 8.6. Chat

#### `GET /demo/shops/{shopId}/chat/conversations`

Danh sách hội thoại. _(List conversations)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Conversations with unread count and latest message.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Both roles. Buyer: only the buyer's own conversation(s); seller: every conversation of the shop, ordered by creation. `supportedTypes` lists message types the simulator renders (TEXT only); `unsupported` describes the rest.

</details>

#### `GET /demo/shops/{shopId}/chat/conversations/{conversationId}/messages`

Đọc tin nhắn của hội thoại. _(Read messages of a conversation)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `conversationId` | path | có | string | Conversation ROW id (`id` of a conversation summary, UUID), not the marketplace externalId. |

**Phản hồi**:

- `200`: Conversation and messages.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or the conversation belongs to another buyer.
- `404`: Unknown conversation.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Both roles. ChatService.assertParticipant: conversation looked up by ROW id within the shop (404 otherwise); a buyer who is not the conversation owner gets 403. Returns up to 500 visible messages by ascending `index`.

</details>

#### `POST /demo/shops/{shopId}/chat/conversations/{conversationId}/messages`

Trả lời trong hội thoại (seller, hoặc buyer nhắn tiếp). _(Reply in a conversation (seller, or buyer continuing))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `conversationId` | path | có | string | Conversation ROW id (UUID). |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `text` | có | string [minLength 1, maxLength 2000] | 1..2000 chars (the service additionally rejects whitespace-only text with 400 `invalid_text`) |

Ví dụ:

```json
{
  "text": "Dạ shop còn size L ạ."
}
```

**Phản hồi**:

- `201`: Stored message.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or invalid_text / cannot_send_message.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or the conversation belongs to another buyer.
- `404`: Unknown conversation.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Both roles. assertParticipant as for the GET (404 unknown, 403 another buyer's conversation). A SELLER is refused with 400 `cannot_send_message` when the conversation has `canSendMessage = false`. Posts a TEXT message with role SHOP (seller) or BUYER, plus its NEW_MESSAGE event, in one transaction.

</details>

#### `POST /demo/shops/{shopId}/chat/messages`

Buyer: nhắn tin cho shop. _(Buyer: send a message to the shop)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `text` | có | string [minLength 1, maxLength 2000] | 1..2000 chars (the service additionally rejects whitespace-only text with 400 `invalid_text`) |

Ví dụ:

```json
{
  "text": "Con size L khong shop?"
}
```

**Phản hồi**:

- `201`: Stored message.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or invalid_text.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or only a buyer session can start a conversation.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

BUYER only. Gets or creates the buyer's single conversation with the shop (ChatService.conversationForBuyer), then posts a TEXT message with role BUYER; the message and its NEW_MESSAGE webhook event are written in one transaction. Whitespace-only text => 400 `invalid_text`.

</details>

### 8.7. Coupon

#### `GET /demo/shops/{shopId}/coupons`

Danh sách coupon. _(List coupons)_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Phản hồi**:

- `200`: Seller view (full) or buyer view (usable only); the `items` shape differs by role.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Both roles. Seller: every coupon of the shop with status, counters and discount details. Buyer: only coupons usable right now (ONGOING on the business clock, not exhausted, and for audience NEW only if the buyer has no earlier non-cancelled order), with the code shown so it can be typed at checkout.

</details>

#### `POST /demo/shops/{shopId}/coupons`

Tạo coupon (seller). _(Create a coupon (seller))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `title` | có | string | 1-100 chars |
| `promoCode` | có | string | 6-12 letters or digits |
| `discount` | có | object \\| object |  |
| `minSpendVnd` |  | integer | 1..2,000,000,000 |
| `startAt` |  | string (date-time) | ISO datetime (business clock) |
| `endAt` | có | string (date-time) | ISO datetime |
| `redemptionLimit` |  | integer | 1..1,000,000 |
| `audience` |  | string: `ALL`, `NEW` | default ALL (REPEAT_CUSTOMERS is not modelled) |

Ví dụ:

```json
{
  "title": "Giam 10%",
  "promoCode": "SALE10",
  "discount": {
    "type": "PERCENT_OFF",
    "percentage": 10,
    "maxDiscountVnd": 30000
  },
  "minSpendVnd": 100000,
  "endAt": "2026-12-31T00:00:00.000Z",
  "redemptionLimit": 100,
  "audience": "ALL"
}
```

**Phản hồi**:

- `201`: Created coupon.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`).
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `409`: This promo code already exists in the shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only. Stores a coupon (code upper-cased; `startAt` defaults to the current business time). Not a TikTok API: simulator data setup. Duplicate code in the shop => 409. `endAt` must be after `startAt` when both are given.

</details>

#### `PATCH /demo/shops/{shopId}/coupons/{couponId}`

Sửa coupon (seller). _(Edit a coupon (seller))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `couponId` | path | có | string | Coupon marketplace id (`id` of a coupon view). |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `title` |  | string | 1-100 |
| `startAt` |  | string (date-time) |  |
| `endAt` |  | string (date-time) |  |
| `redemptionLimit` |  | integer, nullable | 1..1,000,000, or null |
| `minSpendVnd` |  | integer, nullable | 1..2,000,000,000, or null |
| `deactivated` |  | boolean |  |

Ví dụ:

```json
{
  "deactivated": true
}
```

**Phản hồi**:

- `200`: Updated coupon.
- `400`: Body/query failed zod validation (`message: "Validation failed"` plus `issues: [{path, message}]`). Or endAt not after startAt / redemptionLimit below redeemed count.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session.
- `404`: Unknown coupon.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only. The code and the discount are immutable (orders may carry a snapshot). Updatable: title, startAt, endAt, redemptionLimit (nullable = unlimited), minSpendVnd (nullable), deactivated. 404 unknown coupon (by marketplace id); 400 if the resulting start >= end or redemptionLimit is below the redemptions already used.

</details>

### 8.8. Tồn kho

#### `GET /demo/shops/{shopId}/inventory/history`

Lịch sử thay đổi tồn kho và các lần gọi API cập nhật tồn kho (seller). _(Stock change history and inventory-update API attempts (seller))_

- Xác thực: Header `x-demo-session`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Shop id of the session (`shopId` returned by POST /demo/sessions). Any other shop id answers 403. |
| `limit` | query |  | integer [min 1, max 200] | Rows per list; default 50, clamped to 1..200. |

**Phản hồi**:

- `200`: Changes and attempts, newest first.
- `401`: Missing, unknown or expired `x-demo-session` header (DemoSessionGuard).
- `403`: The path `shopId` is not the shop of the session (assertOwnShop). Or The session is not a SELLER session. (`Only a seller session can read the inventory history`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

SELLER only, own shop. Returns the newest `limit` InventoryChange rows (before/after per SKU and warehouse, with source such as SELLER, ORDER or API) and the newest `limit` inventory-update attempts (including ones that never got an answer). `limit` is parsed leniently: non-numeric/0 => 50, clamped to 1..200.

</details>

## 9. Tham chiếu endpoint: `/test-admin/*`

### 9.1. Hệ thống: trạng thái, seed, reset, đồng hồ

#### `GET /test-admin/status`

Trạng thái dịch vụ. _(Service status)_

- Xác thực: Header `x-test-admin-token`

**Phản hồi**:

- `200`: Status snapshot.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Reports DB connectivity (`SELECT 1`), the connected database name, webhook worker state, webhook job counts per status, the business clock and a seed summary. If the DB is down, `database.status` is `down`, `webhookJobs` is `{}` and `seed` is null; the call still returns 200.

</details>

#### `POST /test-admin/seed`

Chạy seed (idempotent). _(Run the idempotent seed)_

- Xác thực: Header `x-test-admin-token`

**Phản hồi**:

- `201`: Seed complete (201 Created, Nest default for POST).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Upserts the app and clock row and seeds every shop in SEED_SHOPS, then returns row counts. No request body. Safe to repeat (seeding is upsert-based).

</details>

#### `POST /test-admin/reset/prepare`

Chuẩn bị reset (bước 1/2). _(Prepare a reset (step 1 of 2))_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `scope` | có | string: `LOGS`, `WEBHOOKS`, `SHOP`, `ALL` | What to delete. SHOP deletes one shop and re-seeds its baseline; ALL deletes everything and re-seeds; LOGS = HTTP request logs; WEBHOOKS = webhook jobs and attempts. |
| `shopId` |  | string [minLength 1] | Required for scope SHOP, forbidden for other scopes |

Ví dụ:

```json
{
  "scope": "SHOP",
  "shopId": "3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11"
}
```

**Phản hồi**:

- `201`: Reset plan (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`. Also: `shopId is required for scope SHOP`, `shopId is only allowed for scope SHOP`, `Unknown shopId`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `403`: Database name does not contain "simulator" (`Refusing to reset: ...`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Dry run: validates the request and returns what would be deleted plus a short-lived HMAC `confirmationToken` bound to scope and shopId (TTL = RESET_CONFIRM_TTL_MS, default 120000 ms). Nothing is deleted. Refuses with 403 unless the connected database name contains "simulator" (case-insensitive).

</details>

#### `POST /test-admin/reset`

Thực hiện reset (bước 2/2). _(Execute a reset (step 2 of 2))_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `scope` | có | string: `LOGS`, `WEBHOOKS`, `SHOP`, `ALL` | What to delete. SHOP deletes one shop and re-seeds its baseline; ALL deletes everything and re-seeds; LOGS = HTTP request logs; WEBHOOKS = webhook jobs and attempts. |
| `shopId` |  | string [minLength 1] | Required for SHOP |
| `confirmationToken` | có | string [minLength 10] | Token from prepare |

Ví dụ:

```json
{
  "scope": "LOGS",
  "confirmationToken": "1792051200000.9b2f0e5d7c..."
}
```

**Phản hồi**:

- `201`: Reset executed (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`. Also `shopId is required for scope SHOP`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `403`: Not a simulator database; confirmation token malformed (`Invalid confirmation token`), not matching scope/shopId, or expired (`Confirmation token expired; request a new one`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Deletes data for the scope and re-seeds (SHOP and ALL). Requires the `confirmationToken` from /test-admin/reset/prepare for the same scope and shopId, unexpired. Same safety rail: 403 if the database name does not contain "simulator". `deleted` reports the counts taken before deletion.

</details>

#### `GET /test-admin/clock`

Xem đồng hồ nghiệp vụ. _(Get the business clock)_

- Xác thực: Header `x-test-admin-token`

**Phản hồi**:

- `200`: Clock snapshot.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Returns the business clock (drives order/aftersale/coupon timestamps). The request-signature clock is separate and not affected.

</details>

#### `PUT /test-admin/clock`

Đặt, tua, đóng băng hoặc reset đồng hồ nghiệp vụ. _(Set, advance, freeze or reset the business clock)_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `setTo` |  | string (date-time) | ISO 8601 datetime |
| `advanceMs` |  | integer | Milliseconds to add (integer; may be negative) |
| `freeze` |  | boolean | Only used with setTo; default false |
| `reset` |  | boolean | true = offset 0 and unfrozen |

Ví dụ:

```json
{
  "setTo": "2026-11-01T00:00:00.000Z",
  "freeze": true
}
```

**Phản hồi**:

- `200`: Clock snapshot after the change.
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Fields are evaluated in this order and only the first present one acts: `reset` (true) > `setTo` (optional `freeze`) > `advanceMs`. With none of them it just returns the snapshot. `advanceMs` moves the frozen instant if frozen, else the offset; negative values pass validation.

</details>

### 9.2. Dữ liệu: shop, đơn, hậu mãi, sandbox

#### `GET /test-admin/shops`

Danh sách shop kèm kịch bản và số liệu. _(List shops with scenarios and counts)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `region` | query |  | string | Region code filter, e.g. VN. Omitted = every shop. |

**Phản hồi**:

- `200`: Shops.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

All shops ordered by name, with their scenarios and row counts. Use `id` as `shopId` in other endpoints. The optional `region` query keeps only shops of that region code (like the toolkit `sandbox shop list --region-code`).

</details>

#### `POST /test-admin/shops/{shopId}/scenario`

Kích hoạt kịch bản cho shop. _(Activate a shop scenario)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | path | có | string | Internal shop id |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `key` | có | string [minLength 1] | Scenario key of this shop (seeded: `default`, `webhook-flaky-receiver`) |

Ví dụ:

```json
{
  "key": "webhook-flaky-receiver"
}
```

**Phản hồi**:

- `201`: Scenario activated (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown scenario for this shop (an unknown shopId also lands here, since the lookup is by shop + key).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Sets `activeScenarioId` of the shop to the scenario with the given key. This endpoint only stores the choice; the scenario `config` is consumed elsewhere (the seeded `webhook-flaky-receiver` has `{webhook:{failFirstAttempts:2}}`). Not verified: which component reads it.

</details>

#### `GET /test-admin/inventory/history`

Lịch sử thay đổi tồn kho và các lần gọi cập nhật. _(Inventory change and update-attempt history)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | query | có | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |
| `limit` | query |  | integer [min 1, max 200] | Max rows, clamped to [1, 200]; non-numeric or 0 falls back to 50. |

**Phản hồi**:

- `200`: Changes and attempts.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: `shopId is required` (missing query parameter).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Read-only, newest first (by seq). `shopId` is effectively required: when omitted the handler throws 404 `shopId is required` (404, not 400).

</details>

#### `GET /test-admin/coupons`

Tổng quan coupon. _(Coupon overview)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |

**Phản hồi**:

- `200`: Coupons.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Read-only list of up to 200 coupons (oldest first by seq), optionally for one shop. `status` is computed on the business clock: DEACTIVATED, NOT_START, EXPIRED or ONGOING.

</details>

#### `GET /test-admin/aftersale`

Danh sách yêu cầu hậu mãi. _(List aftersale requests)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |
| `limit` | query |  | integer [min 1, max 200] | Max rows, clamped to [1, 200]; non-numeric or 0 falls back to 50. |

**Phản hồi**:

- `200`: Aftersale requests.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Cancellations and returns, newest first.

</details>

#### `GET /test-admin/aftersale/{ref}/records`

Lịch sử trạng thái của một yêu cầu hậu mãi. _(Status history of one aftersale request)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Aftersale row id or external id |
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |

**Phản hồi**:

- `200`: Records.
- `400`: Aftersale id is ambiguous across shops; pass `shopId`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown aftersale request.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Looks up the request by row id or external id (pass `shopId` when the external id could exist in several shops) and returns its transition records oldest first.

</details>

#### `POST /test-admin/aftersale/{ref}/complete`

Đánh dấu đã chi trả hoàn tiền (SUCCESS sang COMPLETE). _(Mark the refund as paid out (SUCCESS to COMPLETE))_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Aftersale row id or external id |
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |

**Phản hồi**:

- `201`: Resulting request (201 Created).
- `400`: Id ambiguous across shops, or Business rule violated. Body is `{ code, message }` (Nest `BadRequestException` with an object; no `statusCode`). Code `invalid_decision`: the request is not in the SUCCESS status.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown aftersale request.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Moves a request from CANCELLATION_REQUEST_SUCCESS to CANCELLATION_REQUEST_COMPLETE (cancellation) or from RETURN_OR_REFUND_REQUEST_SUCCESS to RETURN_OR_REFUND_REQUEST_COMPLETE (return). A request that is already complete is returned as is (idempotent). From any other status it is refused with 400 `invalid_decision`. No body.

</details>

#### `GET /test-admin/orders`

Danh sách đơn hàng. _(List orders)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |
| `status` | query |  | string: `UNPAID`, `ON_HOLD`, `AWAITING_SHIPMENT`, `PARTIALLY_SHIPPING`, `AWAITING_COLLECTION`, `IN_TRANSIT`, `DELIVERED`, `COMPLETED`, `CANCELLED` | Order status filter |
| `limit` | query |  | integer [min 1, max 200] | Max rows, clamped to [1, 200]; non-numeric or 0 falls back to 50. |
| `pageSize` | query |  | integer [min 1, max 10] | Toolkit-style page size, clamped to [1, 10]; when sent it wins over `limit`. |

**Phản hồi**:

- `200`: Orders.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Newest first (by seq). `status` is used in the query unvalidated; an unknown value simply returns no rows.

</details>

#### `POST /test-admin/orders/release-due`

Giải phóng các đơn ON_HOLD đã đến hạn. _(Release due ON_HOLD orders)_

- Xác thực: Header `x-test-admin-token`

**Phản hồi**:

- `201`: External ids of the released orders (201 Created).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Moves every ON_HOLD order whose `releaseAt` is <= business clock now to AWAITING_SHIPMENT (actor SYSTEM, note `hold period elapsed`). Advance the clock first (PUT /test-admin/clock) to test the boundary. No body. Orders another process moved first are skipped silently.

</details>

#### `GET /test-admin/orders/{ref}/audit`

Lịch sử trạng thái của một đơn. _(Status history of one order)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Order row id or external id |
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |

**Phản hồi**:

- `200`: Audit history.
- `400`: Order id is ambiguous across shops; pass `shopId`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown order.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Looks up an order by row id or external id (add `shopId` if the external id exists in several shops) and returns its audit rows oldest first.

</details>

#### `POST /test-admin/orders/{ref}/transition`

Ép chuyển trạng thái đơn. _(Force an order status transition)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Order row id or external id |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `to` |  | string: `UNPAID`, `ON_HOLD`, `AWAITING_SHIPMENT`, `PARTIALLY_SHIPPING`, `AWAITING_COLLECTION`, `IN_TRANSIT`, `DELIVERED`, `COMPLETED`, `CANCELLED` | Target status. OPTIONAL: when omitted the order moves ONE happy-path step (UNPAID pays, ON_HOLD releases, AWAITING_SHIPMENT arranges the package, AWAITING_COLLECTION and IN_TRANSIT advance the carrier, DELIVERED completes); a COMPLETED or CANCELLED order stays and `transitioned` is false. |
| `shopId` |  | string [minLength 1] | Disambiguates the order ref across shops |
| `note` |  | string [maxLength 300] | Audit note (max 300); default `test console` |
| `cancelReason` |  | string [maxLength 300] | Used when to=CANCELLED (max 300); falls back to note |

Ví dụ:

```json
{
  "to": "AWAITING_SHIPMENT",
  "note": "skip the hold"
}
```

**Phản hồi**:

- `201`: Transition applied (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`. Also order id ambiguous across shops, or Business rule violated. Body is `{ code, message }` (Nest `BadRequestException` with an object; no `statusCode`). Code `invalid_transition`, e.g. `ON_HOLD -> AWAITING_COLLECTION is not allowed (an ON_HOLD order cannot be shipped)`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown order.
- `409`: The order changed concurrently; retry.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Runs the same state machine the apps use (actor `TEST_CONSOLE`). Allowed: UNPAID to ON_HOLD or CANCELLED; ON_HOLD to AWAITING_SHIPMENT or CANCELLED; AWAITING_SHIPMENT to PARTIALLY_SHIPPING, AWAITING_COLLECTION or CANCELLED; PARTIALLY_SHIPPING to AWAITING_COLLECTION or CANCELLED; AWAITING_COLLECTION to IN_TRANSIT or CANCELLED; IN_TRANSIT to DELIVERED; DELIVERED to COMPLETED; COMPLETED and CANCELLED are terminal. Cancelling releases reserved stock; other side effects (events) happen inside the order service.

</details>

#### `GET /test-admin/sandbox/products`

Danh sách sản phẩm sandbox (dạng của toolkit). _(Sandbox product list (toolkit shape))_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | query | có | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |

**Phản hồi**:

- `200`: Products.
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Counterpart of `sandbox product list`: ACTIVATE products with NORMAL SKUs; `stock_count` is the stock summed over the warehouses. `limits` are the simulator caps for Create Sandbox Order.

</details>

#### `POST /test-admin/sandbox/orders`

Tạo đơn sandbox (hàng loạt). _(Create sandbox orders (batch))_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `shopId` | có | string [minLength 1] | Internal shop id |
| `items` | có | object[] |  |
| `items[].product_id` |  | string | Optional, informational |
| `items[].sku_id` |  | string | SKU external id |
| `items[].quantity` |  | integer [min 1, max 20] |  |
| `order_count` |  | integer [min 1, max 10] |  |
| `logistics_service_id` |  | string | Optional; one of the simulator delivery option ids |
| `payment_method` |  | string | Optional label stored as the order payment method name |
| `pay` |  | boolean | Default true: pay after checkout (the order becomes ON_HOLD) |

Ví dụ:

```json
{
  "shopId": "3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11",
  "items": [
    {
      "sku_id": "7510000000000001",
      "quantity": 1
    }
  ],
  "order_count": 2
}
```

**Phản hồi**:

- `201`: Batch result (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown shop, or the shop has no buyer.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Counterpart of `sandbox order create`: places `order_count` orders through the real checkout (own checkoutKey each) and pays them unless `pay` is false. A batch can be partly created and partly failed; created orders are never rolled back. Uses the first buyer of the shop (or the first marketplace buyer).

</details>

#### `POST /test-admin/catalog/bulk`

Sinh sản phẩm hàng loạt. _(Generate bulk products)_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `shopId` | có | string [minLength 1] | Internal shop id |
| `count` | có | integer [min 1, max 500] | Products to create |
| `skusPerProduct` |  | integer [min 1, max 5] | SKUs per product |

Ví dụ:

```json
{
  "shopId": "3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11",
  "count": 50,
  "skusPerProduct": 2
}
```

**Phản hồi**:

- `201`: Created (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Creates `count` ACTIVATE products titled `Bulk <batch> #n`, each with `skusPerProduct` priced SKUs (20000 to 69000 VND) and 10-29 units of stock in every warehouse of the shop. Fake data for multi-page import tests; products are created one by one (not in one transaction).

</details>

### 9.3. Token và auth code

#### `GET /test-admin/tokens`

Danh sách token (chỉ metadata). _(List token records (metadata only))_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |

**Phản hồi**:

- `200`: Tokens.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Newest first. Never returns token values or hashes. Expiry flags use the auth clock.

</details>

#### `POST /test-admin/tokens/{id}/expire-access`

Làm hết hạn access token. _(Expire the access token)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `id` | path | có | string | Token record id (`id` from GET /test-admin/tokens, not a token value). |

**Phản hồi**:

- `201`: Updated token view (201 Created).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown token record.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Sets `accessExpiresAt` one second before the auth clock now, so the normal expiry path (not a special status) is exercised. The refresh token stays valid. No body.

</details>

#### `POST /test-admin/tokens/{id}/expire-refresh`

Làm hết hạn refresh token. _(Expire the refresh token)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `id` | path | có | string | Token record id (`id` from GET /test-admin/tokens, not a token value). |

**Phản hồi**:

- `201`: Updated token view (201 Created).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown token record.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Sets `refreshExpiresAt` one second before the auth clock now. No body.

</details>

#### `POST /test-admin/tokens/{id}/revoke`

Thu hồi token (seller gỡ app). _(Revoke a token (seller revoked the app))_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `id` | path | có | string | Token record id (`id` from GET /test-admin/tokens, not a token value). |

**Phản hồi**:

- `201`: Updated token view (201 Created).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown token record.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Sets status REVOKED and `revokedAt`; both tokens stop working immediately. This endpoint does not send a SELLER_DEAUTHORIZATION webhook (the code comment says that belongs to another phase). No body.

</details>

#### `POST /test-admin/tokens/{id}/remove-scope`

Bỏ một scope đã cấp khỏi token. _(Remove one granted scope from a token)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `id` | path | có | string | Token record id (`id` from GET /test-admin/tokens, not a token value). |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `scope` | có | string [minLength 1, maxLength 200] | Scope the token currently holds |

Ví dụ:

```json
{
  "scope": "products.write"
}
```

**Phản hồi**:

- `201`: Updated token view (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown token record, or `The token does not hold that scope`.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Removes the scope from this token only (not from the app, so a re-seed does not undo it). Used to test missing-scope handling.

</details>

#### `POST /test-admin/authorization-codes/expire`

Làm hết hạn mọi auth code chưa dùng. _(Expire all unused authorization codes)_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `shopId` |  | string [minLength 1] | Limit to one shop (internal id) |

Ví dụ:

```json
{
  "shopId": "3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11"
}
```

**Phản hồi**:

- `201`: Number of codes expired (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Marks every not yet consumed and not yet expired authorization code (of one shop, or of all shops when `shopId` is omitted) as expired one second ago, to test "code expired" end to end.

</details>

### 9.4. Lỗi giả lập, log HTTP, webhook

#### `GET /test-admin/faults`

Danh sách luật lỗi giả lập. _(List fault rules)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |

**Phản hồi**:

- `200`: Fault rules.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Oldest first. With `shopId`, returns rules for that shop plus global rules (`shopId` null); without it, all rules.

</details>

#### `POST /test-admin/faults`

Tạo luật lỗi giả lập. _(Create a fault rule)_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `shopId` |  | string [minLength 1], nullable | null/omitted = all shops |
| `target` | có | string: `API`, `WEBHOOK` |  |
| `kind` | có | string: `HTTP_ERROR`, `DELAY`, `DROP`, `DUPLICATE`, `REORDER`, `TIMEOUT_BEFORE_WRITE`, `TIMEOUT_AFTER_WRITE`, `APP_ERROR_200` |  |
| `pathMatch` |  | string [minLength 1], nullable |  |
| `params` |  | map<string, any> |  |
| `remaining` |  | integer [min 1], nullable | Number of uses; null/omitted = unlimited |

Ví dụ:

```json
{
  "shopId": null,
  "target": "WEBHOOK",
  "kind": "DROP",
  "pathMatch": "ORDER_STATUS_CHANGE",
  "remaining": 2
}
```

**Phản hồi**:

- `201`: Created rule (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Rules are consumed by the TikTok-router middleware (target API; pathMatch is a path prefix), the webhook worker (target WEBHOOK; pathMatch is the exact topic) and, for TIMEOUT_BEFORE_WRITE, TIMEOUT_AFTER_WRITE and APP_ERROR_200, only by the inventory update handler. REORDER applies when an event is enqueued, not at delivery. `params` is stored as given; its keys per kind are defined in the middleware/worker and are not validated here, nor is target/kind compatibility. An unknown non-null `shopId` fails at the database (foreign key) and this handler does not map it to a 4xx (not verified).

</details>

#### `DELETE /test-admin/faults/{id}`

Xóa luật lỗi giả lập. _(Delete a fault rule)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `id` | path | có | string | Fault rule id |

**Phản hồi**:

- `200`: Always `{deleted: true}`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Idempotent: uses deleteMany, so an unknown id still returns `{deleted: true}` (no 404).

</details>

#### `GET /test-admin/http-logs`

Tra cứu log HTTP. _(Query HTTP request logs)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `requestId` | query |  | string | Exact request id (the `request_id` of a response) |
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |
| `router` | query |  | string | Router label stored with the log row (set by the logging middleware; values not verified) |
| `limit` | query |  | integer [min 1, max 500] | Max rows, clamped to [1, 500]; non-numeric or 0 falls back to 100. |

**Phản hồi**:

- `200`: Log rows.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Rows of the request log (newest first). Filters are exact matches combined with AND. Rows are returned as stored; redaction, if any, happens when they are written (not verified here).

</details>

#### `GET /test-admin/webhooks`

Danh sách job webhook kèm các lần gửi. _(List webhook jobs with attempts)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `requestId` | query |  | string | Request id that caused the event |
| `shopId` | query |  | string | Internal shop id (UUID, the `id` returned by GET /test-admin/shops). |
| `status` | query |  | string: `PENDING`, `IN_PROGRESS`, `SUCCEEDED`, `DEAD` | Job status |
| `limit` | query |  | integer [min 1, max 200] | Max rows, clamped to [1, 200]; non-numeric or 0 falls back to 50. |

**Phản hồi**:

- `200`: Jobs.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Newest first, each with its delivery `attempts` ordered by attemptNo. `status` is cast without validation; an invalid value is rejected by Prisma and would surface as a 500 (the handler does not map it).

</details>

#### `POST /test-admin/webhooks`

Đưa một webhook vào hàng đợi. _(Enqueue a webhook delivery)_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `shopId` | có | string [minLength 1] | Internal shop id |
| `topic` | có | string [minLength 1, maxLength 100] | Event topic |
| `payload` | có | map<string, any> |  |
| `targetUrl` | có | string (uri) | http(s) URL |
| `maxAttempts` |  | integer [min 1, max 20] |  |

Ví dụ:

```json
{
  "shopId": "3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11",
  "topic": "ORDER_STATUS_CHANGE",
  "payload": {
    "order_id": "5800000000000001",
    "order_status": "AWAITING_SHIPMENT"
  },
  "targetUrl": "http://host.docker.internal:8080/webhooks/tiktok",
  "maxAttempts": 3
}
```

**Phản hồi**:

- `201`: Created job (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Creates a PENDING job for the worker to deliver to `targetUrl` (retried up to `maxAttempts`, default 5, with backoff). The payload is stored as given; how the worker wraps or signs it is not verified here.

</details>

#### `POST /test-admin/webhooks/{jobId}/replay`

Gửi lại một job webhook. _(Replay a webhook job)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `jobId` | path | có | string | Webhook job id |

**Phản hồi**:

- `201`: The new job (201 Created).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown webhook job.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Enqueues a new PENDING job copying shop, topic, payload, target URL and maxAttempts from the original, with `replayOfId` set. The original job is untouched. No body.

</details>

### 9.5. Chat

#### `GET /test-admin/chat/conversations`

Danh sách mọi hội thoại. _(List all conversations)_

- Xác thực: Header `x-test-admin-token`

**Phản hồi**:

- `200`: Conversations.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

All conversations of all shops, oldest first (by seq), unpaginated. `identityKnown` is false for conversations created by POST /test-admin/chat/conversations (no matching buyer). `complaintTestLabel` is a test-data label, not a classifier output.

</details>

#### `POST /test-admin/chat/conversations`

Tạo hội thoại từ một người dùng TikTok lạ. _(Create a conversation from an unknown TikTok user)_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `shopId` | có | string [minLength 1] | Internal shop id |
| `unknownBuyerNickname` | có | string [minLength 1, maxLength 100] | Nickname of the unmatched user |
| `text` | có | string [minLength 1, maxLength 2000] | First message |

Ví dụ:

```json
{
  "shopId": "3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11",
  "unknownBuyerNickname": "stranger_42",
  "text": "Where is my order?"
}
```

**Phản hồi**:

- `201`: Created (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`. A whitespace-only text passes zod but may be refused by the chat service (`invalid_text`, Business rule violated. Body is `{ code, message }` (Nest `BadRequestException` with an object; no `statusCode`).)
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown shop.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Creates a conversation with a TikTok identity that matches no simulator buyer (identity-mismatch scenario) and posts the first BUYER text message, which emits the usual chat events.

</details>

#### `POST /test-admin/chat/conversations/{ref}/buyer-message`

Giả lập tin nhắn của buyer. _(Simulate a buyer message)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Conversation row id or external id (404 if an external id matches several shops; then use the row id) |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `text` | có | string [minLength 1, maxLength 2000] |  |
| `suppressEvent` |  | boolean | Message stored but its NEW_MESSAGE event is lost |
| `duplicateEvent` |  | boolean | Same event delivered twice |

Ví dụ:

```json
{
  "text": "Hello, is this in stock?",
  "duplicateEvent": true
}
```

**Phản hồi**:

- `201`: Message stored (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`. Whitespace-only text is refused with `invalid_text` (Business rule violated. Body is `{ code, message }` (Nest `BadRequestException` with an object; no `statusCode`).)
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown conversation, or `Conversation id is ambiguous; use the row id`.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Stores a BUYER text message and emits NEW_MESSAGE in the same transaction. `suppressEvent` stores the message but loses the event; `duplicateEvent` delivers the same event (same notification id) twice.

</details>

#### `POST /test-admin/chat/conversations/{ref}/flags`

Bật cờ lỗi cho hội thoại. _(Set conversation fault flags)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Conversation row id or external id |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `dropSendResponse` |  | boolean |  |
| `canSendMessage` |  | boolean |  |

Ví dụ:

```json
{
  "dropSendResponse": true
}
```

**Phản hồi**:

- `201`: Flags after the update (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`. (`nothing to update` when the body has no keys).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown conversation, or ambiguous external id.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

`dropSendResponse`: the seller send API stores the message but its response is dropped (indeterminate send). `canSendMessage`: whether sending is allowed. At least one of the two must be present.

</details>

#### `POST /test-admin/chat/conversations/{ref}/agent`

Nhân viên CSKH vào hoặc rời hội thoại. _(Customer-service agent joins or leaves)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Conversation row id or external id |

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `joined` | có | boolean | true = agent joined, false = left |

Ví dụ:

```json
{
  "joined": true
}
```

**Phản hồi**:

- `201`: Updated (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`.
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown conversation, or ambiguous external id.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Sets `agentJoined` and emits a NEW_CONVERSATION event (`AGENT_JOINED`, participant_count 3, or `AGENT_LEFT`, participant_count 2). The event payload is marked provisional in the code.

</details>

### 9.6. Kịch bản

#### `POST /test-admin/scenarios/loyalty-orders`

Tạo đơn kiểm thử cho luật khách hàng thân thiết. _(Create loyalty-rule test orders)_

- Xác thực: Header `x-test-admin-token`

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `shopId` | có | string [minLength 1] | Internal shop id |
| `buyerId` |  | string [minLength 1] | Internal buyer id of that shop; default = first buyer |
| `thresholdDays` |  | integer [min 1, max 365] | N |

Ví dụ:

```json
{
  "shopId": "3f0c9a52-1d3e-4c52-9a53-0f7a6a2c1b11",
  "thresholdDays": 15
}
```

**Phản hồi**:

- `201`: Created orders (201 Created).
- `400`: Validation failed (zod): body `{ statusCode: 400, message: "Validation failed", issues: [{path, message}] }`. Also Business rule violated. Body is `{ code, message }` (Nest `BadRequestException` with an object; no `statusCode`). (checkout rules such as insufficient_stock).
- `401`: Missing or invalid `x-test-admin-token` header (`Missing or invalid x-test-admin-token`).
- `404`: Unknown shop; `No buyer for this shop`; or `No on-sale SKU with enough stock`.

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Creates five paid orders for one buyer (first buyer by external id unless `buyerId` is given) for the SmartOmni rule "points only after N days since completion" (N = `thresholdDays`; a SmartOmni rule, not a TikTok policy): completed N+1 days ago, exactly N days ago, N days minus 1 hour ago, DELIVERED only, and still ON_HOLD. Each is checked out (1 unit of the first on-sale SKU with stock >= 10), paid and driven through the real state machine while the business clock is temporarily set (frozen) to the wanted time; the clock is restored afterwards (frozen stays frozen, a running clock keeps running). Not atomic: a failure midway leaves the orders already created.

</details>

### 9.7. Dữ liệu: phân xử tranh chấp

#### `POST /test-admin/aftersale/{ref}/arbitration`

Phân xử tranh chấp (admin). _(Test Admin Arbitrate)_

- Xác thực: Header `x-test-admin-token`

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `ref` | path | có | string | Aftersale Request ID or external ID |

**Phản hồi**:

- `200`: Arbitration adjudication result

## 10. Endpoint giả lập ngoài ba router

Các endpoint này **không cần xác thực** và không có trong API TikTok thật. Chúng phục vụ kiểm thử upload media và luồng tranh chấp.

### 10.1. Media và tranh chấp

#### `POST /api/v2/media/upload`

Tải media giả lập. _(Mock media upload)_

- Xác thực: không cần

**Body** (`multipart/form-data`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `file` |  | string (binary) | Image or video binary file |
| `file_name` |  | string | Optional custom filename |
| `media_id` |  | string | Optional custom media_id |

**Phản hồi**:

- `200`: Upload succeeded

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Upload mock media (image or video) and get a TikTok Shop Open API formatted response with media_id and media_url.

</details>

#### `POST /api/v2/simulator/dispute/trigger`

Kích hoạt sự kiện tranh chấp giả lập. _(Trigger dispute simulation event)_

- Xác thực: không cần

**Body** (`application/json`, bắt buộc):

| Trường | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|
| `status` | có | string: `DISPUTE_PENDING_REVIEW`, `DISPUTE_APPROVED`, `DISPUTE_REJECTED` | Dispute status |
| `dispute_id` |  | string | Dispute ID |
| `order_id` |  | string | Order ID |
| `return_id` |  | string | Return / Aftersale ID |
| `shop_id` |  | string | Shop ID |
| `reason` |  | string | Dispute reason |
| `compensation_amount` |  | integer | Compensation amount (VND) |
| `currency` |  | string | Currency |
| `webhook_url` |  | string | Target webhook URL override |

Ví dụ:

```json
{
  "status": "DISPUTE_APPROVED",
  "dispute_id": "mock_dispute_123456",
  "order_id": "5770000000000000001",
  "compensation_amount": 100000
}
```

**Phản hồi**:

- `200`: Dispute trigger processed

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Triggers dispute state transitions (DISPUTE_PENDING_REVIEW, DISPUTE_APPROVED, DISPUTE_REJECTED). When DISPUTE_APPROVED is triggered, fires a DISPUTE_STATUS_CHANGE webhook event with compensation and adjustment info.

</details>

#### `GET /api/v2/simulator/dispute`

Danh sách tranh chấp giả lập. _(List simulated disputes)_

- Xác thực: không cần

**Phản hồi**:

- `200`: Dispute list

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Returns all currently tracked dispute records in the simulator.

</details>

#### `GET /api/v2/simulator/dispute/{id}`

Chi tiết tranh chấp giả lập. _(Get simulated dispute by ID)_

- Xác thực: không cần

**Tham số**:

| Tên | Vị trí | Bắt buộc | Kiểu | Mô tả |
|---|---|---|---|---|
| `id` | path | có | string | Dispute ID |

**Phản hồi**:

- `200`: Dispute detail
- `404`: Dispute not found

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Returns the dispute record and its current status.

</details>

## 11. Health check

### 11.1. Health

#### `GET /health/live`

Kiểm tra tiến trình còn sống (liveness). _(Liveness probe)_

- Xác thực: không cần

**Phản hồi**:

- `200`: Process is alive

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Always returns `{status: "ok"}` while the process is up. Not logged to the HTTP log.

</details>

#### `GET /health/ready`

Kiểm tra sẵn sàng phục vụ, gồm kết nối DB (readiness). _(Readiness probe)_

- Xác thực: không cần

**Phản hồi**:

- `200`: All checks passed
- `503`: A check failed: body is `{status: "unavailable", checks}`

<details><summary>Ghi chú kỹ thuật (trích OpenAPI)</summary>

Runs `SELECT 1` against PostgreSQL and checks that the media and PDF directories are writable. Returns 503 if any check fails.

</details>

## 12. Tài liệu liên quan

| Tài liệu | Nội dung |
|---|---|
| `docs/openapi.json` / Swagger `http://localhost:8090/api-docs` | Đặc tả OpenAPI đầy đủ, gồm schema chi tiết của response. Xuất lại: `cd backend && npm run build && npm run openapi:export`. |
| `docs/curl-samples.md` | Mẫu curl có ký request |
| `docs/postman-collection.json` | Collection Postman |
| `docs/support-matrix.md` | Mức độ hỗ trợ của từng operation |
| `contracts/` | Bản chụp OAS chính thức, fixtures theo operation (`contracts/fixtures/ops/`), test vector ký request |
| `DECISIONS.md` | Các sai khác và giả định có chủ đích so với OAS |
| `docs/smartomni-requirements/` | Yêu cầu phía SmartOmni |
| `README.md` | Cách chạy, seed, reset, Test Console |
