# Plan: bỏ trạng thái ON_HOLD khỏi simulator

Mục tiêu: thanh toán xong thì đơn đi thẳng `UNPAID → AWAITING_SHIPMENT`. Simulator không còn tạo, lưu hay
chuyển sang `ON_HOLD`, không còn thời gian giữ đơn, timer giải phóng hay endpoint `release-due`.

Branch: `feature/remove-on-hold`, tách từ `develop` (`1ff8a27`, đã gồm voucher-batches và frontend mới).
Mỗi phase chỉ commit khi gate của phase đó pass. Không push, không mở PR nếu chưa được yêu cầu.

---

## Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| H1 | State machine mới: `UNPAID → AWAITING_SHIPMENT \| CANCELLED`. `ON_HOLD` bị xóa khỏi `ORDER_STATUSES` và `TRANSITIONS`. | Yêu cầu của người dùng (cách B). Lệch khỏi TikTok thật, nên ghi vào `DECISIONS.md` và đánh dấu D3/D8 là superseded. |
| H2 | `pay()` đặt `paidAt` rồi transition thẳng sang `AWAITING_SHIPMENT`. Package `TO_FULFILL` được tạo ngay lúc thanh toán, do listener fulfillment hiện có. | Không cần cơ chế mới; listener đã chạy khi đơn vào `AWAITING_SHIPMENT`. |
| H3 | **Không sửa `contracts/`.** Snapshot là bản OAS chính thức, schema `status` không có enum và các field on-hold không bắt buộc. Contract test phải pass mà không đổi gì. | Contract là nguồn sự thật về API TikTok, không phải về simulator. |
| H4 | API TikTok vẫn trả `is_on_hold_order: false` (hằng số) trong order detail/search và webhook `ORDER_STATUS_CHANGE`. Bỏ `release_date`. | `is_on_hold_order` là field OAS SmartOmni có thể đọc. `release_date` vốn tự biến mất khi không có giá trị. |
| H5 | Search Order với `order_status: "ON_HOLD"` vẫn **hợp lệ** (là giá trị OAS), luôn trả danh sách rỗng. Giá trị không có trong OAS vẫn là `invalid_input`. | Không làm hỏng SmartOmni nếu nó lọc theo ON_HOLD. Tách `OAS_ORDER_STATUSES` (để validate filter) khỏi `ORDER_STATUSES` (state machine). |
| H6 | `recipient_address` chỉ ẩn khi `UNPAID`. | Không còn ON_HOLD; đơn đã thanh toán có địa chỉ. |
| H7 | **Đổi ngữ nghĩa hủy đơn**: buyer hủy ngay chỉ khi `UNPAID`. Đơn đã thanh toán vào thẳng `AWAITING_SHIPMENT`, nên buyer hủy thành yêu cầu aftersale chờ seller duyệt (luồng D07b-5 hiện có). Seller vẫn hủy được `UNPAID` và `AWAITING_SHIPMENT`. | Hệ quả trực tiếp của H1. Ghi vào DECISIONS để không bị nhầm là bug. |
| H8 | Mã lỗi `order_on_hold` đổi thành `order_unpaid` (arrange shipment khi đơn chưa thanh toán). `blockedReason` chỉ còn `order_unpaid` hoặc `null`. | Tên cũ sai nghĩa khi không còn ON_HOLD. Đây là thay đổi API `/demo` và `/fulfillment`, ghi vào DECISIONS. |
| H9 | Xóa `ORDER_HOLD_MINUTES`, `ORDER_LIFECYCLE_INTERVAL_MS`, timer trong `OrdersService`, `releaseDue()` và `POST /test-admin/orders/release-due` (route biến mất, trả 404). | Timer chỉ chạy `releaseDue`; không còn gì để giải phóng. |
| H10 | Cột `Order.releaseAt` và `Order.isOnHold` bị xóa bằng **migration mới**. Migration đó cũng chuyển mọi dòng `Order.status`/`OrderLine.displayStatus` = `ON_HOLD` sang `AWAITING_SHIPMENT`. Không sửa migration cũ. | `status` là `String`, không phải Prisma enum, nên chỉ cần `UPDATE`. |
| H11 | Đơn cũ được migration chuyển sang `AWAITING_SHIPMENT` chưa có package và chưa ai được báo (SQL không tạo được package id, không phát event). `FulfillmentService.repairMissingPackages()` chạy một lần khi API khởi động. Với mỗi đơn đó, nó bump `updatedAt`, ghi audit ON_HOLD → AWAITING_SHIPMENT (actor SYSTEM), phát `ORDER_STATUS_CHANGE`, rồi tạo package `TO_FULFILL` và phát `PACKAGE_UPDATE`. Hàm idempotent. | Không dựa vào transition từ ON_HOLD mà state machine mới đã cấm. SmartOmni biết đơn đã đổi qua webhook hoặc polling `update_time`. Có test riêng. |
| H12 | `OrderAudit` và lịch sử webhook cũ **giữ nguyên** (có thể chứa `ON_HOLD`). Frontend phải hiển thị được trạng thái lạ mà không crash (fallback: hiện chuỗi gốc). | Không viết lại lịch sử. |
| H13 | Scenario loyalty: case "paid and still on hold" đổi thành "paid, awaiting shipment" (`stopAt: 'AWAITING_SHIPMENT'`), vẫn không bao giờ COMPLETED. Sandbox `advanceOneStep` bỏ case ON_HOLD; sandbox order `pay: true` trả `AWAITING_SHIPMENT`. | Giữ số case và ý nghĩa test biên của phase 09. |

