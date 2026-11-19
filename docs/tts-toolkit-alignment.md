# Giải pháp đồng bộ simulator với `@tts-open-toolkit/cli@0.1.7`

> Trạng thái: **đã triển khai (P0, P1, P2, sandbox §2)**, xem DECISIONS DA-1..DA-12. Tài liệu này không đổi trạng thái `unverified` của operation nào trong `contracts/manifest.json`.
> Nguồn đối chiếu (chỉ đọc, không login, không gọi DevAPI):
> - OAS đi kèm toolkit: `skills/tts-openapi-guide/references/oas/` (OpenAPI 3.0.0, 405 path, 25 module).
> - Skill sandbox: `skills/tts-openapi-sandbox-materials/` (SKILL.md + `references/order-material-recipes.md`).
> - Signer local broker của toolkit trong `dist/tts_open_toolkit.mjs`.
> - Code simulator: `backend/src/tiktok/*.controller.ts`, các service domain, `backend/prisma/schema.prisma`.
>
> Bảng query/body/response ở **Phụ lục A** được **sinh tự động từ OAS** (không gõ tay). Phần thân tài liệu chỉ nêu field chính và logic.

## 0. Tóm tắt

- Cả 12 operation SmartOmni đang gọi (`docs/smartomni-requirements/phase-05..09.md`) **đều đã có** trong simulator, khớp path và version với OAS. Không gap nào dưới đây chặn SmartOmni.
- Có **4 route lệch OAS** và **một số query param bị thiếu hoặc sai shape** trên route đã có (P0).
- Có khoảng **11 operation áp dụng được cho VN** mà OAS có, simulator chưa có, và có thể dựng trên model hiện tại (P1).
- Phần còn lại là P2 hoặc **không áp dụng cho VN** (US/UK/EU/Tokopedia only).
- Nghiệp vụ sandbox của toolkit (`sandbox order create/list/transition`) khác `/test-admin` ở **cách chuyển trạng thái** và **tập state canonical** (mục 2).
- Signer local broker của toolkit có cùng công thức với `signature.ts`. Nó không phải signer TikTok nên không cần đổi gì (mục 3).
- Mọi hạng mục P0–P2 đều sửa `backend/`. Cần xác nhận được phép trên nhánh đang làm trước khi triển khai.

## 1. Hiện trạng route simulator so với OAS

| Nhóm | Route simulator | So với OAS |
|---|---|---|
| Khớp (39 / 46 route) | auth.shops, product search/detail/create/edit/activate/deactivate/listing_check/categories/brands/images/files upload, warehouses, inventory update, order search/detail 202507, fulfillment ×4, return/cancellation ×9, CS ×5, coupon ×2, event webhooks ×3 | Khớp method + path + version |
| Lệch L1 | `GET /product/202309/attributes` | OAS: `GET /product/202309/categories/{category_id}/attributes` |
| Lệch L2 | `GET /product/202309/rules` | OAS: `GET /product/202309/categories/{category_id}/rules`; shape `product_rules.{title_rule…}` **không có trong OAS** |
| Lệch L3 | `POST /return_refund/202602/returns/search` | OAS chỉ có `202309`. Thêm ở commit `593e223`, có test `backend/test/openapi-upgrade-2026.e2e-spec.ts`; **chưa có mục DECISIONS** |
| Lệch L4 | `GET /return_refund/202602/orders/{order_id}/aftersale_eligibility` | OAS có `202309` và `202512`; như L3 |
| Đã ghi nhận | `POST /customer_service/202606/.../messages` | Không có trong OAS; trả 501 theo DECISIONS D8.1. Giữ nguyên |
| Ngoài OAS (hợp lệ) | `GET /api/v2/token/get`, `/refresh` | Auth host riêng, OAS shop API không chứa. Giữ nguyên |

## 2. Nghiệp vụ sandbox của toolkit so với `/test-admin`

Toolkit chỉ có 5 lệnh sandbox. Đây là phần "nghiệp vụ" cụ thể nhất của CLI, ngoài OAS:

| Toolkit | Input / output chính | Simulator hiện tại | Đề xuất |
|---|---|---|---|
| `sandbox shop list --region-code` | danh sách `shop_id` theo region | `GET /test-admin/shops` | Thêm filter `region` (mặc định `VN`) |
| `sandbox product list --shop-id` | `products[].product_id`, `products[].sku_list[].id`, `sku_list[].stock_count`, `limits` | `/demo/shops/:id/products`, không có `stock_count` / `limits` | Thêm `GET /test-admin/sandbox/products?shopId=` trả đúng shape toolkit, gồm `stock_count` = tổng `InventoryLevel.quantity` và `limits` (max quantity, max order_count) |
| `sandbox order create --item <product>:<sku>:<qty> --order-count --logistics-service-id --payment-method` | `created[].order_id`, `failed[]`, `request_id`; batch có thể vừa created vừa failed | Order chỉ tạo qua buyer checkout `/demo` hoặc scenario seed | Thêm `POST /test-admin/sandbox/orders`: lặp `order_count` lần qua `OrdersService.checkout` (+`pay`), gom `created` / `failed`, **không rollback** đơn đã tạo. Mỗi đơn dùng `checkoutKey` riêng để giữ idempotency |
| `sandbox order list --page-size 10` | danh sách đơn với state canonical | `GET /test-admin/orders` | Thêm `pageSize` (≤10) và trả thêm `canonical_status` |
| `sandbox order transition <id>` | **một bước**, không truyền state đích; trả `before_status`, `after_status`, `transitioned` | `POST /test-admin/orders/:ref/transition` **bắt buộc `to`** | Cho phép `to` optional: khi bỏ trống thì chọn bước "happy path" kế tiếp (bảng dưới). Trả thêm `before_status`, `after_status`, `transitioned` (false nếu state cuối) |

**Bước kế tiếp mặc định** (dựa trên `TRANSITIONS` trong `orders/order-state.ts`, bỏ nhánh `CANCELLED`):
`UNPAID → ON_HOLD → AWAITING_SHIPMENT → AWAITING_COLLECTION → IN_TRANSIT → DELIVERED → COMPLETED`.
Khi đến `COMPLETED` / `CANCELLED` thì trả `transitioned:false`.
Bước `UNPAID → ON_HOLD` phải đi qua `OrdersService.pay()` (đặt `paidAt` và `releaseAt`), không phải transition trơn. Bước `AWAITING_SHIPMENT → AWAITING_COLLECTION` phải đi qua `FulfillmentService.arrangeShipment` để package/tracking được tạo đúng như luồng thật. Bước `AWAITING_COLLECTION → IN_TRANSIT` đi qua `advanceShipment`.

