# Phase 09 — Coupon và dữ liệu loyalty

[← Overview](00-overview.md) · Dependency: Phase 01, 03, 05, 07; coupon card dùng Phase 08.

## Mục tiêu / mô tả

Tạo dữ liệu coupon trên Seller demo, thử API đọc và việc áp dụng coupon trong checkout giả; cung cấp dữ liệu đơn để kiểm thử Customer Portal tích điểm đúng quy tắc SmartOmni.

## Tech stack

NestJS/Prisma/React, Clock nghiệp vụ, Spring Boot Order và miền Customer Portal/loyalty, Flyway migration mới, email sink local nếu có luồng email được hỗ trợ.

## Instructions

- Không tạo endpoint OpenAPI phát voucher khi chưa xác minh được contract TikTok áp dụng cho shop Việt Nam.
- Tạo coupon trên Seller demo là thao tác tạo dữ liệu sàn giả; không đổi yêu cầu Admin phát voucher qua API thành nhập mã thủ công trong SmartOmni.
- Đọc coupon không chứng minh có quyền tạo hoặc audit sử dụng coupon qua API.
- Customer Portal là tài khoản riêng; không gộp danh tính buyer TikTok với customer SmartOmni.
- Quy tắc 15 ngày là nghiệp vụ SmartOmni để test, không được diễn giải như chính sách hoàn trả TikTok đã được xác minh.
- V7/V8 có phần khác quyết định mới; chỉ sửa bằng migration mới, không sửa lịch sử đã áp dụng.

## Steps

1. Seller demo tạo dữ liệu coupon: thời hạn, trạng thái, điều kiện và đối tượng theo schema đã xác minh; lưu số lượt dùng trong simulator.
2. Triển khai Search Coupon List và Get Coupon; kiểm scope, filter, pagination.
3. Buyer checkout thử coupon hợp lệ/hết hạn/không đạt điều kiện; backend tính giảm giá, snapshot khoản tiền.
4. Nếu hỗ trợ coupon card, kiểm điều kiện card theo Send Message; không mặc định mọi coupon đều gửi được.
5. SmartOmni khóa API tạo voucher chưa xác minh và trả thông báo rõ; không email mã như thể đã được tạo thành công.
6. Bổ sung dữ liệu đơn cần cho loyalty: shop/connection, trạng thái gốc, thời điểm hoàn tất và tiền hàng thực trả có nguồn đối soát.
7. Customer Portal/Order bổ sung claim theo tài khoản đã xác thực và tenant; người claim hợp lệ đầu tiên nhận điểm theo quyết định hiện tại, không tự thêm điều kiện xác minh buyer sàn.
8. Thực thi claim một lần bằng constraint/transaction; kiểm đơn đúng tenant/shop và đã qua 15 ngày kể từ hoàn tất.
9. Tính floor(tiền hàng thực trả sau giảm giá / 1000 VND), không gồm phí vận chuyển/thuế; thiếu chứng cứ tách tiền thì giữ pending reconciliation.
10. Điểm không hết hạn/không tiêu khi nhận ưu đãi; hạng Standard <500, Gold >=500, Platinum >=1000, Diamond >=1500.
11. Test Console tạo dữ liệu trước/sau ngưỡng bằng Clock nghiệp vụ, không thay thời gian xác thực API.

## Input / output

Baseline: POST /promotion/202406/coupons/search, GET /promotion/202406/coupons/{coupon_id}. Không thêm API TikTok claim điểm; đó là API nội bộ SmartOmni.

