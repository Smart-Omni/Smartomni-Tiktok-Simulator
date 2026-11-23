# Phase 05 — Buyer checkout, đơn hàng, webhook và polling

[← Overview](00-overview.md) · Dependency: Phase 01–04; nghiệm thu trừ tồn end to end phụ thuộc Phase 06.

## Mục tiêu / mô tả

Buyer tạo đơn qua giao diện demo, simulator phát sự kiện theo TikTok; SmartOmni nhận và đồng bộ đơn, kể cả khi webhook mất, lặp hoặc đến sai thứ tự.

## Tech stack

NestJS/Prisma transaction, PostgreSQL webhook queue, React cart/checkout, Spring Boot Integration/Order, RabbitMQ, Quartz; contract và integration tests.

## Instructions

- Checkout và thanh toán giả là API /demo, không gán cho TikTok OpenAPI.
- Giữ trạng thái sàn gốc và trạng thái nghiệp vụ SmartOmni. ON_HOLD không được giao; DELIVERED không đồng nghĩa COMPLETED.
- Webhook theo schema chính thức, không phát trực tiếp DTO WebhookOrderPayload.
- Xác thực webhook trước khi tin shop/context; tenant được resolve từ connection đã liên kết.
- Idempotency phải được bảo đảm bằng transaction/constraint, không chỉ check trước insert.
- Giữ tiền hàng, giảm giá, vận chuyển, thuế và tổng tiền riêng; không suy ra tiền loyalty từ tổng đơn chưa rõ thành phần.

## Steps

1. Buyer UI có cart theo shop, chọn SKU/số lượng, địa chỉ giả, checkout, thanh toán giả và lịch sử đơn.
2. Lưu đơn/line items/payment/packages và thời điểm nghiệp vụ; tính tiền ở backend.
3. Tạo state machine theo contract; chuyển trạng thái bằng Seller/Test Console, lưu audit.
4. Triển khai Get Order List và Get Order Detail với filter thời gian, trạng thái, pagination.
5. Triển khai quản lý subscription webhook theo contract Events API; worker gửi sự kiện, lưu attempts, retry và replay.
6. Integration xác minh chữ ký webhook, resolve shop, lấy detail nếu cần, ánh xạ external SKU sang nội bộ rồi phát DTO JSON đúng loại vào RabbitMQ.
7. Order upsert theo tenant/connection/external order ID; lưu source update time và trạng thái gốc để tránh lùi trạng thái vì sự kiện cũ.
8. Đơn chưa mapping SKU phải chờ xử lý/đối soát, không tự gán SKU đầu tiên.
9. Hoàn thiện polling bù trong Order/Integration và Quartz; chỉ tiến checkpoint khi dữ liệu đã xử lý bền vững.
10. Thiết kế yêu cầu trừ tồn có khóa idempotency theo đơn/line để Phase 06 thực thi; retry sau timeout không trừ lại.
11. Chặn thao tác local đánh dấu completed/returned trái nguồn sàn; mốc hoàn tất phải truy vết được nguồn.
12. Test Console cho drop/delay/duplicate/reorder event, kiểm tra sự kiện lỗi và gửi lại.

## Input / output

Baseline: POST /order/202309/orders/search, GET /order/202507/orders. Token, query, body, pagination và envelope theo contract Phase 01.

Callback URL là endpoint SmartOmni; các topic, chữ ký và JSON event phải được snapshot riêng. API đọc dữ liệu và sự kiện webhook không được dùng chung schema tùy tiện.

## Kiểm thử / tiêu chí hoàn thành

- [ ] Checkout tính tiền đúng, chống số lượng không hợp lệ, lưu line item snapshot.
- [ ] Đơn ON_HOLD không được fulfillment; DELIVERED chưa đủ điều kiện loyalty.
- [ ] Hai webhook đồng thời chỉ tạo một đơn.
- [ ] Webhook và polling cùng thấy đơn không tạo trùng hoặc trừ tồn hai lần.
- [ ] Event cũ không ghi đè trạng thái mới; lỗi mapping được quan sát và retry.
- [ ] Restart worker không làm mất sự kiện; receiver trả lỗi được retry có lịch sử.
- [ ] Webhook mất được polling bù; filter/cursor đúng biên thời gian.
- [ ] Payload/signature sai không đưa vào hàng đợi nghiệp vụ.
- [ ] Có bằng chứng luồng Buyer → simulator → SmartOmni → inventory sau Phase 06.

## Theo dõi

- Người phụ trách: (chưa gán) - agent Phase 05, chưa review bởi người.
- PR/commit: commit `phase-05` trên `main` của repo simulator (xem `git log`).
- Phạm vi đã làm (phía simulator): migration `20261017000000_phase05_orders`; giỏ hàng, checkout idempotent theo `checkoutKey`, thanh toán giả, state machine có audit, đặt/hoàn tồn khi hủy đúng một lần; `POST /order/202309/orders/search` (keyset cursor, lọc trạng thái/buyer/thời gian nửa mở), `GET /order/202507/orders`; Events API `GET/PUT/DELETE /event/202309/webhooks`; webhook `ORDER_STATUS_CHANGE` ghi cùng transaction (outbox), ký `Authorization = HMAC-SHA256(app_secret, app_key + body)`, fault `REORDER`; UI Buyer (giỏ, checkout, đơn), Seller (đơn), Test Console (đơn, chuyển trạng thái, release hold).
- Bằng chứng (Windows, Node 22, PostgreSQL 16 nhúng): `npm test` backend = 7 suites / 110 tests pass (25 test mới `tiktok-orders.e2e-spec.ts`: tiền theo thành phần, snapshot, validate số lượng, oversell/đua tồn, idempotency đồng thời, ON_HOLD không giao được, DELIVERED chưa COMPLETED, hủy hoàn tồn một lần, phân trang/ lọc biên thời gian, cô lập shop, schema OAS, webhook cùng transaction, REORDER/DROP/DUPLICATE, chữ ký trên HTTP thật + vector `contracts/signing`); frontend typecheck/lint/test pass.
- Chưa làm / BLOCKED: phần SmartOmni (bước 6-11: xác minh chữ ký + idempotency + polling bù + chặn sửa tay) - repo platform chỉ để tham khảo, yêu cầu ghi tại `docs/smartomni-requirements/phase-05.md`; bằng chứng Buyer → simulator → SmartOmni → inventory (cần Phase 06 + SmartOmni); Playwright (xem PROGRESS.md).
- Quyết định/blocker: xem `DECISIONS.md` (D2-D8). Mọi hành vi chuyển trạng thái, `type` webhook ngoài ORDER_STATUS_CHANGE=1, thời lượng ON_HOLD đều là lựa chọn của simulator, chưa xác minh.
- Ngày hoàn thành: chưa (PARTIAL).

> **Note (later change):** the ON_HOLD status, the hold period and `POST /test-admin/orders/release-due` described here were removed. Payment now moves an order straight to AWAITING_SHIPMENT. See `docs/remove-on-hold-plan.md` and DECISIONS H1-H13.
