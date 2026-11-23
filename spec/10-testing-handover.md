# Phase 10 — Kiểm thử tổng thể và bàn giao

[← Overview](00-overview.md) · Dependency: Phase 01–09 cho phạm vi được hỗ trợ.

## Mục tiêu / mô tả

Nghiệm thu một bản đầy đủ để team chạy lại các luồng trên máy mới, tái hiện lỗi và biết chính xác phần nào đã kiểm thử hoặc còn giới hạn contract.

## Tech stack

Backend/API tests, JSON Schema/OpenAPI validators, Playwright, JUnit/Mockito, PostgreSQL/RabbitMQ thật trong môi trường test, Docker Compose; báo cáo CI và Postman/cURL.

## Instructions

- Không coi contract tests của simulator là bằng chứng đã gọi TikTok thật.
- Kiểm tra tính đúng đắn bằng fixture/test vector độc lập, tránh chỉ để simulator và adapter tự khớp cùng một lỗi.
- Không báo phase thành công nếu test bị skip do Docker, API scope hoặc Python service chưa sẵn sàng.
- Giới hạn được chấp nhận về contract chưa xác minh phải có trong manifest và giao diện/tài liệu; các luồng khác vẫn phải hoàn tất.
- Không mở thêm tính năng thanh toán SaaS hoặc AI model accuracy trong phase này.

## Steps

1. Khởi động môi trường sạch bằng Compose, migrate, seed hai shop và hai tenant SmartOmni qua setup test riêng.
2. Chạy contract tests cho toàn bộ operation hỗ trợ: request, response, error, pagination và signature.
3. Chạy backend tests cho state machine, phép tính tiền, token lifecycle, quyền và transaction concurrency.
4. Chạy Playwright trên Seller/Buyer/Test Console cho kết nối, sản phẩm, mua hàng, chat, coupon, đơn và hoàn trả.
5. Chạy SmartOmni integration tests với PostgreSQL/RabbitMQ thật: API → queue → database → inventory → API sàn.
6. Chạy fault scenarios: timeout, lỗi ứng dụng HTTP 200, partial failure, drop/duplicate/delay/reorder webhook, revoked token và thiếu scope.
7. Restart API/worker/database trong môi trường test, kiểm dữ liệu/job/media còn nguyên và retry không ghi trùng.
8. Kiểm tenant isolation, internal endpoint authentication và việc che secret trong request logs.
9. Xuất báo cáo test gắn request IDs, ảnh UI khi phù hợp và danh sách operation chưa hỗ trợ.
10. Hoàn thiện README chạy local/Docker, cấu hình callback, base URLs, seed/reset, bộ scenario, Postman/cURL và troubleshooting.
11. Review migration SmartOmni, chạy mvn test và mvn -B clean verify theo gate repo; ghi rõ điều kiện môi trường và kết quả.
12. Tick overview sau khi reviewer kiểm bằng chứng của từng phase; không tick thay team khi mới có tài liệu.

## Ma trận nghiệm thu

| Nhóm | Bằng chứng cần có |
|---|---|
| Kết nối | Consent, token/refresh/revoke, sai state/chữ ký/shop/scope |
| Catalog | Import nhiều trang, upsert, mapping nhiều SKU, giá riêng |
| Orders | Checkout → webhook/polling → đơn; trùng/sai thứ tự không làm sai trạng thái |
| Inventory | Debit một lần, update đúng kho, outbox chỉ SENT khi sàn xác nhận |
| Fulfillment | Tracking, PDF truy cập được, chặn ON_HOLD |
| Returns | Một phần/toàn phần, audit, không hoàn tồn lặp |
| Chat | Hai chiều, polling bù, scope, timeout, phiên khiếu nại |
| Coupon | Đọc và checkout; tạo qua API chưa xác minh bị khóa |
| Loyalty | 15 ngày, claim một lần, tính tiền không ship/thuế, sai tenant |
| Hạ tầng | Restart/seed/reset lặp lại được, giữ dữ liệu và log an toàn |

## Output / deliverables

- Project simulator có source, lockfiles, Compose, migrations, seed và tests.
- Seller/Buyer demo và Test Console hoạt động.
- Bộ contracts/snapshots/fixtures/collection cùng nguồn và ngày xác minh.
- Các thay đổi adapter/nghiệp vụ/migration SmartOmni đã review.
- Hướng dẫn setup, vận hành test, phát hiện lỗi và khôi phục.
- Báo cáo test thật; ma trận supported/blocked/unverified và nguyên nhân.

## Tiêu chí hoàn thành

- [ ] Máy mới chạy theo hướng dẫn mà không cần database production.
- [ ] Tất cả nhóm được hỗ trợ trong ma trận có bằng chứng pass.
- [ ] Các lỗi còn lại có mức ảnh hưởng và cách tái hiện; không giấu test skip.
- [ ] Giới hạn API chưa xác minh được ghi rõ và chặn ở ứng dụng.
- [ ] Repo checks và migration checks đạt; không commit secret/.env thật.
- [ ] Team review và cập nhật checkbox overview tương ứng.

## Theo dõi

- Người phụ trách: (chưa gán) - agent Phase 10, chưa review bởi người.
- PR/commit: các commit `phase-10(wip)` và `phase-10` trên `main` của repo simulator; báo cáo đầy đủ ở `REPORT.md`.
- Bằng chứng (15/10/2026, Windows, Docker 29.8): `docker compose down -v` + `up --build` từ volume rỗng: db/api/ui healthy, 9 migration áp dụng, seed; backend 13 suites / 202 test pass, 0 skip; frontend 17 test pass; contract validator 10/10; Playwright 23/23 (7 file spec: 05, 06, 07a, 07b, 08, 09a, persistence) chạy 4 lần liên tiếp; restart `api` và `db`+`api` giữ dữ liệu (đơn + lịch sử, webhook job + attempts, chat, coupon, PDF cùng URL, clock, token), seed idempotent, log không chứa token/app secret. Repo platform (chỉ đọc): `mvn -o -B test` và `mvn -o -B clean verify` BUILD SUCCESS (1 test skipped: live simulator test cần biến môi trường).
- Tài liệu: README (Docker/local, callback, base URL, seed/reset, scenario, troubleshooting), `docs/support-matrix.md`, `docs/curl-samples.md`, `docs/postman-collection.json`, `docs/smartomni-requirements/`, `DECISIONS.md`.
- BLOCKED / chưa làm: bước 5 (integration test SmartOmni với PostgreSQL/RabbitMQ thật) và bước 11 (review migration SmartOmni) vì phần SmartOmni chưa được viết trong lượt này (repo platform chỉ để tham khảo); không có bằng chứng luồng Buyer → simulator → SmartOmni → inventory; không có test AI thật (Python service ngoài repo); không gọi TikTok thật; mọi operation vẫn `unverified`.
- Checkbox `00-overview.md` KHÔNG được tick (việc của reviewer).
- Ngày hoàn thành: chưa (PARTIAL).

> **Note (later change):** the ON_HOLD status, the hold period and `POST /test-admin/orders/release-due` described here were removed. Payment now moves an order straight to AWAITING_SHIPMENT. See `docs/remove-on-hold-plan.md` and DECISIONS H1-H13.