**State canonical của toolkit** gồm `UNKNOWN, UNPAID, ON_HOLD, TO_SHIP, AWAITING_SHIPMENT, AWAITING_COLLECTION, CANCEL_PENDING, PARTIALLY_SHIPPING, SHIPPED, IN_TRANSIT, DELIVERED, COMPLETED, CANCELLED`. So với simulator:
- `TO_SHIP`, `SHIPPED`, `CANCEL_PENDING`, `UNKNOWN` **không có** trong `ORDER_STATUSES`. OAS `order.detail.status` cũng không liệt kê chúng, nên **không thêm** vào state machine của TikTok API.
- Chỉ ánh xạ ở tầng test-admin (`canonical_status`):
  - `CANCEL_PENDING` = `AWAITING_SHIPMENT` + `buyerRequestedCancel=true`
  - `TO_SHIP` ≈ `AWAITING_SHIPMENT`
  - `SHIPPED` ≈ `IN_TRANSIT`
  - Ghi vào DECISIONS.md là giả định.

## 3. Ký request: toolkit so với `backend/src/tiktok/signature.ts`

| Điểm | Toolkit (`W6`) | Simulator (`apiStringToSign`) | Kết luận |
|---|---|---|---|
| Chuỗi ký | `secret + path + Σ(key+value) + body + secret` | giống | Khớp |
| HMAC | SHA-256, key = `app_secret`, hex | giống | Khớp |
| Key loại trừ | `sign`, `access_token` (không phân biệt hoa thường) | `sign`, `access_token` (phân biệt hoa thường) | Chỉ quan sát, **không đổi code** |
| Sort key | `localeCompare` | `Array.sort()` (UTF-16 code unit) | Chỉ quan sát, **không đổi code**. Key snake_case thường cho kết quả như nhau |

Lưu ý: `W6` chỉ xác thực request từ agent tới **local broker** của toolkit. Trước khi forward lên TikTok, broker (`G6`) xoá `sign`, `timestamp`, `access_token`, `nonce`, nên đây **không phải** signer của TikTok.
- Không sửa simulator theo nó.
- Không dựa vào nó để nâng `signing` lên verified.
- Nếu thêm test vector thì ghi rõ nguồn là "toolkit local broker".

## 4. Kế hoạch theo ưu tiên

Mẫu cho mỗi operation:
- **OAS**: method, path, version, khả năng áp dụng cho VN
- **Query/Body**: field chính (đủ ở Phụ lục A)
- **Logic**: service tái sử dụng, transition, tồn kho, webhook
- **Prisma**: migration mới nếu cần (**không sửa migration đã apply**)
- **Scope**
- **Đi kèm**: `openapi/` paths, `manifest.json` (status `unverified`), `docs/support-matrix.md`, e2e test, `npm run openapi:export`

### P0. Sửa lệch trên route đã có

**P0-1. Category attributes và rules đúng path (L1, L2)**
- OAS:
  - `GET /product/202309/categories/{category_id}/attributes`
  - `GET /product/202309/categories/{category_id}/rules`
- Query: `category_id` (path, required, phải là leaf), `locale`, `category_version`.
- Response:
  - attributes: `attributes[]{id,name,type(SALES_PROPERTY/PRODUCT_PROPERTY),is_requried,is_multiple_selection,is_customizable,values[]{id,name},requirement_conditions[]}`. Giữ nguyên chính tả `is_requried` như OAS.
  - rules: `cod.is_supported`, `package_dimension.is_required`, `size_chart{is_required,is_supported}`, `product_certifications[]`, `epr`, `fees[]`, `allowed_special_product_types[]`. Bỏ `manufacturer` / `responsible_person` vì chỉ áp dụng EU.
- Logic:
  - Dữ liệu tĩnh theo `category_id` (map trong code, như `ATTRIBUTES_DATA` hiện tại).
  - Nếu `category_id` không phải leaf, hoặc không tồn tại trong `CATEGORIES_DATA`, trả `invalid_input`.
  - Với VN: `cod.is_supported=true`.
- Route cũ: `GET /product/202309/attributes` và `/rules` chuyển sang trả **501 `unsupported_operation`**, giống D8.1.
  - Hai route này được thêm cùng commit `593e223` và có test trong `backend/test/openapi-upgrade-2026.e2e-spec.ts`. Test phải sửa theo.
  - Thêm DECISIONS D-mới: "path cũ không có trong OAS".
- Scope: `SCOPE_PRODUCT_READ`. Không cần migration.

**P0-2. Get Brands: phân trang và filter**
- Hiện handler bỏ qua mọi query. OAS **bắt buộc `page_size`** [1-100].
- Query: `page_size`*, `page_token`, `category_id`, `is_authorized`, `brand_name` (lọc theo prefix), `category_version`.
- Logic:
  - Thiếu `page_size` hoặc ngoài [1,100] thì trả `invalid_input`.
  - Lọc `brand_name` bằng `startsWith`, không phân biệt hoa thường.
  - `page_token` là offset mã hoá base64. Dùng lại helper page_token sẵn có nếu có.
  - Khi có `category_id` thì trả thêm `brand_status: AVAILABLE`.
- Response: `brands[]{id,name,authorized_status,brand_status,is_t1_brand}`, `next_page_token`, `total_count`.

**P0-3. Get Categories: filter**
- Query: `locale`, `keyword` (lọc `local_name`), `include_prohibited_categories`, `category_version`.
- Response: `categories[]{id,parent_id,local_name,is_leaf,permission_statuses[]}`.
- Logic:
  - Nếu có `keyword` thì lọc theo `local_name.includes(keyword)`.
  - Nếu `include_prohibited_categories !== 'true'` thì ẩn category có `permission_statuses` chứa `INVITE_ONLY` / `NON_MAIN_CATEGORY`, nếu seed có dữ liệu đó.
  - Bỏ `listing_platform` vì chỉ áp dụng Tokopedia.

**P0-4. Query param còn thiếu trên route đã có**
- `GET /product/202309/products/{id}`:
  - Nhận `return_under_review_version`, `return_draft_version`, `locale`.
  - Simulator không có bản draft, nên chỉ cần validate kiểu boolean và bỏ qua giá trị.
  - Ghi lại trong DECISIONS.
- `GET /customer_service/202309/conversations` và `.../messages`: nhận `locale`, validate dạng BCP-47, không đổi nội dung.
- **Không** thêm `is_diagnosis_required` vào listing_check, vì OAS đánh dấu deprecated.

**P0-5. Route 202602 (L3, L4)**
- Đang được test `openapi-upgrade-2026.e2e-spec.ts` dùng.
- **Đã chọn A** (xem DECISIONS **DA-1**, **DA-2**).
  - Giữ hai route alias trả thành công, status manifest để `unverified`, không đổi code.
  - SmartOmni tiếp tục gọi 202309 và 202512.
  - DA-2 ghi rõ: `arbitration_status` và `seller_proposed_return_type` là field body của 202309 theo OAS, thay cho phần tương ứng trong D07b-10.
- Việc còn lại (tuỳ chọn, cùng nhóm return): bỏ key thừa `returns` trong response Search Returns. OAS chỉ có `return_orders`, `next_page_token`, `total_count`.