---

## Luồng mới

```
checkout ─► UNPAID ──pay──► AWAITING_SHIPMENT ──arrange──► AWAITING_COLLECTION ─► IN_TRANSIT ─► DELIVERED ─► COMPLETED
              │                   │   (package TO_FULFILL tạo ngay khi pay)
              └──cancel──► CANCELLED ◄──seller cancel / buyer request được duyệt
```

Webhook `ORDER_STATUS_CHANGE` khi đặt và trả tiền: `UNPAID`, rồi `AWAITING_SHIPMENT`, kèm `PACKAGE_UPDATE` (`TO_FULFILL`).

---

## Phase 1: backend behavior + OpenAPI + test

**Code**
- `orders/order-state.ts`: bỏ ON_HOLD (H1). Thêm `OAS_ORDER_STATUSES` (H5).
- `orders/orders.service.ts`:
  - `pay()` → `AWAITING_SHIPMENT` (H2).
  - Bỏ timer, `releaseDue()`, `OnApplicationBootstrap`/`OnModuleDestroy` nếu không còn dùng (H9).
  - `buyerCancel` chỉ hủy ngay khi `UNPAID` (H7).
  - `eventData` trả `is_on_hold_order: false` (H4).
- `orders/order.mapper.ts`: H4, H6.
- `config/config.ts`: bỏ `holdMinutes`, `lifecycleIntervalMs` (H9). Bỏ cả env tương ứng trong `.env.example`, compose, `render.yaml` nếu có.
- `fulfillment/fulfillment.service.ts`, `demo/fulfillment.controller.ts`: H8.
- `aftersale/aftersale.service.ts`: danh sách trạng thái seller-cancel và comment.
- `tiktok/orders.controller.ts`: filter theo H5.
- `tiktok/products.controller.ts:574`: bỏ ON_HOLD khỏi danh sách trạng thái "đang giữ hàng".
- `test-admin/`: bỏ route release-due và `releaseAt` khỏi view. Sửa `sandbox-admin.controller.ts`, `loyalty-admin.controller.ts` (H13). Bỏ ON_HOLD khỏi enum `to` của transition.
- `demo/orders.controller.ts`: bỏ `releaseAt` khỏi `orderView`.
- `openapi/*.paths.ts`: cập nhật enum, mô tả, ví dụ. Bỏ path release-due. Chạy `npm run openapi:export` để sinh lại `docs/openapi.json`.
- `DECISIONS.md`: thêm mục H1–H13. Đánh dấu D3, D8, D07a-2, D07b-5 là superseded (không xóa).

