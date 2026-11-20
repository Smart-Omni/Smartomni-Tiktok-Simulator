# Plan: phát hành lô voucher (mã dùng một lần) cho SmartOmni

Mục tiêu: simulator đóng vai TikTok Shop trong luồng voucher loyalty của SmartOmni, **đúng như TikTok thật**:

1. Seller tạo trước một **lô mã giảm giá** trên Seller Center của simulator (ví dụ 100 mã "Diamond 30%").
   Simulator tự sinh mã, mỗi mã dùng được một lần.
2. SmartOmni kéo danh sách mã về bằng API TikTok đã có: Search Coupon List và Get Coupon.
3. SmartOmni lo toàn bộ phần còn lại: tier → lô, khách claim, ngày phát, ngày claim, giao mã cho từng khách.
4. Khách gõ mã ở checkout của simulator; ai có mã đúng thì được giảm, mỗi mã chỉ dùng một lần.

Branch: `feature/voucher-batches`, tách từ `develop` (`cd55be7`, đã gồm product-media, webhook fix và
api-reference). Không push, không mở PR nếu chưa được yêu cầu.

---

## Quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| Q1 | **Không có API tạo coupon** cho SmartOmni. Mã chỉ được tạo trên Seller Center (`/demo`) hoặc qua `/test-admin` (dữ liệu test). | OAS: coupon "được tạo trong Seller Center hoặc Seller App". Manifest giữ `promotion.coupon_create` = `unsupported` + `LOCKED`. |
| Q2 | Một lô = **N coupon riêng**, mỗi coupon một mã, `redemption_limit = 1`, cùng `title`, cùng mức giảm và hạn dùng. | Search/Get của TikTok trả mỗi coupon một `promo_code`; đây là cách duy nhất giữ đúng shape TTS. SmartOmni giao mỗi khách một mã và biết mã nào đã dùng. |
| Q3 | Mã sinh tự động: **10 ký tự**, chữ in hoa và số, **bỏ `0`, `O`, `1`, `I`** (32 ký hiệu: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`), dùng `crypto.randomInt`, **kiểm tra trùng trong từng shop** trước khi trả. | Dễ đọc, dễ gõ; vẫn nằm trong quy tắc OAS `[6, 12]` chữ/số. 32^10 ≈ 1,1 × 10^15 tổ hợp. |
| Q4 | Mỗi lô **1–500 mã**. | Đủ cho demo/test; SmartOmni kéo tối đa 5 trang Search (100 mã/trang). Một transaction vẫn nhanh. |
| Q5 | Cột nội bộ **`Coupon.batchId`** (nullable) đánh dấu mã thuộc lô; **không lộ ra API TikTok**. | Dùng để ẩn mã khỏi buyer, gom nhóm trên Seller Center, tắt cả lô. |
| Q6 | **Mã thuộc lô bị ẩn khỏi danh sách voucher của buyer** (`GET /demo/shops/:id/coupons`, ô chọn voucher ở checkout). Khách phải tự gõ mã nhận từ SmartOmni. Voucher lẻ vẫn hiện như cũ. | Mapper đã trả `display_channels: ['PRIVATE']`: theo OAS, người dùng không biết mã cho đến khi được đưa. Test checkout/e2e cũ không đổi. |
| Q7 | Thêm `POST /test-admin/scenarios/loyalty-vouchers` tạo sẵn 3 lô Silver 10% / Platinum 20% / Diamond 30%. | Để SmartOmni và e2e test không phải bấm tay. Chỉ là dữ liệu test; mức % thật do staff SmartOmni cấu hình. |
| Q8 | **Mã thuộc lô bị "đốt" khi đơn UNPAID dùng nó bị hủy**: lượt dùng được hoàn (`redeemed_count` về 0) **và** mã bị tắt (`deactivated = true`) trong cùng transaction hủy đơn. Mã **không dùng lại được**. Voucher lẻ giữ quy tắc 09a-5 (hoàn lượt, dùng tiếp). Hủy sau thanh toán: `redeemed_count` giữ 1 như cũ. | Mã một lần đã giao cho một khách thì không được quay lại pool. Mọi trạng thái SmartOmni thấy đều là trạng thái cuối, không quay ngược. |
| Q9 | Search Coupon List lọc `title_keyword` **không phân biệt hoa thường** (Prisma `mode: 'insensitive'`). | OAS không nói rõ; nới lỏng an toàn hơn cho SmartOmni khi lọc theo tên lô. |
| Q10 | Router TikTok **không thêm field nào ngoài schema OAS** (không coupon id trong đơn, không `batchId` trong coupon). | Giữ đúng field TTS toolkit. Liên kết đơn ↔ mã chỉ có ở `/test-admin` để test kiểm chứng. |

### Quyết định cũ đã bị thay thế (không làm)

Các điểm sau được chốt trong lúc bàn thiết kế API tạo coupon. Vì Q1 bỏ API đó nên chúng **không còn áp dụng**:

- Route `POST /promotion/202406/coupons` hoặc `/sim/promotion/202406/coupons` cho SmartOmni gọi.
- Khóa idempotency (header `Idempotency-Key`, sau đó đổi sang query `idempotency_key`).
- "Cùng khóa + nội dung giống hệt → trả lại coupon cũ, khác → 409".
- SmartOmni tự gửi `promo_code`.

Riêng quy tắc sinh mã 10 ký tự (Q3) vẫn giữ, nhưng áp dụng khi seller tạo lô thay vì khi trả response cho API.

---

## Luồng end-to-end

```
Seller Center (simulator)          TikTok router (simulator)             SmartOmni
─────────────────────────          ─────────────────────────             ─────────
1. Tạo lô "Diamond 30%" × 100
   → 100 coupon, mã 10 ký tự,
     redemption_limit = 1
                                   2. POST /promotion/202406/coupons/search  ◄── kéo mã (title_keyword, status=ONGOING,
                                      (trang 100 mã, page_token)                  page_token) → lưu coupon_id + promo_code
                                                                              3. Staff map tier Diamond → lô này
                                                                              4. Khách claim → SmartOmni giao 1 mã,
                                                                                 ghi ngày phát/claim
Buyer checkout (simulator)
5. Khách gõ mã → giảm 30% tiền hàng
   (không tính ship/thuế), lượt dùng 0 → 1
                                   6. GET /promotion/202406/coupons/{id}     ◄── theo dõi usage_stats.redeemed_count
```

### Ràng buộc đồng bộ phía SmartOmni (hợp đồng tích hợp, ghi vào DECISIONS + phase-09.md)

1. **Bảng trạng thái của một mã lô** (đọc bằng Get Coupon). Mọi trạng thái ngoài "còn trống" đều là **trạng thái cuối**:

   | `status` | `usage_stats.redeemed_count` | Ý nghĩa | SmartOmni làm gì |
   |---|---|---|---|
   | `ONGOING` | 0 | Còn trống / đã giao nhưng khách chưa dùng | Tiếp tục poll nếu đã giao |
   | `ONGOING` | 1 | Đã dùng trong một đơn | Dừng poll, đánh dấu đã dùng |
   | `DEACTIVATED` | 0 hoặc 1 | Bị đốt (đơn UNPAID hủy, Q8) hoặc seller tắt | Dừng poll, không giao lại |
   | `EXPIRED` | 0 hoặc 1 | Hết hạn | Dừng poll |
   | `NOT_START` | 0 | Chưa tới ngày bắt đầu | Chưa giao cho khách |

   Qua API **không phân biệt được** "bị đốt do hủy đơn" với "seller tắt" (OAS chỉ có `DEACTIVATED`).
2. **Search không có `usage_stats`** (đúng schema OAS). Biết mã đã dùng chưa thì gọi **Get Coupon** cho từng mã.
   Cách giảm số request:
   - Chỉ poll mã **đã giao cho khách mà chưa ở trạng thái cuối**.
   - Mã hết hạn hoặc bị tắt thì lọc hàng loạt bằng Search `status: ["EXPIRED", "DEACTIVATED"]`.
   - Sau lần kéo đầu, lưu `coupon_id` và gọi Get Coupon theo id, không tìm lại theo title.
3. **`status` vẫn `ONGOING` sau khi mã đã dùng**: OAS không có trạng thái "hết lượt", chỉ `redeemed_count` đổi từ 0 sang 1.
4. **Đơn hàng không chứa coupon id hay mã**: Order Detail của OAS không có field nối đơn với coupon (Q10).
   - Loyalty không cần nối: SmartOmni chỉ cần biết mã đã dùng chưa, và điểm tính theo `sub_total` đã trừ giảm giá.
   - Khoản giảm nằm đúng chỗ: `seller_discount` (Order Detail) và `subtotal_deduction_seller` (Price Detail).
   - `voucher_deduction_seller` trong OAS là **mã loại giảm giá** (`1010000`, `1020000`, `1030000`), không phải số tiền,
     nên giá trị `'0'` hiện tại không làm sai số tiền.
5. **`title_keyword` không phân biệt hoa thường** (Q9), dạng "chứa chuỗi".
6. **`claimed_count` = `redeemed_count`** (09a-7, không đổi): simulator không có khái niệm claim, claim nằm ở SmartOmni.
7. Mã `DEACTIVATED` bị checkout từ chối với `coupon_deactivated`.

---

## Thứ tự phase

| # | Phase | Vì sao ở vị trí này | Commit |
|---|---|---|---|
| 0 | Plan + branch | Chốt phạm vi trước khi sửa code | `docs(coupons): add the voucher batch plan` |
| 1 | Nền backend: migration `batchId`, bộ sinh mã, service tạo lô | Mọi phase sau dùng service này | ⭐ `feat(coupons): generate single-use promo code batches` |
| 2 | API `/demo` cho lô + ẩn mã lô khỏi buyer + OpenAPI | Frontend cần API này | ⭐ `feat(demo): let sellers create and deactivate voucher batches` |
| 3 | `/test-admin` scenario loyalty-vouchers + lọc theo lô | Dùng lại service Phase 1; độc lập với frontend | `feat(test-admin): seed loyalty voucher batches` |
| 4 | Seller Center UI + Test Console | Cần API Phase 2–3 | ⭐ `feat(seller-center): manage voucher batches` |
| 5 | Tài liệu + e2e Playwright | Kiểm tra toàn bộ sau khi ghép | `docs(coupons): ...` + `test(e2e): ...` |

⭐ = đổi hành vi hoặc API, có migration hoặc đổi UI.

### Quy tắc làm và commit

- Làm **từng phase một**. Hết mỗi phase: chạy test gate, báo kết quả (pass/fail + output liên quan), rồi chờ bạn đồng ý
  mới làm phase sau.
- Mỗi phase **một commit** (Conventional Commits có scope), chỉ commit khi gate của phase đó pass.
- Test gate:
  - Backend: trong `backend/`: `npm run typecheck && npm run lint && npm run build && npm test`.
  - Frontend: trong `frontend/`: `npm run typecheck && npm run lint && npm test && npm run build`.
  - Contract (Phase 5, nếu đụng `contracts/`): `node --experimental-strip-types --test contracts/validator/contract.test.ts`.
- Chỉ stage file của phase đó; không đụng `tiktok_shop_seed_export.json`, `tiktok_shop_seed_tiktok.json` (untracked, của bạn).
- Không push, không mở PR.

---

## Phase 0 – Plan + branch

1. `git switch -c feature/voucher-batches develop` (đã làm, `develop` đã fast-forward lên `origin/develop`).
2. Commit file này.

---

## Phase 1 – Nền backend: `batchId`, bộ sinh mã, service tạo lô

**Migration** `backend/prisma/migrations/20261125000000_coupon_batch/migration.sql` (sau `20261121000000_media_asset`, migration mới nhất trên `develop`):

```sql
ALTER TABLE "Coupon" ADD COLUMN "batchId" TEXT;
CREATE INDEX "Coupon_shopId_batchId_idx" ON "Coupon"("shopId", "batchId");
```

Trước khi commit: `git fetch origin` và xem migration mới nhất trên `origin/develop`
(`git ls-tree --name-only origin/develop backend/prisma/migrations/`). Nếu đã có timestamp ≥ `20261125000000`,
đổi tên thư mục migration sang timestamp lớn hơn. `npm test` chạy toàn bộ migration trên DB mới nên sẽ bắt lỗi thứ tự.

`schema.prisma`: `batchId String?` + `@@index([shopId, batchId])` trên model `Coupon`. Không tạo bảng `CouponBatch`:
thông tin lô (title, mức giảm, hạn dùng, số lượng, ngày tạo) suy ra từ các coupon cùng `batchId`, vì chúng giống nhau.

**Bộ sinh mã** `backend/src/coupons/promo-code.ts`:

- `PROMO_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'`, `GENERATED_CODE_LENGTH = 10`.
- `generatePromoCode(rand = crypto.randomInt): string`. `rand` truyền vào được để test ép trùng mã.
- Mã sinh ra luôn khớp `PROMO_CODE_PATTERN` hiện có, nên checkout và `normalizeCode` không phải đổi.

**Service** `backend/src/coupons/coupon-batch.service.ts` (+ `CouponsModule` export service; `DemoModule` và
`TestAdminModule` import, **`TiktokModule` không import**):

- `createBatch(shopId, input, now)`: input gồm `title`, `discount` (AMOUNT_OFF | PERCENT_OFF + `maxDiscountVnd`),
  `minSpendVnd?`, `startAt?` (mặc định giờ BUSINESS clock), `endAt`, `audience` (ALL | NEW), `quantity` (1–500).
- Thuật toán, **toàn bộ trong một transaction** (tạo đủ N mã hoặc không tạo mã nào):
  1. Sinh N mã khác nhau trong bộ nhớ (`Set`).
  2. `findMany({ where: { shopId, promoCode: { in: codes } } })`, sinh lại các mã đã tồn tại trong shop (kể cả mã seller gõ tay), lặp đến khi hết trùng.
  3. `createMany` N coupon: cùng `batchId` (uuid), `redemptionLimit = 1`, `externalId = numericId('7700', 'coupon:' + id)` như hiện tại.
  4. Nếu `P2002` (request khác chèn cùng mã giữa bước 2 và 3): chạy lại cả transaction, tối đa 3 lần, rồi mới báo lỗi.
- `deactivateBatch(shopId, batchId)`: `updateMany` đặt `deactivated = true` cho mọi coupon của lô. Lặp lại không lỗi.
- `listBatches(shopId, now)` / `getBatch(shopId, batchId, now)`: gom nhóm, đếm `total`, `redeemed`, `status`
  (suy ra như `couponStatus`, cả lô cùng cửa sổ thời gian).
- Không đổi `computeDiscount`, `reserveCoupon`: mã trong lô đi qua đúng đường checkout cũ.
- **Đốt mã khi hủy (Q8)**, `backend/src/coupons/coupon-rules.ts` → `releaseCouponForOrder`:
  - Vẫn xóa dòng `CouponUsage` trước, chỉ giảm `redeemedCount` nếu lệnh xóa thực sự xóa được một dòng (exactly-once như cũ).
  - Nếu coupon có `batchId`: trong cùng lệnh `UPDATE`, đặt thêm `deactivated = true` và `updatedAt = now` (business clock).
  - Voucher lẻ (`batchId IS NULL`): giữ nguyên hành vi 09a-5.
  - Hàm được gọi từ transaction hủy đơn ở `orders.service.ts`, nên rollback cùng đơn. Chữ ký hàm nhận thêm `now`.

**Test** (`backend/test/coupon-batches.e2e-spec.ts`, phần service):

- Mã đúng regex `^[A-HJ-NP-Z2-9]{10}$`, N mã khác nhau, cùng `batchId`, `redemptionLimit = 1`.
- `rand` cố định để ép sinh trùng với một mã tay đã có: service sinh lại, không lỗi, không trùng.
- Hai lô tạo đồng thời trong cùng shop: không trùng mã, tổng số coupon đúng.
- `quantity` 0 và 501 bị từ chối.
- Q8: hủy đơn UNPAID dùng mã lô → `redeemedCount = 0`, `deactivated = true`, không còn dòng `CouponUsage`.
  Hủy lặp lại không đổi gì thêm. Voucher lẻ bị hủy đơn vẫn hoàn lượt và **không** bị tắt (test 09a cũ vẫn pass).
- Hủy sau thanh toán: mã lô giữ `redeemedCount = 1`, không bị tắt.

Gate: backend. Commit ⭐.

---

## Phase 2 – API `/demo` cho lô + ẩn mã lô khỏi buyer

File: `backend/src/demo/coupons.controller.ts` (hoặc controller mới `coupon-batches.controller.ts` trong `DemoModule`).

| Endpoint | Vai trò | Hành vi |
|---|---|---|
| `POST /demo/shops/:shopId/coupon-batches` | Seller của shop | zod body như `CreateCoupon` nhưng **bỏ `promoCode` và `redemptionLimit`**, thêm `quantity` 1–500. Trả `201 { batch, codes: [{ id, promoCode }] }`. |
| `GET /demo/shops/:shopId/coupon-batches` | Seller | Danh sách lô: `id`, `title`, `discountText`, `status`, `quantity`, `redeemed`, `startAt`, `endAt`, `createdAt`. |
| `GET /demo/shops/:shopId/coupon-batches/:batchId` | Seller | Lô + từng mã: `id`, `promoCode`, `redeemedCount`, `status`. |
| `PATCH /demo/shops/:shopId/coupon-batches/:batchId` | Seller | Chỉ `{ deactivated: true }` (tắt cả lô). Lô không tồn tại → 404. |

Đổi hành vi có sẵn:

- `GET /demo/shops/:shopId/coupons`:
  - Buyer: **lọc bỏ `batchId != null`** (Q6).
  - Seller: cũng lọc bỏ mã thuộc lô (xem theo lô ở endpoint mới). Không thì trang Vouchers poll 10 s sẽ kéo hàng trăm dòng.
- `POST /demo/shops/:shopId/coupons`: **`promoCode` thành tùy chọn**. Bỏ trống thì sinh bằng `generatePromoCode` (kiểm trùng như Phase 1). Gõ tay vẫn theo quy tắc 6–12 cũ.
- `PATCH /demo/shops/:shopId/coupons/:couponId` trên mã thuộc lô: cho phép như cũ (tắt một mã lẻ trong lô).
- Router TikTok: Search/Get trả cả mã lô (đó là cách SmartOmni kéo về), `batchId` không xuất hiện trong response (Q10).
  Thay đổi duy nhất: `title_keyword` trong `backend/src/tiktok/coupons.controller.ts` đổi thành
  `{ contains: keyword, mode: 'insensitive' }` (Q9); cập nhật mô tả trong `tiktok-b.paths.ts`.

**Quyền**: buyer gọi các route lô → 403; seller shop khác → 403 (dùng `assertSellerShop` như hiện tại).

**OpenAPI**: thêm 4 route vào `backend/src/openapi/demo.paths.ts`, sửa mô tả `GET/POST /coupons`, chạy
`npm run openapi:export` để cập nhật `docs/openapi.json`. `test/openapi.e2e-spec.ts` phải pass.

**Test** (thêm vào `coupon-batches.e2e-spec.ts`):

- Tạo lô qua `/demo` → Search Coupon List (token SmartOmni, `title_keyword`) thấy đủ N mã, phân trang `page_size=100` với 150 mã.
- Get Coupon một mã: `usage_limits.redemption_limit = 1`, `display_channels = ['PRIVATE']`, `creation_source = 'SELLER_CENTER'`, không có `batchId`.
- Buyer checkout bằng một mã → `redeemed_count = 1`; buyer khác dùng lại mã đó → 400 `coupon_exhausted`.
- Hủy đơn UNPAID → Get Coupon trả `redeemed_count = 0` + `status = DEACTIVATED`; buyer gõ lại mã đó → 400 `coupon_deactivated` (Q8).
- Search `title_keyword: "diamond"` tìm thấy lô `Loyalty Diamond 30%` (Q9).
- Buyer `GET /coupons` không thấy mã lô, vẫn thấy voucher lẻ; buyer gõ mã lô ở checkout vẫn được giảm.
- Tắt lô → mọi mã `DEACTIVATED` trong Search; checkout trả `coupon_deactivated`.
- `POST /coupons` không có `promoCode` → mã 10 ký tự đúng bảng chữ.
- Buyer / seller shop khác gọi route lô → 403.
- **Giữ nguyên** test "signed POST/PUT/PATCH/DELETE → 404 thuần, manifest giữ `coupon_create` unsupported"
  ([tiktok-coupons.e2e-spec.ts:160](../backend/test/tiktok-coupons.e2e-spec.ts)). Từ giờ nó là **regression guard có chủ đích** cho Q1.
- Reset SHOP xóa cả mã lô (reset đã `coupon.deleteMany` theo shop; chỉ thêm một assert).

Gate: backend. Commit ⭐.

---

## Phase 3 – `/test-admin`: scenario loyalty-vouchers

File: `backend/src/test-admin/loyalty-admin.controller.ts` (cạnh `scenarios/loyalty-orders`, cùng `AdminTokenGuard`).

- `POST /test-admin/scenarios/loyalty-vouchers`
  `{ "shopId": "...", "quantityPerTier": 20, "validDays": 30, "tiers"?: [{ "name": "Silver", "percentage": 10, "maxDiscountVnd"?: ... }] }`
  - Mặc định `tiers` = Silver 10 / Platinum 20 / Diamond 30, `quantityPerTier` 1–500 (mặc định 20), `validDays` 1–365 (mặc định 30).
  - Tạo mỗi tier một lô bằng `CouponBatchService.createBatch`. Title: `Loyalty Silver 10%`, `Loyalty Platinum 20%`, `Loyalty Diamond 30%`.
  - Trả `{ batches: [{ tier, batchId, title, codes: [...] }] }`.
  - Mỗi lần gọi tạo lô mới (không idempotent); ghi rõ trong OpenAPI.
- `GET /test-admin/coupons`:
  - Query mới: `batchId` (lọc), `after` (cursor `seq`), `limit` (1–500, mặc định 200). Trả `{ items, next }`, `next` rỗng ở trang cuối.
  - Mỗi dòng thêm `batchId` và `usages: [{ orderId, discountVnd, at }]`. Đây là liên kết đơn ↔ mã **chỉ có ở test-admin**
    (Q10), để test và Test Console kiểm chứng mã nào được dùng trong đơn nào.
  - Test Console cũ đọc `items` nên vẫn chạy; Phase 4 thêm nút tải trang sau.
- OpenAPI `backend/src/openapi/test-admin.paths.ts` + export `docs/openapi.json`.

**Test**:
- Thiếu token admin → 401.
- 3 lô đúng % và số lượng; mã kéo được qua Search của TikTok router; `tiers` sai (% ngoài 1–100) → 400.
- Phân trang: lô 250 mã, `limit=100` → 3 trang, không trùng, không sót.
- Sau checkout bằng một mã, `usages` của mã đó có đúng `orderId`.

Gate: backend. Commit.

---

## Phase 4 – Seller Center UI + Test Console

UI text tiếng Anh. Dùng lại `api()`, `ApiError`, `useAsync`, `vnd` trong `frontend/src/lib/`.

**`frontend/src/lib/`**:
- `types.ts`: `CouponBatch`, `CouponBatchDetail`.
- `endpoints.ts`: `createCouponBatch`, `listCouponBatches`, `getCouponBatch`, `deactivateCouponBatch`.

**`frontend/src/pages/seller-center/SellerVouchers.tsx`**:
- Hai tab: **Vouchers** (như cũ) và **Code batches**.
- Dialog "New voucher": ô Code thành tùy chọn, gợi ý "Leave empty to generate a 10-character code".
  `voucherValid`/`voucherBody` cho phép code rỗng.
- Dialog "New code batch": Title, Discount type + value (+ Max discount cho %), Min spend, Valid for (days), Quantity (1–500),
  Audience. Không có ô Code. Ghi chú: "Each code can be used once. Codes are private: buyers must type them."
- Bảng lô: Title, Discount, Status, Used (`redeemed / quantity`), Valid until, Created, hành động **View codes** và **Deactivate**.
- Dialog "View codes": bảng mã + trạng thái từng mã, nút **Copy all** (clipboard) và **Download CSV**
  (tạo ở client: `promo_code,coupon_id,redeemed_count,status`).
- Lỗi API hiện ngay trong dialog (như dialog hiện tại).

**`frontend/src/features/coupons.console.tsx`**:
- Thêm cột Batch, cột Used in order (`usages[].orderId`), ô lọc theo batch và nút "Load more" (cursor `next`).
- Thêm nút "Create loyalty voucher batches" gọi scenario Phase 3 qua proxy `/test-admin`.

**`SellerHome`**: card "Active vouchers" vẫn đếm voucher lẻ, thêm dòng "Code batches: n active". Nếu muốn giữ nguyên Home thì bỏ ý này.

**Test** (Vitest):
- `SellerCenterPages.test.tsx`: tạo lô (gửi đúng body, không có `promoCode`), bảng lô hiển thị đúng `Used`, Deactivate gọi đúng endpoint,
  View codes hiện danh sách, Download CSV đúng cột.
- `voucherValid` chấp nhận code rỗng nhưng từ chối code sai quy tắc.
- `CheckoutPage.test.tsx` không phải đổi (buyer list đã lọc ở backend).

Gate: frontend. Commit ⭐.

---

## Phase 5 – Tài liệu + e2e

**Tài liệu**:
- `DECISIONS.md` mục mới **Phase 09c – voucher batches**: Q1–Q10 + 7 ràng buộc đồng bộ. Sửa dòng 09a-5 để
  nói rõ quy tắc hoàn lượt giờ chỉ áp cho voucher lẻ (mã lô bị đốt theo Q8). Ghi thêm rằng 09a-1 vẫn đúng
  (không có route tạo trên router TikTok); lô là dữ liệu Seller Center.
- `spec/09-coupons-loyalty.md`: thêm mục theo dõi 09c (đã làm, bằng chứng test, chưa làm).
- `docs/smartomni-requirements/phase-09.md`: viết lại Step 5 thành luồng SmartOmni:
  - Staff cấu hình tier → lô theo title.
  - Kéo mã bằng Search (lọc `title_keyword`, `status=ONGOING`, phân trang `page_token`), lưu `coupon_id` + `promo_code`.
  - Khách claim → giao một mã chưa giao. Việc theo dõi ai nhận mã nào là của SmartOmni.
  - Theo dõi dùng mã bằng Get Coupon `usage_stats.redeemed_count` (ràng buộc 1–4).
  - Không bao giờ tạo coupon qua API (vẫn khóa như cũ).
- `docs/api-reference.md` mục 7.8 + phần `/demo` và `/test-admin`: thêm route mới, ví dụ request/response.
- `README.md`: thêm dòng 09c vào bảng phase (cạnh dòng `09a Coupons`) và nhắc "Code batches" ở dòng `/seller-center/vouchers`.

**e2e Playwright** `e2e/tests/phase09c-voucher-batches.spec.ts`:
- Seller tạo lô 3 mã trên Seller Center, mở View codes, lấy một mã.
- Buyer: ô chọn voucher **không** hiện mã lô; gõ mã → tổng tiền giảm đúng; đặt đơn thứ hai cùng mã → thông báo hết lượt (từ lỗi `coupon_exhausted`) hiện dưới ô voucher.
- Buyer đặt đơn bằng mã thứ hai rồi hủy khi chưa thanh toán → gõ lại mã đó bị từ chối (mã đã bị đốt).
- Seller: bảng lô hiện `Used 1 / 3`, View codes hiện mã thứ hai là `DEACTIVATED`.
- `phase09a-coupons.spec.ts` vẫn pass.

Gate: backend + frontend + `cd e2e && npm test` (cần stack chạy; nếu không chạy được thì ghi rõ lý do). Commit docs và e2e riêng.

---

## Rủi ro đã xử lý

| Rủi ro | Giải pháp | Ở đâu |
|---|---|---|
| Đơn hàng không cho biết dùng mã nào | Không thêm field ngoài OAS vào router TikTok (Q10). Loyalty không cần liên kết này: chỉ cần biết mã đã dùng chưa (Get Coupon) và điểm tính theo `sub_total`. Liên kết đơn ↔ mã có ở `GET /test-admin/coupons` (`usages`) để test kiểm chứng. `voucher_deduction_seller` là mã loại giảm giá, không phải số tiền, nên không có sai lệch tiền. | Q10, ràng buộc 4, Phase 3 |
| SmartOmni phải gọi Get Coupon cho từng mã | Chỉ poll mã đã giao mà chưa ở trạng thái cuối. Mã hết hạn hoặc bị tắt thì lọc hàng loạt bằng Search `status`. Gọi Get Coupon theo `coupon_id` đã lưu. Q8 bảo đảm trạng thái cuối không bao giờ quay lại, nên số mã cần poll chỉ giảm dần. | Ràng buộc 1–2, phase-09.md |
| `title_keyword` phân biệt hoa thường | Search đổi sang không phân biệt hoa thường. | Q9, Phase 2 |
| `redeemed_count` giảm 1 → 0 làm mã quay lại pool | Mã lô bị đốt (`DEACTIVATED`) khi đơn UNPAID hủy, nên không dùng lại được. | Q8, Phase 1 |
| Trùng hoặc lệch thứ tự timestamp migration | Kiểm tra `origin/develop` trước khi commit Phase 1, đổi timestamp nếu cần; `npm test` chạy migrate trên DB mới. | Phase 1 |
| `GET /test-admin/coupons` chỉ trả 200 dòng | Lọc `batchId` và phân trang cursor (`after`, `limit` ≤ 500). | Phase 3, Phase 4 |

## Quyết định phụ

"Voucher lẻ" = voucher tạo bằng nút **New voucher** (phase 09a): một mã dùng chung cho mọi buyer đến hết
`redemptionLimit`, hiện công khai ở checkout, hủy đơn UNPAID thì hoàn lượt. Khác với mã thuộc lô.

Không còn điểm mở.

### Đã chốt

| Điểm | Quyết định |
|---|---|
| Ô Code của voucher lẻ thành tùy chọn (để trống thì tự sinh mã 10 ký tự như lô) | Có (Phase 2, 4) |
| Seller Home thêm dòng "Code batches: n active" | Có (Phase 4) |
| Danh sách voucher của seller ẩn mã lô (xem theo lô ở tab riêng) | Có (Phase 2) |
| Qua API không phân biệt "bị đốt do hủy đơn" với "seller tắt" | Không cần phân biệt: cả hai là `DEACTIVATED`, `redeemed_count` về 0 khi bị đốt (Q8) |