**P0-6. Body của Create/Edit/Listing check product**
- Hiện chỉ đọc `title`, `description`, `skus`. Model `Product` không có `category_id`, `brand_id`, `main_images`, `package_*`.
- Cần **migration mới** thêm vào `Product`:
  - `categoryId String?`, `brandId String?`
  - `mainImages Json @default("[]")`
  - `packageWeight Json?`, `packageDimensions Json?`
  - `productAttributes Json @default("[]")`
  - `isCodAllowed Boolean @default(false)`
  - `externalProductId String?`
- Validate theo P0-1:
  - `category_id` phải là leaf.
  - Thuộc tính `is_requried` phải có trong `product_attributes`.
  - Nếu rule bắt buộc `package_dimension` thì phải có `package_dimensions`.
- `listing_check` dùng cùng hàm validate. Trả `check_result: PASS/FAILED` và `fail_reasons[]`.
- `product.detail` trả lại các field đã lưu (`category_chains`, `brand`, `main_images`, `package_*`).
- Bỏ qua các field chỉ áp dụng EU / Tokopedia / BR (`manufacturer_ids`, `responsible_person_ids`, `listing_platforms`, `is_pre_owned`, `minimum_order_quantity`).

### P1. Operation áp dụng cho VN, dựng trên model hiện có

**P1-1. Seller Cancel Order: `POST /return_refund/202309/cancellations`**
- Body: `order_id`, `cancel_reason`, `order_line_item_ids[]`, `skus[]{sku_id,quantity}`.
- Response: `cancel_id`, `cancel_status`.
- Logic:
  - Thêm `AftersaleService.sellerCancel(shopId, orderExternalId, reason, lineIds?)`. Tách phần insert từ `createCancellation`, nhưng `role='SELLER'`, `type='CANCEL'`.
  - Cho phép khi `order.status ∈ {UNPAID, ON_HOLD, AWAITING_SHIPMENT}`, kiểm tra bằng `canTransition(status,'CANCELLED')` và chặn nếu đã có package.
  - Seller tự huỷ thì **thành công ngay**:
    - status `CANCELLATION_REQUEST_SUCCESS`
    - `orders.transition(order,'CANCELLED','SELLER',{initiator:'SELLER',cancelReason})` trong **cùng transaction** với việc tạo request. Hiện `OrdersService.transition()` tự mở `$transaction` và không nhận `tx`, nên cần refactor tách phần thân thành `transitionTx(tx, …)`.
    - Transition đã hoàn tồn kho (`InventoryChange`) và emit `ORDER_STATUS_CHANGE`
    - Emit thêm `CANCELLATION_STATUS_CHANGE`
  - Huỷ một phần dòng: VN không hỗ trợ (OAS chỉ nói US/UK), nên nếu `order_line_item_ids` khác toàn bộ đơn thì trả `invalid_input`.
  - Idempotency: nếu đơn đã `CANCELLED` bởi một request SELLER trước đó thì trả lại `cancel_id` cũ.
- Scope: `SCOPE_AFTERSALE_WRITE`. Không cần migration.

**P1-2. Create Return thay buyer: `POST /return_refund/202309/returns?idempotency_key=`**
- Body: `order_id`, `return_type` (REFUND / RETURN_AND_REFUND), `return_reason`, `order_line_item_ids[]`, `skus[]`, `refund_total`, `currency`, `handover_method`, `shipment_type`.
- Response: `return_id`, `return_status`.
- Logic:
  - Dùng lại luồng tạo return của buyer (`/demo .../aftersale/returns`), đổi `role='SELLER'`.
  - Chỉ cho phép khi `order.status ∈ {DELIVERED, COMPLETED}`. Kiểm tra bằng `eligibility()` sẵn có.
  - Unit đã có `AftersaleLine.active=true` thì từ chối (partial unique index đã bảo vệ).
  - `refund_total` ≤ refundable (tính như P1-3), ngược lại trả `invalid_input`.
  - `currency` phải bằng `order.currency` (VND).
  - Idempotency:
    - `AftersaleRecord.idempotencyKey` hiện unique theo `(requestId, idempotencyKey)`, tức là gắn với request **đã tồn tại**. Không dùng được để phát hiện *create* lặp.
    - Cần **migration mới**: `AftersaleRequest.idempotencyKey String?` + `@@unique([shopId, idempotencyKey])`.
    - Gọi lặp cùng key thì trả lại cùng `return_id`.
  - Emit `RETURN_STATUS_CHANGE`.

**P1-3. Calculate Refund: `POST /return_refund/202309/refunds/calculate`**
- Body: `order_id`, `request_type` (CANCEL / REFUND / RETURN_AND_REFUND), `order_line_item_ids[]`, `skus[]`, `reason_name`, `handover_method`, `shipment_type`.
- Response: `order_refund_amount{currency,refund_subtotal,refund_shipping_fee,refund_tax,refund_total}`. Bỏ `retail_delivery_fee` vì chỉ áp dụng US.
- Logic:
  - Hàm thuần, không ghi DB. Dùng `unitPaid(line)` của `aftersale.service`.
  - `refund_subtotal` = Σ unitPaid của các dòng chưa active.
  - `refund_shipping_fee` = `originalShippingFee - shippingFeeDiscount` chỉ khi `CANCEL` hoặc hoàn toàn bộ đơn, ngược lại = 0. Giống `createCancellation`.
  - `refund_tax` = 0 (VN, `Order.tax`).
  - Số tiền trả dạng **string**.

**P1-4. Update Price: `POST /product/202309/products/{product_id}/prices/update`**
- Body: `skus[]{id, price{amount,currency}}`. Bỏ `list_price` / `external_list_prices` vì chỉ áp dụng US.
- Response: `{}`.
- Logic:
  - Product phải `ACTIVATE` (OAS).
  - Mọi `id` phải thuộc product.
  - `currency='VND'`; `amount` là số nguyên dương, ghi vào `Sku.priceVnd`.
  - Một transaction cho cả batch: lỗi một SKU thì không ghi SKU nào.
  - Không đổi giá các đơn đã tạo (giá đã snapshot ở `OrderLine`).
  - Emit `PRODUCT_STATUS_CHANGE` nếu manifest định nghĩa, ngược lại không emit.
- Scope: `SCOPE_PRODUCT_WRITE`.

**P1-5. Inventory Search: `POST /product/202309/inventory/search`**
- Body: `product_ids[]` (≤100) **hoặc** `sku_ids[]` (≤600). Nếu có cả hai thì ưu tiên `sku_ids` (OAS).
- Response: `inventory[]{product_id, skus[]{id, seller_sku, total_available_quantity, total_committed_quantity, total_available_inventory_distribution, warehouse_inventory[]}}`.
  - Tên field con của `warehouse_inventory` lấy từ OAS (cấp 4, Phụ lục A chỉ in tới cấp 2).
  - `total_committed_quantity` = số lượng đang bị đơn chưa giao giữ chỗ (reservation từ checkout).