**Test backend** (sửa + thêm)
- `tiktok-orders.e2e-spec.ts`:
  - pay → `AWAITING_SHIPMENT` ngay, có `paidAt` và địa chỉ, `is_on_hold_order: false`, không có `release_date`.
  - History là `UNPAID>AWAITING_SHIPMENT:BUYER`.
  - Thứ tự webhook là `['UNPAID','AWAITING_SHIPMENT']`; các test REORDER/DROP/DUPLICATE dùng cặp trạng thái mới.
  - Search `order_status: 'ON_HOLD'` → rỗng; `'FOO'` → `invalid_input`.
  - Transition sang `ON_HOLD` qua test-admin → 400.
  - `POST /test-admin/orders/release-due` → 404.
- Các spec dùng helper "advance clock + release-due" (`tiktok-fulfillment`, `tiktok-aftersale`, `tiktok-oas-alignment-p1-aftersale`, `-p1-ops`, `-p2`, `openapi-upgrade-2026`): bỏ bước release; đơn đã sẵn sàng ngay sau pay.
- `tiktok-fulfillment`: test "từ chối ship đơn ON_HOLD" đổi thành "từ chối ship đơn UNPAID với `order_unpaid`, không tạo package"; thêm "pay tạo package TO_FULFILL ngay".
- `tiktok-aftersale`: buyer hủy UNPAID là ngay lập tức; buyer hủy đơn đã trả tiền tạo `BUYER_CANCEL` pending (H7).
- `tiktok-coupons`: case "hủy sau thanh toán" dùng seller cancel; `redeemed_count` vẫn giữ 1.
- `loyalty-scenarios`: case mới theo H13.
- `tiktok-oas-alignment-p2`: sandbox order `pay` → `AWAITING_SHIPMENT`; chuỗi advance là `AWAITING_SHIPMENT … COMPLETED`.

**Gate**: trong `backend/` chạy `npm run typecheck && npm run lint && npm run build && npm test`. Sau đó `npm run openapi:export`, rồi `git diff --exit-code docs/openapi.json` sau export phải sạch. Ở root chạy `node --experimental-strip-types --test contracts/validator/contract.test.ts`, phải pass mà không sửa contracts.
**Commit**: `feat(orders): pay moves orders straight to AWAITING_SHIPMENT, drop ON_HOLD`

## Phase 2: migration DB + tạo package lazy

- Migration mới `backend/prisma/migrations/<ts>_drop_on_hold/migration.sql`:
  - `UPDATE "Order" SET status='AWAITING_SHIPMENT' WHERE status='ON_HOLD'`
  - `UPDATE "OrderLine" SET "displayStatus"='AWAITING_SHIPMENT' WHERE "displayStatus"='ON_HOLD'`
  - `ALTER TABLE "Order" DROP COLUMN "releaseAt", DROP COLUMN "isOnHold"`
- `schema.prisma`: bỏ 2 field, sửa comment danh sách trạng thái.
- `fulfillment.service.ts`: `repairMissingPackages()` idempotent, chạy lúc khởi động (H11). Listener sẵn có vẫn tạo package nếu thiếu khi đơn sang trạng thái giao hàng.
- Test mới (`test/remove-on-hold-migration.e2e-spec.ts`):
  - Dùng raw SQL tạo một đơn `AWAITING_SHIPMENT` không có package (đúng trạng thái sau migration).
  - Fulfillment detail trả package `TO_FULFILL`.
  - Arrange shipment thành công, đúng một package, có `PACKAGE_UPDATE`.
  - Gọi lại không tạo package thứ hai.
- Kiểm tra migration bằng tay trên DB tạm (embedded PG như test): apply migrations đến `20261125000000_coupon_batch`, chèn đơn ON_HOLD, chạy `prisma migrate deploy`, rồi kiểm tra status đã đổi và cột đã mất. Script để trong scratchpad, không commit.

**Gate**: như Phase 1.
**Commit**: `feat(db): migrate ON_HOLD orders and drop the hold columns`

## Phase 3: frontend