[Search Coupon List](https://partner.tiktokshop.com/docv2/page/search-coupon-list-202406) là nguồn khởi điểm cho việc đọc coupon. Trạng thái hỗ trợ API tạo voucher ghi trong manifest Phase 01.

## Kiểm thử / tiêu chí hoàn thành

- [ ] Đọc/filter/page coupon đúng schema và shop.
- [ ] Checkout kiểm expiry/điều kiện/số lượng; retry không tăng lượt dùng hai lần.
- [ ] Luồng tạo voucher chưa xác minh bị chặn rõ ràng, không email success.
- [ ] DELIVERED chưa đủ điều kiện; COMPLETED chưa đủ 15 ngày bị từ chối.
- [ ] Đúng ngưỡng 15 ngày và tiền hàng đủ đối soát được tính điểm đúng.
- [ ] Hai request/khách claim đồng thời chỉ có một lần nhận điểm.
- [ ] Sai tenant/shop bị từ chối; không tin customer_id tùy ý từ client.
- [ ] Không dùng total_amount gồm ship/thuế để cộng điểm.
- [ ] Ngoại lệ hoàn/trả sau mốc claim được ghi pending decision; không tự thay chính sách điểm.

## Theo dõi

### 09a (steps 1-5) - agent Phase 09a, chưa review bởi người

- Người phụ trách: (chưa gán). PR/commit: nhánh `phase-09a`, commit `phase-09a: coupons read API + checkout discount` (chưa merge/push).
- Đã làm (phía simulator): migration `20261050000000_phase09a_coupons` (`Coupon`, `CouponUsage` unique `(couponId, orderId)`); `POST /promotion/202406/coupons/search` (page_size mặc định 50, keyset `page_token`, lọc `status` suy ra từ cửa sổ + cờ deactivate + **business clock**, `display_type`, `title_keyword`) và `GET /promotion/202406/coupons/{id}` (scope giả `sim.promotion.read`, chỉ shop của token); `/demo/shops/:id/coupons` (Seller tạo/sửa/ngừng, Buyer xem coupon dùng được); checkout nhận `couponCode`: kiểm hết hạn/chưa bắt đầu/ngừng/tối thiểu/đối tượng NEW/hết lượt, giảm giá vào `seller_discount` (tách khỏi ship/tax), chia theo dòng bằng largest-remainder, tăng lượt dùng bằng UPDATE có điều kiện trong cùng transaction, hoàn lượt đúng một lần khi hủy trước thanh toán; UI Seller/Buyer/Console + ô nhập mã ở giỏ.
- API tạo voucher: KHÔNG có route nào; test chứng minh POST/PUT/PATCH/DELETE ký hợp lệ tới các đường `/promotion/...` ngoài search/detail trả 404 thuần và manifest vẫn `unsupported` + `LOCKED`.
- Bằng chứng (Windows, Node 22, PostgreSQL 16 nhúng): backend typecheck/lint/build pass; jest toàn bộ 8 suites / 126 tests pass (16 test mới `tiktok-coupons.e2e-spec.ts`: schema OAS, cô lập shop, phân trang/lọc, lỗi đầu vào, scope/chữ ký, khóa tạo voucher, tiền tách thành phần, trần %, giảm không vượt tạm tính, mã lỗi ổn định, retry cùng `checkoutKey` kể cả đồng thời chỉ tính 1 lượt, 6 checkout đồng thời với limit 2 chỉ 2 thành công, hoàn lượt đúng một lần); frontend typecheck/lint/build, 10 test pass (3 mới). Ghi chú: trong các lần chạy song song với agent khác từng thấy 2/6 lần một test ngắt quãng của `tiktok-orders.e2e-spec.ts` (Phase 05) fail rồi pass lại ở 4 lần chạy sau, không tái hiện riêng lẻ; chưa xác định nguyên nhân (nghi áp lực CPU khi nhiều tiến trình chạy).
- BLOCKED / chưa làm: phía SmartOmni (khóa API tạo voucher, không email giả thành công, claim/loyalty - xem `docs/smartomni-requirements/phase-09.md`); coupon card trong chat (bước 4) KHÔNG được hỗ trợ cho đến khi Send Message hỗ trợ `COUPON_CARD` trong snapshot (Phase 08); Playwright chưa chạy.
- Quyết định/blocker: xem `DECISIONS.md` mục `Phase 09a`. Giá trị `claimed_count` = `redeemed_count` (simulator không có khái niệm claim; chưa xác minh); `display_type` mặc định `PROMO_CODE`; mã khuyến mãi 6-12 chữ/số, lưu IN HOA, duy nhất theo shop; chỉ phạm vi FULL_SHOP và đối tượng ALL/NEW.
- Ngày hoàn thành: chưa (PARTIAL).

### 09b (steps 6-11) - Simulator side only

- Người phụ trách: (chưa gán) - agent Phase 09b, chưa review bởi người. Commit: xem `git log` (`phase-09b`).
- Đã làm: `POST /test-admin/scenarios/loyalty-orders` (file `backend/src/test-admin/loyalty-admin.controller.ts`, nút trong tab Orders của Test Console) tạo 5 đơn qua state machine thật với Clock nghiệp vụ đóng băng: hoàn tất N+1 ngày, đúng N ngày, N ngày trừ 1 giờ, chỉ DELIVERED, đang ON_HOLD (N mặc định 15). Clock nghiệp vụ được khôi phục; clock xác thực chữ ký không đổi. Các thành phần tiền (`sub_total`, `shipping_fee`, `tax`, `total_amount`) luôn tách riêng trong Get Order Detail để kiểm "không dùng total_amount".
- Bằng chứng: `backend/test/loyalty-scenarios.e2e-spec.ts` 3 test pass (thời điểm hoàn tất đúng biên, DELIVERED/ON_HOLD không hoàn tất, tiền tách thành phần, clock được khôi phục và API ký vẫn hoạt động, thiếu token admin 401).
- BLOCKED (repo platform chỉ để tham khảo): bước 6 (lưu dữ liệu đơn cho loyalty), 7 (claim Customer Portal theo tài khoản đã xác thực + tenant), 8 (claim một lần bằng constraint, kiểm 15 ngày), 9 (tính `floor(sub_total / 1000)`, pending reconciliation), 10 (hạng Standard/Gold/Platinum/Diamond), và các tiêu chí tương ứng. Chi tiết yêu cầu: `docs/smartomni-requirements/phase-09.md` mục 09b.
- Ngày hoàn thành: chưa (PARTIAL).

### 09c - Lô mã dùng một lần (voucher loyalty) - simulator side

- Plan: `docs/voucher-issuance-plan.md`. Branch `feature/voucher-batches` (chưa push, chưa PR).
- Đã làm:
  - Migration `20261125000000_coupon_batch` (`Coupon.batchId` + index); bộ sinh mã 10 ký tự `backend/src/coupons/promo-code.ts`; `CouponBatchService` (tạo lô 1-500 mã trong một transaction, kiểm trùng trong shop, retry tối đa 3 lần; list/get/deactivate), chỉ `DemoModule` và `TestAdminModule` import.
  - Hủy đơn UNPAID dùng mã lô: hoàn lượt **và** tắt mã (đốt mã) trong cùng transaction; voucher lẻ giữ 09a-5.
  - `/demo/shops/:shopId/coupon-batches` (POST, GET, GET `:batchId`, PATCH `{deactivated:true}`), chỉ seller của shop. `GET /coupons` ẩn mã lô với cả buyer và seller. `POST /coupons` không có `promoCode` thì tự sinh mã. Search Coupon List lọc `title_keyword` không phân biệt hoa thường.
  - `POST /test-admin/scenarios/loyalty-vouchers` (Gold 10 / Platinum 20 / Diamond 30); `GET /test-admin/coupons` thêm `batchId`, phân trang `after`/`limit`/`next`, `usages` (đơn đã dùng mã).
  - Seller Center: tab **Code batches** (tạo lô, bảng lô, View codes, Copy all, Download CSV, Deactivate); ô Code của New voucher thành tùy chọn; Seller Home thêm "Code batches: n active". Test Console tab Coupons: cột Batch, Used in order, lọc theo lô, Load more, nút tạo lô loyalty.
  - Tài liệu: `DECISIONS.md` mục Phase 09c, `docs/smartomni-requirements/phase-09.md` Step 5, `docs/api-reference.md` (7.8, 8.7, 9), `docs/openapi.json`.
- Bằng chứng: backend `test/coupon-batches.e2e-spec.ts` (generator, service, đốt mã, `/demo`, Search/Get, `/test-admin`); toàn bộ backend 27 suites pass; frontend Vitest (`SellerCenterPages.test.tsx`, `SellerHome.test.tsx`) pass; e2e `e2e/tests/phase09c-voucher-batches.spec.ts` (xem kết quả trong commit `test(e2e)`).
- Chưa làm (phía SmartOmni, xem `docs/smartomni-requirements/phase-09.md`): map tier -> lô, giao mã cho khách, ghi ngày phát/claim, poll Get Coupon.

> **Note (later change):** the ON_HOLD status, the hold period and `POST /test-admin/orders/release-due` described here were removed. Payment now moves an order straight to AWAITING_SHIPMENT. See `docs/remove-on-hold-plan.md` and DECISIONS H1-H13.