- Logic:
  - Đọc `InventoryLevel` theo shop của token.
  - ID không thuộc shop thì bỏ qua, không lộ dữ liệu shop khác.
  - Dùng chung mapper với inventory snapshot hiện có (commit `d4e6449`).
- Scope: `SCOPE_PRODUCT_READ` (hoặc scope inventory read nếu có).

**P1-6. Delete / Recover Products**
- `DELETE /product/202309/products`:
  - Body `product_ids[]` (≤20).
  - Đặt `status='DELETED'` (soft delete, schema đã cho phép).
  - Chỉ áp dụng cho product không phải `FREEZE`.
  - Product đã xoá thì `product.search` / `detail` không trả (OAS: GetProduct "except FREEZE or DELETED").
- `POST /product/202309/products/recover`: body `product_ids[]` (≤20), chuyển `DELETED → SELLER_DEACTIVATED` (OAS).
- Response chung: `errors[]{code,message,detail{product_id}}`. Mỗi ID lỗi là một phần tử, các ID hợp lệ vẫn được xử lý (thành công một phần).
- Đơn đang mở của SKU bị xoá không bị ảnh hưởng. Giỏ hàng (`CartItem`) của SKU đó bị xoá trong cùng transaction.

**P1-7. Search Packages: `POST /fulfillment/202309/packages/search`**
- Query: `page_size`* [1-50], `page_token`, `sort_field` (create_time / update_time), `sort_order`.
- Body: `create_time_ge/lt`, `update_time_ge/lt`, `package_status`.
- Response: `packages[]{id,status,tracking_number,shipping_provider_id,shipping_provider_name,create_time,update_time,order_line_item_ids[],orders[]}`, `next_page_token`, `total_count`.
- Logic:
  - Truy vấn `Package` theo `shopId`.
  - Map trạng thái nội bộ sang tập OAS (`PROCESSING / FULFILLING / COMPLETED / CANCELLED`) bằng cùng mapper `package_detail`.
  - Phân trang keyset theo `(createdAt, id)`.
  - Thời gian lấy theo `BusinessClock`.

**P1-8. Batch Ship Packages: `POST /fulfillment/202309/packages/ship`**
- Body: `packages[]{id, handover_method(PICKUP/DROP_OFF), pickup_slot{start_time,end_time}, self_shipment{tracking_number,shipping_provider_id}}`.
- Response: `errors[]{code,message,detail{package_id}}`.
- Logic:
  - Lặp qua từng package, gọi lại logic của `POST /packages/{id}/ship` (`FulfillmentService.arrangeShipment`).
  - **Mỗi package một transaction**, để một package lỗi không chặn các package khác.
  - Gom lỗi vào `errors`.

**P1-9. Read Message: `POST /customer_service/202309/conversations/{conversation_id}/messages/read`**
- Body rỗng, response `{}`.
- Logic:
  - Hiện `ChatService.unreadFor()` đếm tin BUYER có `seq` lớn hơn tin trả lời cuối của seller. Chưa có khái niệm "đã đọc mà chưa trả lời".
  - Thêm cột `Conversation.sellerReadSeq Int @default(0)` (**migration mới**).
  - ReadMessage đặt `sellerReadSeq` = `seq` lớn nhất hiện có.
  - `unreadFor` đổi điều kiện thành `seq > max(lastReply.seq, sellerReadSeq)`. Sau đó `unread_count` của `GET conversations` về 0.
- Scope: `SCOPE_CONVERSATION_WRITE`.

**P1-10. Create Conversation: `POST /customer_service/202309/conversations`**
- Body: `buyer_user_id` (= `orders.user_id` của order detail).
- Response: `conversation_id`.
- Logic:
  - Tìm `Buyer` theo `buyer_user_id` trong shop của token, không có thì trả `invalid_input`.
  - Gọi `ChatService.conversationForBuyer(shopId, buyerId)`. Hàm này đã idempotent: có hội thoại rồi thì trả lại hội thoại đó.
  - Emit `NEW_CONVERSATION` chỉ khi hội thoại được tạo mới.

### P2. Áp dụng VN nhưng ít giá trị hoặc cần thêm model

| Operation | Ghi chú logic |
|---|---|
| `GET /fulfillment/202309/packages/{package_id}/handover_time_slots` | Sinh 3 slot pickup theo `BusinessClock` (ngày +1..+3, 9h-12h); `can_pickup=true`, `can_drop_off=true`, `can_van_collection=false` (UK) |
| `POST /fulfillment/202309/packages/{package_id}/shipping_info/update` | Đổi `trackingNumber` / `shippingProvider` khi package chưa `COMPLETED`; thêm `TrackingEvent` |
| `POST /fulfillment/202309/packages/deliver` | Chỉ cho seller tự giao (SOF). `DELIVERY_SUCCESS` → `orders.transition(…,'DELIVERED')`; `DELIVERY_FAILED` bắt buộc `fail_delivery_reason` |
| `GET` / `PUT /customer_service/202309/agents/settings` | Thêm cột `Shop.agentCanAcceptChat Boolean @default(true)` (migration) |
| `DELETE /authorization/202403/shops` | Thu hồi mọi `Token` của app + shop (`TokenStatus` revoked), emit `SELLER_DEAUTHORIZATION` |
| `GET /logistics/202309/warehouses/{id}/delivery_options` và `GET /logistics/202309/delivery_options/{id}/shipping_providers` | Dữ liệu tĩnh (STANDARD / EXPRESS); provider lấy từ danh sách mà `Package.shippingProvider*` đang dùng để đồng nhất |
| `GET /order/202407/orders/{order_id}/price_detail` | Tính từ các cột giá của `Order` / `OrderLine`; số tiền dạng string; `cod_fee`, `distance_fee` = `"0"` |
| `POST /product/202509/products/{id}/partial_edit` | Sau P0-6: merge một phần các field đã lưu |

### Không áp dụng cho VN (không làm)

- US only: `POST /fulfillment/202309/packages` (CreatePackages, mua nhãn) và `POST /fulfillment/202309/orders/{id}/shipping_services/query`.
- UK only: van collection.
- EU only: manufacturer / responsible person.
- Tokopedia / ID only: `listing_platforms`, `is_pre_owned`, `minimum_order_quantity`.
- Global seller: các API `global_products/*`.
- `GET /order/202309/orders`: bản cũ hơn 202507, không cần.

## 5. Quy trình theo phase (test xong thì commit)

Làm lần lượt **P0 → P1 → P2**. Mỗi phase chia thành các hạng mục nhỏ (P0-1, P0-2, …).