- `lib/types.ts`: bỏ `'ON_HOLD'` khỏi `OrderStatus` và bỏ `releaseAt`. Hàm hiển thị nhận thêm `string` cho lịch sử cũ (H12).
- `lib/format.ts`: bỏ `holdTime`.
- `lib/sellerOrders.ts`: tab và action.
- `components/seller/OrderActions.tsx`, `OrderStatusBadge.tsx`: bỏ nhánh "On hold". Badge có fallback cho trạng thái lạ.
- `components/console/statusTone.ts`, `buyer-home.css`: bỏ ON_HOLD.
- `pages/shop/OrdersPage.tsx`:
  - Bỏ nhãn "Confirming" và hint hold.
  - Action hủy: `UNPAID` hủy ngay, `AWAITING_SHIPMENT` gửi yêu cầu (H7).
- `pages/seller-center/SellerHome.tsx`: bỏ ô "On hold" và `onHold` khỏi `sellerTodo`.
- `pages/seller-center/SellerOrderDetail.tsx`: bước "Paid" chỉ `AWAITING_SHIPMENT`; bỏ dòng "Hold ends" và câu hint on-hold.
- `pages/seller-center/SellerOrders.tsx`: bỏ prop `releaseAt`.
- `pages/console/SandboxPanel.tsx`: "Initial order status" hiện `AWAITING_SHIPMENT`.
- `features/orders.console.tsx`:
  - Bỏ nút "Release due holds" và cột hold.
  - Bảng transition đổi thành `UNPAID: ['AWAITING_SHIPMENT','CANCELLED']`.
  - Ví dụ jump sai đổi thành "ship an UNPAID order".
- `features/fulfillment.console.tsx`: nút "Try to ship (expect refusal)" chuyển sang đơn `UNPAID`.
- Test: sửa `AdminOrdersPanel`, `AdminTools` (giữ một case lịch sử cũ có ON_HOLD vẫn render được), `CheckoutPage` (pay trả `AWAITING_SHIPMENT`), `OrdersPage`, `SellerHome`, `SellerOrders`.

**Gate**: trong `frontend/` chạy `npm run typecheck && npm run lint && npm test && npm run build`.
**Commit**: `feat(ui): remove the on-hold state from shop, seller center and console`

## Phase 4: tài liệu + Playwright e2e

- Docs:
  - `README.md` (state machine, bảng phase 07a, troubleshooting "Order stuck ON_HOLD").
  - `docs/api-reference.md` (bảng transition, env, release-due, mô tả pay/fulfillment/cancel).
  - `docs/curl-samples.md`, `docs/tts-toolkit-alignment.md`, `docs/smartomni-requirements/phase-09.md` (H13).
  - `REPORT.md`: thêm một dòng ghi chú, không sửa lịch sử.
  - `spec/` là spec theo phase (lịch sử), chỉ thêm ghi chú "superseded by docs/remove-on-hold-plan.md" ở chỗ nói ON_HOLD.
- Playwright:
  - `phase05-orders.spec.ts`: buyer pay xong thấy trạng thái "To ship". Console từ chối ship đơn UNPAID.
  - `phase07a-fulfillment.spec.ts`: bỏ bước chờ hold và release-due; ship ngay sau pay; thêm case UNPAID bị từ chối.
  - `phase07b-aftersale.spec.ts`, `phase10-persistence.spec.ts`: bỏ release-due, sửa history mong đợi.
- `grep -rn "ON_HOLD\|release-due\|releaseAt\|holdMinutes"` (trừ `contracts/`, migration cũ, `spec/`, `REPORT.md`, `DECISIONS.md` và chỗ cố ý như H4/H5/H12) phải sạch.

**Gate**:
- Chạy lại gate backend và frontend.
- `docker compose up --build -d` (image phải chứa migration mới), rồi `cd e2e && npm test`.
- `docker compose down` sau khi xong.

**Commit**: `test(e2e): cover the hold-free order flow` và `docs: describe the hold-free order flow` (hai commit, stage riêng).

---

## Rủi ro

- SmartOmni có code xử lý ON_HOLD sẽ thành code chết, không lỗi (H4, H5 giữ shape OAS).
- Hành vi hủy của buyer sau thanh toán thay đổi (H7). Cần báo team SmartOmni.
- DB đang chạy (Render/Neon) sẽ có đơn ON_HOLD được chuyển trạng thái khi deploy. Package của chúng được tạo lazy (H11).