1. **Trước khi sửa:** đưa plan ngắn của phase và chờ user gõ **"go"**.
2. **Nhánh:** làm trên nhánh riêng `feature/tts-oas-alignment`, tách từ `develop`. Không làm trên `feature/oauth-mobile-redirect`, không commit thẳng vào `develop`/`main`.
3. **Cổng test của phase.** Phase chỉ được coi là xong khi tất cả lệnh sau đều pass:
   - Trong `backend/`: `npm run typecheck && npm run lint && npm run build && npm test`. `npm test` gồm cả e2e mới của phase, `test/openapi.e2e-spec.ts` và `test/routers.e2e-spec.ts`.
   - Nếu phase có đổi route: chạy `npm run openapi:export`, và `docs/openapi.json` phải được cập nhật.
   - Nếu phase có sửa `frontend/`: trong `frontend/` chạy `npm run typecheck && npm run lint && npm test && npm run build`.
   - Nếu phase có sửa `contracts/`: `node --experimental-strip-types --test contracts/validator/contract.test.ts`.
4. **Commit khi và chỉ khi cổng test pass:**
   - Mỗi phase **một commit** (hoặc mỗi hạng mục một commit nếu phase lớn). Dùng Conventional Commits có scope, ví dụ `feat(aftersale): add seller cancel order (P1-1)`.
   - Chỉ stage file liên quan tới phase, kèm migration mới, `docs/openapi.json`, `contracts/manifest.json`, `docs/support-matrix.md`, `DECISIONS.md`.
   - Test fail thì **không commit**. Báo kết quả fail (kèm output), sửa rồi chạy lại cả cổng.
5. **Báo cáo sau mỗi phase:** kết quả từng lệnh test (pass/fail), hash commit, và việc còn lại.
6. **Push và PR:** chỉ làm khi user yêu cầu.

## 6. Quy tắc chung khi triển khai

- Mọi route mới gắn `TiktokApiGuard` + `@RequireScope`, đi qua `TiktokFaultFilter`, envelope `{code,message,request_id,data}`.
- Không import module mới vào `TiktokModule` ngoài danh sách mà `test/routers.e2e-spec.ts` cho phép. Nếu cần, cập nhật test đó có lý do.
- Validate bằng zod, không dùng DTO. Cập nhật `backend/src/openapi/*.paths.ts`, rồi chạy `npm run openapi:export`. `test/openapi.e2e-spec.ts` sẽ fail nếu quên.
- Thêm entry vào `contracts/manifest.json` (`unverified`, `evidence: official-oas`) và snapshot OAS (`contracts/tools/build-from-oas.mjs`).
- Thay đổi schema thì tạo **migration mới**.
- Fault (`HTTP_ERROR / DELAY / DROP / DUPLICATE`) tự áp dụng cho route mới, vì chúng nằm trên TikTok router.
- Mỗi giả định ghi vào `DECISIONS.md`.
- Test: mỗi operation có một e2e spec, gồm happy path, sai scope, `shop_cipher` mismatch, input sai và idempotency (nếu có).

---

## Phụ lục A. Query / body / response từ OAS (sinh tự động)

Sinh bằng script đọc `references/oas/paths/*.json`, độ sâu 2 cấp; mô tả bị cắt ở 110 ký tự. Bỏ các tham số chung `app_key`, `sign`, `timestamp`, `shop_cipher`, `x-tts-access-token`, `content-type`. OAS **không khai báo `required` cho field body**; chỉ query/path có cờ `required`.

### `GET /product/202309/categories/{category_id}/attributes` — GetAttributes

> Retrieve the standard built-in product and sales attributes for listing a product in a particular category bas

**Query / path:**

- path `category_id` string **required** — The ID of the category of this product. It must be a leaf category.
- query `locale` string — The BCP-47 locale codes for displaying the attribute information. Default: The default locale of your shop. Po
- query `category_version` string — The category tree version that corresponds to the specified `category_id`. Possible values based on region: -

**Response `data`:**

- `attributes` object[] — The list of standard built-in product and sales attributes that are bound to the specified category, based on
  - `id` string — The ID of the built-in attribute.
  - `is_customizable` boolean — A flag to indicate if the product attribute value can be customized by sellers when creating or editing a prod
  - `is_multiple_selection` boolean — A flag to indicate if multiple values can be provided for a product attribute when creating or editing a produ
  - `is_requried` boolean — A flag to indicate if the product attribute is always required when creating or editing a product. - true: The
  - `name` string — The name of the built-in attribute.
  - `requirement_conditions` object[] — A list of conditions that determine if the product attribute is required based on the seller's inputs for othe
  - `type` string — The attribute type. Possible values: - SALES_PROPERTY: Indicates sales attributes that define product variants
  - `value_data_format` string — The supported data type and structure of the attribute value for free-form entries, such as strings, integers,
  - `values` object[] — A list of selectable values for the attribute.

### `GET /product/202309/categories/{category_id}/rules` — GetCategoryRules

> Retrieve the additional requirements (beyond mandatory product attributes) for listing a product in a particul

**Query / path:**

- path `category_id` string **required** — The ID of the category. It must be a leaf category.
- query `category_version` string — The category tree version that corresponds to the specified `category_id`. Possible values based on region: -
- query `locale` string — The BCP-47 locale codes for displaying category information. Default: en-US Possible values: - de-DE - en-GB -

**Response `data`:**

- `allowed_special_product_types` string[] — The list of special product types, excluding regular products, that your shop is allowed to list in this categ
- `cod` object — Cash on Delivery (COD) related rules. Applicable only for the following markets: - Global sellers: MY, PH, SA,
  - `is_supported` boolean — A flag to indicate whether COD is supported. **Note**: If COD is not supported, but you set `is_cod_allowed=tr
- `epr` object — Extended Producer Responsibility (EPR) related rules.
  - `is_required` boolean — A flag to indicate whether EPR is required.
- `fees` object[] — Product fees related rules.
  - `is_required` boolean — A flag to indicate whether information about the fee is required.
  - `type` string — The type of fee. Possible values: PFAND
- `manufacturer` object — Manufacturer related rules. Applicable only for the EU market.
  - `is_required` boolean — A flag to indicate whether the manufacturer information is required.
- `package_dimension` object — Package dimension related rules.
  - `is_required` boolean — A flag to indicate whether package dimensions are required.
- `product_certifications` object[] — Certification related rules. As per TikTok Shop guidelines, certifications are required for certain restricted
  - `document_details` string — Details about the certification documents that you must submit, including the content, format, and any other g
  - `expiration_date` object — Certification expiration date related rules.
  - `id` string — The ID to identify the type of certification required.
  - `is_required` boolean — A flag to indicate if the certification is always required when creating or editing a product. - true: The cer
  - `name` string — The name of the certification type.
  - `requirement_conditions` object[] — A list of conditions that determine if the certification is required based on the seller's inputs for a produc
  - `sample_image_url` string — The URL to view an image of the sample certification document.
- `responsible_person` object — Responsible person (RP) related rules. Applicable only for the EU market.
  - `is_required` boolean — A flag to indicate whether the responsible person information is required.
- `size_chart` object — Size chart related rules.
  - `is_required` boolean — A flag to indicate whether a size chart is required.
  - `is_supported` boolean — A flag to indicate whether size charts are supported. **Note**: If size charts are not supported, even if you

### `GET /product/202309/brands` — GetBrands

> Retrieve all available brands for your shop, including the built-in brands and any custom brands created using

**Query / path:**

- query `category_id` string — Specify a category ID to show the availability of **authorized brands** in the category. **Note**: Specify thi
- query `is_authorized` boolean — Filter results by the brand authorization status. Possible values: - 1: Returns only authorized brands - 0: Re
- query `brand_name` string — Filter results to include brand names that begin with the specified value.
- query `page_size` integer **required** — The number of results to be returned per page. Valid range: [1-100]
- query `page_token` string — An opaque token used to retrieve the next page of a paginated result set. Retrieve this value from the result
- query `category_version` string — The category tree version that corresponds to the specified `category_id`. Possible values based on region: -

**Response `data`:**

- `brands` object[] — The list of brands that meet the query conditions.
  - `authorized_status` string — A status to indicate whether the seller has obtained prior authorization to sell goods bearing the brand's tra
  - `brand_status` string — The availability of an **authorized brand** in the requested category. Possible values: - AVAILABLE - UNAVAILA
  - `id` string — The brand ID.
  - `is_t1_brand` boolean — A flag to indicate whether the brand is a T1 brand, which refers to internationally renowned brands that may h
  - `name` string — The brand name.
- `next_page_token` string — An opaque token used to retrieve the next page of a paginated result set. Provide this value in the `page_toke
- `total_count` integer — The total count of brands that meet the query conditions.

### `GET /product/202309/categories` — GetCategories

> Retrieve the list of product categories available for your shop. Product categories are updated frequently, so

**Query / path:**

- query `locale` string — The BCP-47 locale codes for displaying category information. Default: The default locale of your shop. Possibl
- query `keyword` string — Filter categories by this keyword in `local_name`.
- query `category_version` string — Filter categories by the category tree version. Possible values based on region: - US: `v2`, represents the 7-
- query `listing_platform` string — Filter categories by the specified platform. Possible values: - TIKTOK_SHOP - TOKOPEDIA Default: TIKTOK_SHOP A
- query `include_prohibited_categories` boolean — A flag to indicate whether to include categories that are prohibited on TikTok Shop. Set this to `true` to ide

**Response `data`:**

- `categories` object[] — The list of categories that meet the query conditions.
  - `id` string — The category ID.
  - `is_leaf` boolean — A flag to indicate if the category is a leaf category. **Note**: You can only create or edit products that bel
  - `local_name` string — The name of the category in the country where the shop operates.
  - `parent_id` string — The parent category ID. For the root category, the parent ID is `0`.
  - `permission_statuses` string[] — The shop's permission status for this category. Possible values: - `AVAILABLE`: You have the permission to cre

### `POST /return_refund/202309/cancellations` — CancelOrder

> Use this API to cancel an order on behalf of a seller. In the US and UK markets, when an item is out of stock,

**Body** (OAS không khai báo required cho body):

- `cancel_reason` string — Reason to cancel the order Please see "Return API Overview" for a list of reasons a seller can select to cance
- `order_id` string — TikTok Shop order id
- `order_line_item_ids` string[] — List of order line item ids to cancel. In the US and UK markets, when an item is out of stock, partial cancell
- `skus` object[] — List of SKU to cancel
  - `quantity` integer — The quantity of SKU to cancel
  - `sku_id` string — The SKU id to cancel

**Response `data`:**

- `cancel_id` string — The identifier of a specific order cancellation.
- `cancel_status` string — The status of an order cancellation request. Available values: - CANCELLATION_REQUEST_PENDING - CANCELLATION_R

### `POST /return_refund/202309/returns` — CreateReturn

> Use this API to initiate a return request on behalf of the buyer Sellers can reject the request, or accept and

**Query / path:**

- query `idempotency_key` string — Idempotency Key

**Body** (OAS không khai báo required cho body):

- `currency` string — Currency for refund which should be same as currency in TikTok Ship Order.
- `handover_method` string — Which handover method buyer chooses to use when returning goods to seller by platform - DROP_OFF - PICKUP
- `order_id` string — Tiktok Shop order id
- `order_line_item_ids` string[] — Order line ids seller wants to create return request, should use order line ids to create return request if ha
- `refund_total` string — Total refund amount to the buyer. The total refund amount can not exceed the refundable amount
- `return_reason` string — Seller's reason to create a return
- `return_type` string — Which type to create: - REFUND - RETURN_AND_REFUND
- `shipment_type` string — How buyer ships items to seller when in a return request, could be: - PLATFORM - BUYER_ARRANGE
- `skus` object[] — Skus
  - `quantity` integer — Quantity seller wants to create a return request
  - `sku_id` string — Sku id seller wants to create a return request

**Response `data`:**

- `return_id` string — The identifier of a specific return request.
- `return_status` string — Return status, available values: - RETURN_OR_REFUND_REQUEST_PENDING: Request is pending, needs to be approved

### `POST /return_refund/202309/refunds/calculate` — CalculateRefund

> Use this API to check order refundable amounts.

**Body** (OAS không khai báo required cho body):

- `handover_method` string — Which handover method buyer chooses to use when returning goods to seller by platform - DROP_OFF: buyer drops
- `order_id` string — TikTok Shop order id.
- `order_line_item_ids` string[] — TikTok Shop order line item ids.
- `reason_name` string — Seller's reason to create a return，all available reasons, please reference to API overview.
- `request_type` string — Request type - CANCEL - REFUND - RETURN_AND_REFUND Note: different request types are used for different afters
- `shipment_type` string — How buyer ships items to seller when in a return request, could be: - PLATFORM - BUYER_ARRANGE
- `skus` object[] — skus
  - `quantity` integer — Sku id seller wants to create a return request.
  - `sku_id` string — Quantity seller wants to create a return request.

**Response `data`:**

- `order_refund_amount` object — Refund amount to buyer.
  - `currency` string — Currency for payment.
  - `refund_shipping_fee` string — Shipping fee refund to buyer.
  - `refund_subtotal` string — Total price of item be returned.
  - `refund_tax` string — Tax returned to buyer.
  - `refund_total` string — Total amount refund to buyer.
  - `retail_delivery_fee` string — Retail delivery fee takes effect once platform GMV exceeds 500,000 USD, according to US Colorado states' compl

### `POST /product/202309/products/{product_id}/prices/update` — UpdatePrice

> Update the price of multiple SKUs belonging to a product in the `ACTIVATE` status and not included in any ongo

**Query / path:**

- path `product_id` string **required** — The product ID generated by TikTok Shop.

**Body** (OAS không khai báo required cho body):

- `skus` object[] — A list of Stock Keeping Units (SKUs) used to identify distinct variants of the product.
  - `external_list_prices` object[] — The SKU list price (e.g. MSRP, RRP) or original price information on external ecommerce platforms. Applicable
  - `id` string — The SKU ID generated by TikTok Shop. One product can contain multiple SKU IDs. **Note**: - The SKU ID must bel
  - `list_price` object — The SKU's list price information. This is equivalent to the manufacturer's suggested retail price (MSRP), or t
  - `price` object — SKU pricing information.

**Response `data`:**

- (trống / `{}`)

### `POST /product/202309/inventory/search` — InventorySearch

> Retrieve inventory information for multiple products or SKUs. **Note**: - Searches can be based on either prod

**Body** (OAS không khai báo required cho body):

- `product_ids` string[] — A list of product IDs used to search for inventory information. Max IDs: 100
- `sku_ids` string[] — A list of SKU IDs used to search for inventory information. Max IDs: 600 **Note**: If both `sku_ids` and `prod

**Response `data`:**

- `inventory` object[] — Inventory information for the requested products or SKUs.
  - `product_id` string — The ID of the requested product.
  - `skus` object[] — The list of requested SKUs.

### `DELETE /product/202309/products` — DeleteProducts

> Delete non-frozen products that you no longer need. **For the Indonesia market**: You can only delete products

**Body** (OAS không khai báo required cho body):

- `product_ids` string[] — The product IDs to delete. Max number of IDs: 20.

**Response `data`:**

- `errors` object[] — The list of errors that occurred.
  - `code` integer — The error code.
  - `detail` object — The details of the error.
  - `message` string — The error message.

### `POST /product/202309/products/recover` — RecoverProducts

> Recover products that are in the `Deleted` status. The status changes to `Seller_deactivated` after recovery.

**Body** (OAS không khai báo required cho body):

- `product_ids` string[] — The product IDs to recover. Max number of IDs: 20.

**Response `data`:**

- `errors` object[] — The list of errors that occurred.
  - `code` integer — The main error code.
  - `detail` object — The details of the main error.
  - `message` string — The main error message.

### `POST /fulfillment/202309/packages/search` — SearchPackage

> Retrieve package IDs based on specified conditions. Package creation time and information update time are the

**Query / path:**

- query `page_size` integer **required** — The number of results to be returned per page. Valid range: [1-50].
- query `sort_field` string — The returned results will be sorted by the specified field. Default: `create_time` Possible values: - `create_
- query `sort_order` string — The sort order for the sort_field parameter. Default: `DESC` Possible values: - `ASC`: Ascending order - `DESC
- query `page_token` string — An opaque token used to retrieve the next page of a paginated result set. Retrieve this value from the result

**Body** (OAS không khai báo required cho body):

- `create_time_ge` integer — Filter the packages to show only those that are created after (or at) the specified date and time. Unix timest
- `create_time_lt` integer — Filter the packages to show only those that are created before the specified date and time. Unix timestamp.
- `package_status` string — Possible values: - `PROCESSING`: Package has been arranged by seller. Waiting for carrier to collect the parce
- `update_time_ge` integer — Filter the packages to show only those that are updated after (or at) the specified date and time. Unix timest
- `update_time_lt` integer — Filter the packages to show only those that are updated before the specified date and time. Unix timestamp.

**Response `data`:**

- `next_page_token` string — An opaque token used to retrieve the next page of a paginated result set. Provide this value in the `page_toke
- `packages` object[] — The response list of packages.
  - `create_time` integer — Package creation time. Unix timestamp.
  - `id` string — Package ID.
  - `order_line_item_ids` string[] — The order line item ID contained in the package.
  - `orders` object[] — The response list of TikTok Shop orders.
  - `shipping_provider_id` string — Package shipping provider ID.
  - `shipping_provider_name` string — Package shipping provider.
  - `status` string — Possible values: - `PROCESSING`: Package has been arranged by seller. Waiting for carrier to collect the parce
  - `tracking_number` string — Package tracking number.
  - `update_time` integer — Package latest update time. Unix timestamp
- `total_count` integer — The number of packages that meet the query conditions.

### `POST /fulfillment/202309/packages/ship` — BatchShipPackages

> Use this API to batch ship packages by providing multiple package IDs. This API is available for TikTok shippi

**Body** (OAS không khai báo required cho body):

- `packages` object[] — Input list of packages you would like to batch ship.
  - `handover_method` string — Possible values: - `PICKUP`: A shipping provider will pickup the package(s) from the seller's pickup address.
  - `id` string — Package ID.
  - `pickup_slot` object — Package pickup time slot.
  - `self_shipment` object — Only needed for seller shipping packages. Check the `delivery_option `field in [Get Package Detail](https://pa

**Response `data`:**

- `errors` object[] — Return list of possible errors during package batch shipment attempt.
  - `code` integer — The failure reason code.
  - `detail` object — Error detail.
  - `message` string — The failure reason message.

### `POST /customer_service/202309/conversations` — CreateConversation

> Use this API to create a conversation with the specified buyer, on behalf of a shop. When there's no prior con

**Body** (OAS không khai báo required cho body):

- `buyer_user_id` string — Buyer's user ID The value is the same as `data.orders.user_id` in the response data of [Get Order Detail](650a

**Response `data`:**

- `conversation_id` string — Converstaion ID. The unique identifier for a conversation between the buyer and a shop.

### `POST /customer_service/202309/conversations/{conversation_id}/messages/read` — ReadMessage

> Use this API to mark all messages sent by the buyer as read. You are suggested to call this API before replyin

**Query / path:**

- path `conversation_id` string **required** — 

**Response `data`:**

- (trống / `{}`)

### `GET /fulfillment/202309/packages/{package_id}/handover_time_slots` — GetPackageHandoverTimeSlots

> Use this API to retrieve the time slots available for pickup, drop-off, or van collection for the seller's spe

**Query / path:**

- path `package_id` string **required** — TikTok Shop package ID.

**Response `data`:**

- `can_drop_off` boolean — Whether this package be dropped off at a drop-off location
- `can_pickup` boolean — Whether this package supports door-to-door collection.
- `can_van_collection` boolean — Specific to UK. Use this field to determine whether van collection is available.
- `drop_off_point_url` string — View package drop-off locations via provided URL.
- `pickup_slots` object[] — Time slot for door-to-door collection.
  - `avaliable` boolean — Whether an appointment be made for this time slot.
  - `end_time` integer — The end date and time of the package pick up time slot. Unix timestamp.
  - `start_time` integer — The start date and time of the package pick up time slot. Unix timestamp.

### `POST /fulfillment/202309/packages/{package_id}/shipping_info/update` — UpdatePackageShippingInfo

> If the seller entered an incorrect tracking number, this API allows the seller to update the tracking number a

**Query / path:**

- path `package_id` string **required** — TikTok Shop package ID.

**Body** (OAS không khai báo required cho body):

- `shipping_provider_id` string — Identifies the carrier that will deliver the package. Please call the [Get Shipping Providers API](https://par
- `tracking_number` string — The shipment tracking number provided by the carrier.

**Response `data`:**

- (trống / `{}`)

### `POST /fulfillment/202309/packages/deliver` — UpdatePackageDeliveryStatus

> Use this API to update the delivery status of the package from in transit status. Please note that only seller

**Body** (OAS không khai báo required cho body):

- `packages` object[] — The return list of packages.
  - `delivery_type` string — Delivery status of the package. Possible values: - `DELIVERY_SUCCESS`: Package has been successfully delivered
  - `fail_delivery_reason` string — Delivery failure reasons. When `delivery_type = DELIVERY_FAILED`, this field is required. For other delivery t
  - `file_type` string — Attachment type: - `IMG` - `PDF`
  - `file_url` string — Attachment URL. The seller can use the [Upload Delivery File](https://partner.tiktokshop.com/docv2/page/650aa6
  - `id` string — The package ID.

**Response `data`:**

- `errors` object[] — Specific return information (returns multiple errors and reasons).
  - `code` integer — The failure reason code.
  - `detail` object — Error detail.
  - `message` string — Fulfillment failure reason.

### `GET /customer_service/202309/agents/settings` — GetAgentSettings

> This API is used to get agent settings. This API allows the agent to see whether the agent can accept chats fr

**Response `data`:**

- `can_accept_chat` boolean — Whether the current agent can accept chat. If true, the agent will receive auto-assigned chats. The agent can

### `PUT /customer_service/202309/agents/settings` — UpdateAgentSettings

> Use this API to update agent status on behalf of the agent. Agents can set whether they can accept auto assign

**Body** (OAS không khai báo required cho body):

- `can_accept_chat` boolean — If true, the agent will receive auto-assigned chats. The agent can manually select chats to respond. If false,

**Response `data`:**

- (trống / `{}`)

### `DELETE /authorization/202403/shops` — DeauthorizeShop

> This API is used for developers to deauthorize a shop and notify the seller about this action by email

**Response `data`:**

- (trống / `{}`)

### `GET /logistics/202309/warehouses/{warehouse_id}/delivery_options` — GetWarehouseDeliveryOptions

> This API is used to obtain a list of delivery options available through the seller's designated warehouse.

**Query / path:**

- path `warehouse_id` string **required** — The warehouse ID.
- query `scope` string — Specify the scope of delivery options to retrieve. - `WAREHOUSE`: Returns all delivery options currently activ

**Response `data`:**

- `delivery_options` object[] — List of deliver options available through the seller's warehouse, and the respective carriers and attribute re
  - `description` string — Delivery option description.
  - `dimension_limit` object — The length, width, and height restrictions of the delivery option.
  - `id` string — Delivery option ID.
  - `name` string — Delivery option name.
  - `platform` string[] — The platform on which the delivery option is available Possible values: - TIKTOK_SHOP - TOKOPEDIA
  - `type` string — Delivery option type. This is an enumerated type with values: - STANDARD - EXPRESS - ECONOMY - SEND_BY_SELLER
  - `weight_limit` object — The weight restrictions of this delivery option.

### `GET /logistics/202309/delivery_options/{delivery_option_id}/shipping_providers` — GetShippingProviders

> This API is used to obtain the shipping provider corresponding to the specified delivery option

**Query / path:**

- path `delivery_option_id` string **required** — The specific delivery option identifier for getting the shipping provider list.

**Response `data`:**

- `shipping_providers` object[] — shipping provider list
  - `id` string — shipping provider id
  - `name` string — shipping provider name

### `GET /order/202407/orders/{order_id}/price_detail` — GetPriceDetail

> Get the detailed pricing calculation information of an order or a line item, including vouchers, tax, etc.

**Query / path:**

- path `order_id` string **required** — Order ID

**Response `data`:**

- `cod_fee` string — COD fee charged by shipping aggregators. For regions outside of Saudi Arabia, the value is `0.00`.
- `cod_fee_net_amount` string — COD fee charged by shipping aggregators including tax. For regions outside of Saudi Arabia, the value is `0.00
- `currency` string — Currency Type. Three-letter code, see [ISO 4217](https://www.iso.org/iso-4217-currency-codes.html).
- `distance_fee` string — Total distance fee for Horizon+ Program. Only applicable for ID market
- `distance_shipping_fee` string — Distance shipping fee is fee that charged charged by our logistics partner and covers the separate distance-ba
- `line_items` object[] — Each object is the same as the "data" field (line 5) without "line_items"
  - `cod_fee` string — COD fee charged by shipping aggregators. For regions outside of Saudi Arabia, the value is `0.00`.
  - `cod_fee_amount` string — COD fee charged by shipping aggregators including tax. For regions outside of Saudi Arabia, the value is `0.00
  - `currency` string — Currency Type. Three-letter code, see [ISO 4217](https://www.iso.org/iso-4217-currency-codes.html).
  - `distance_fee` string — Total distance fee for Horizon+ Program. Only applicable for ID market
  - `distance_shipping_fee` string — Distance shipping fee is fee that charged charged by our logistics partner and covers the separate distance-ba
  - `id` string — corresponding line_item id
  - `net_price_amount` string — Price after tax
  - `payment` string — Payment of the order from the buyer. Calculation: `sku_sale_price` + `shipping_sale_price` + `tax_amount` + `s
  - `shipping_fee_deduction_platform` string — Shipping discount covered by the platform
  - `shipping_fee_deduction_platform_voucher` string — Shipping discount covered by the platform voucher `1010000`: PLATFORM_NEW_USER `1020000`: SELLER_SKU_PRICE `10
  - `shipping_fee_deduction_seller` string — Shipping discount covered by the seller.
  - `shipping_list_price` string — Original shipping price
  - `shipping_sale_price` string — Promotional shipping price Calculation: shipping_list_price - shipping_fee_deduction -shipping_fee_deduction_p
  - `sku_gift_net_price` string — Original sku list price of the gift product from the seller including tax.
  - `sku_gift_original_price` string — Original sku list price of the gift product from the seller.
  - `sku_list_price` string — Total MSRP price of the products.
  - `sku_sale_price` string — Total promotional sale price of the products. Calculation: `sku_list_price` - `subtotal_deduction_seller` - `s
  - `subtotal` string — Total promotional sale price of the products including tax. Calculation: `sku_sale_price` + `subtotal_tax_amou
  - `subtotal_deduction_platform` string — Platform provided price discount on the product
  - `subtotal_deduction_seller` string — Seller provided price discount on the product
  - `subtotal_tax_amount` string — Total tax amount on the product
  - `tax_amount` string — Total tax amount. Calculation: subtotal_tax_amount + shipping_fee_tax（in TaxDetail） + cod_fee_tax（TaxDetail）
  - `tax_rate` string — Tax rate
  - `total` string — Total number of the original price of the order. Calculation: `sku_list_price` + `shipping_list_price`
- … (22 dòng nữa, xem OAS)
