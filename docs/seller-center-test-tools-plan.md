# Plan: đưa các API test vào Seller Center

Mục tiêu: người test làm toàn bộ việc tạo dữ liệu và điều khiển simulator ngay trong Seller Center
(`/seller-center/*`), không phải chuyển qua Test Console (`/console`). Mỗi API test được nối vào **đúng trang
nghiệp vụ** của nó. Các API dùng chung cho mọi shop thì nằm ở hai trang mới trong nhóm **Testing**.

- Chỉ sửa frontend. Backend, router TikTok, OpenAPI và DB đều giữ nguyên.
- `/console` vẫn hoạt động như cũ: panel được dùng lại, không bị chuyển chỗ hay xóa.
- Chữ trên giao diện viết bằng tiếng Anh (theo CLAUDE.md).

---

## 1. Hiện trạng (đã kiểm tra ngày 2026-11-27)

- **API `/demo` của seller:** đã nối đủ vào Seller Center. Còn 2 API không trang nào dùng, xem mục 3.3.
- **API test:** chưa có API nào trong Seller Center. Gồm 40 API `/test-admin/*`, 3 API `/api/v2/simulator/dispute*`
  và `POST /api/v2/media/upload`. Hiện tất cả chỉ có trong `/console`.
- **Có thể dùng lại:** `/console` đã có sẵn panel cho từng nhóm. Panel nào cũng nhận `shopId`.
  - `pages/console/*Panel.tsx`
  - `features/*.console.tsx`
  - Hàm gọi API: `pages/console/adminEndpoints.ts`, `disputeEndpoints.ts`, `mediaEndpoints.ts`
- **`shopId` dùng chung được.** `seller.shopId` của phiên seller chính là `Shop.id`
  (`backend/src/demo/demo.module.ts` → `issueSession`). `/test-admin` cũng dùng id này.
- **`:ref` nhận cả hai loại id.** Với đơn hàng, `findForAdmin` nhận cả `id` lẫn `externalId`. Seller Center đang
  hiển thị `externalId`, nên truyền thẳng vào `/test-admin/orders/:ref/...` được.
- **Token admin:**
  - Token do proxy gắn ở phía server: vite dev, nginx, hoặc `frontend/api/test-admin.ts` trên Vercel.
  - Frontend chỉ cần gọi `api('/test-admin/...')`. Không bao giờ dùng `VITE_` cho token.
  - Không tạo lỗ hổng mới, vì `/console` vốn đã công khai.
- **Rủi ro CSS:**
  - Panel console dựa vào style "legacy" (`styles.css`, `console.css`). Style này chỉ áp dụng bên trong `.app`.
  - Seller Center nằm ngoài `.app`, nên `legacy-isolation.css` reset nút, input và bảng về mặc định.
  - Nếu nhúng thẳng, panel sẽ mất style. Bước 1 xử lý việc này.

---

## 2. Quyết định thiết kế

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Mỗi trang nghiệp vụ có nút **"Test tools"** trên thanh công cụ. Nút mở một **Sheet bên phải** (`components/ui/sheet.tsx`) chứa công cụ test của trang đó. | Giao diện seller giữ giống TikTok thật. Công cụ test ở ngay cạnh dữ liệu nó tác động. |
| D2 | Sidebar có thêm nhóm **Testing**, gồm 2 trang: **Integration** (`/seller-center/testing/integration`) và **System** (`/seller-center/testing/system`). | Token, webhook, HTTP log, fault, clock, reset không thuộc trang nghiệp vụ nào. |
| D3 | **Dùng lại panel console** qua wrapper `TestToolsFrame`. Wrapper bọc panel trong `.app .seller-test-tools` để style legacy hoạt động, đồng thời vô hiệu các style bố cục của `.app` (padding, min-width, chiều cao). | Không viết lại logic. Test console hiện có vẫn đúng. |
| D4 | Mọi khối test có nhãn **`TEST`** (component `TestBadge`, viết giống `MockBadge`) và một dòng ghi chú phạm vi: "This shop only" hoặc "All shops". | Người test biết đây không phải tính năng của TikTok Seller Center, và biết thao tác ảnh hưởng tới đâu. |
| D5 | **Không trùng API.** Khi Seller Center đã có bản `/demo` tương đương (ví dụ danh sách đơn), không nhúng thêm bản `/test-admin`. Hành động test được gắn vào chính dòng hoặc trang có sẵn. | Tránh hai danh sách cùng dữ liệu nhưng lệch nhau. |
| D6 | Thao tác hủy dữ liệu (revoke token, xóa fault, complete refund) luôn qua **dialog xác nhận**. Reset không có trong Seller Center. | Ngăn bấm nhầm. |
| D7 | Không thêm API backend mới. Chỉ thêm hàm gọi API vào `pages/console/adminEndpoints.ts` khi panel chưa có sẵn hàm. | Phạm vi chỉ là frontend. |

---

## 3. Bản đồ API → trang (đầy đủ)

Ký hiệu cột "Thành phần":
- **(dùng lại)**: panel console có sẵn.
- **(mới)**: viết thêm trong bước tương ứng.

### 3.1 Trang nghiệp vụ hiện có

| Trang (route) | API | Thành phần / vị trí | Bước |
|---|---|---|---|
| **Manage orders** `/seller-center/orders` | `GET /test-admin/sandbox/products?shopId=` | Sheet → `SandboxPanel` (dùng lại) | 2 |
| | `POST /test-admin/sandbox/orders` | Sheet → `SandboxPanel` (dùng lại) | 2 |
| | `POST /test-admin/scenarios/loyalty-orders` | Sheet → `LoyaltyOrdersForm` (mới: tách từ `orders.console.tsx`, có thêm **bảng kết quả**: label, orderId, status, completedAt, subTotal, total và ghi chú sub_total) | 2 |
| | `POST /test-admin/orders/:ref/transition` | Menu "Force status" trên từng dòng đơn (mới; danh sách trạng thái kế tiếp lấy từ `NEXT` trong `orders.console.tsx`, chuyển ra `lib/orderNext.ts` để hai nơi dùng chung). Không chọn trạng thái thì tiến 1 bước. | 2 |
| **Order detail** `/seller-center/orders/:id` | `POST /test-admin/orders/:ref/transition` | Cùng menu "Force status" ở đầu trang | 2 |
| | `GET /test-admin/orders/:ref/audit` | Sheet → `OrderAuditPanel` (dùng lại). Hiện actor (`TEST_CONSOLE`, `SELLER`...) và note, những thông tin mà lịch sử `/demo` không có | 2 |
| **Returns & refunds** `/seller-center/returns` | `GET /test-admin/aftersale/:ref/records` | Nút "Records" trên từng yêu cầu → Sheet (mới, gọi hàm có sẵn trong `aftersale.console.tsx`) | 3 |
| | `POST /test-admin/aftersale/:ref/complete` | Nút "Complete refund" trên từng yêu cầu (chỉ bật khi trạng thái cho phép, API là bên quyết định) | 3 |
| | `POST /test-admin/aftersale/:ref/arbitration` | Sheet → `ArbitrationPanel` (dùng lại, `initialRef` = yêu cầu đang chọn) | 3 |
| | `GET /api/v2/simulator/dispute` | Sheet → `DisputesPanel` (dùng lại) | 3 |
| | `GET /api/v2/simulator/dispute/:id` | `DisputesPanel` (dùng lại) | 3 |
| | `POST /api/v2/simulator/dispute/trigger` | `DisputesPanel` (dùng lại) | 3 |
| **Products** `/seller-center/products` | `POST /test-admin/catalog/bulk` | Sheet → `BulkProductsForm` (mới: tách form "bulk" từ `ShopsPanel`; count 1–500, SKU/sản phẩm 1–5) | 4 |
| | `POST /api/v2/media/upload` | Sheet → `MediaPanel` (dùng lại). Ghi chú: đây là API upload kiểu TikTok, khác với upload ảnh sản phẩm của seller | 4 |
| **Vouchers** `/seller-center/vouchers` | `POST /test-admin/scenarios/loyalty-vouchers` | Sheet → `LoyaltyVouchersForm` (dùng lại) | 5 |
| | `GET /test-admin/coupons?shopId=&batchId=&after=&limit=` | Sheet → `CouponsPanel` (dùng lại): mã nào đã dùng ở đơn nào. Nút "View usage" trong dialog Codes mở sẵn bộ lọc `batchId` | 5 |
| **Messages** `/seller-center/messages` | `GET /test-admin/chat/conversations` | Sheet → `ChatPanel` (dùng lại) | 6 |
| | `POST /test-admin/chat/conversations` | `ChatPanel`: tạo hội thoại với buyer lạ | 6 |
| | `POST /test-admin/chat/conversations/:ref/buyer-message` | `ChatPanel`; thêm nút "Simulate buyer reply" ngay trong khung chat đang mở | 6 |
| | `POST /test-admin/chat/conversations/:ref/flags` | `ChatPanel` | 6 |
| | `POST /test-admin/chat/conversations/:ref/agent` | `ChatPanel` | 6 |
| **Shop** `/seller-center/shop` | `GET /test-admin/shops` | Sheet → `ShopScenarioPanel` (mới: phần chọn scenario của `ShopsPanel`, chỉ hiện shop đang làm việc) | 7 |
| | `POST /test-admin/shops/:shopId/scenario` | `ShopScenarioPanel` | 7 |

### 3.2 Hai trang mới trong nhóm Testing

| Trang (route) | API | Thành phần | Bước |
|---|---|---|---|
| **Integration** `/seller-center/testing/integration` (các tab) | `GET /test-admin/tokens?shopId=` | Tab Authorization → `TokensPanel` (dùng lại) | 8 |
| | `POST /test-admin/tokens/:id/expire-access` | `TokensPanel` | 8 |
| | `POST /test-admin/tokens/:id/expire-refresh` | `TokensPanel` | 8 |
| | `POST /test-admin/tokens/:id/revoke` | `TokensPanel` (có xác nhận) | 8 |
| | `POST /test-admin/tokens/:id/remove-scope` | `TokensPanel` | 8 |
| | `POST /test-admin/authorization-codes/expire` | `TokensPanel` | 8 |
| | `GET /test-admin/webhooks` | Tab Webhooks → `WebhooksPanel` (dùng lại) | 8 |
| | `POST /test-admin/webhooks` | `WebhooksPanel` | 8 |
| | `POST /test-admin/webhooks/:jobId/replay` | `WebhooksPanel` | 8 |
| | `GET /test-admin/http-logs` | Tab HTTP log → `HttpLogPanel` (dùng lại) | 8 |
| | `GET /test-admin/faults` | Tab Faults → `FaultsPanel` (dùng lại) | 8 |
| | `POST /test-admin/faults` | `FaultsPanel` | 8 |
| | `DELETE /test-admin/faults/:id` | `FaultsPanel` (có xác nhận) | 8 |
| **System** `/seller-center/testing/system` | `GET /test-admin/status` | `StatusPanel` (dùng lại) | 9 |
| | `POST /test-admin/seed` | `StatusPanel` | 9 |
| | `GET /test-admin/clock` | `ClockPanel` (dùng lại). Ghi chú "All shops" | 9 |
| | `PUT /test-admin/clock` | `ClockPanel` | 9 |

### 3.3 API cố ý không nhúng (đã có bản tương đương)

| API | Lý do | Xử lý |
|---|---|---|
| `GET /test-admin/orders` | Manage orders đã dùng `GET /demo/shops/:id/orders`, cùng dữ liệu (D5) | Chỉ còn ở `/console` |
| `GET /test-admin/aftersale` | Returns đã dùng `GET /demo/shops/:id/aftersale` (D5) | Chỉ còn ở `/console` |
| `GET /test-admin/inventory/history` | Products đã dùng `GET /demo/shops/:id/inventory/history`, trả cả `changes` lẫn `attempts` (D5) | Chỉ còn ở `/console` |
| `POST /test-admin/reset/prepare` | Đã chốt: không đưa Reset vào Seller Center vì ảnh hưởng mọi shop | Chỉ còn ở `/console` |
| `POST /test-admin/reset` | Như trên | Chỉ còn ở `/console` |
| `GET /demo/shops/:shopId/products` | API cũ, đã được thay bằng `/catalog` | Không dùng; đề xuất xóa ở một việc riêng |
| `POST /demo/shops/:shopId/aftersale/:id/arbitrate` | Trùng với `/test-admin/aftersale/:ref/arbitration` (bước 3) | Không dùng; đề xuất xóa ở một việc riêng |

**Kiểm tra độ phủ:** 40 API `/test-admin` + 3 API dispute + 1 API media upload = 44 API.
- 39 API có chỗ trong Seller Center (mục 3.1 và 3.2).
- 3 API là danh sách trùng và 2 API reset, được giải thích ở mục 3.3.
- Bước 10 có test tự động để kiểm tra lại con số này.

---

## 4. Các bước

**Quy tắc chung:**
- Mỗi lần chỉ làm một bước.
- Kết thúc mỗi bước, chạy trong `frontend/`:
  `npm run typecheck && npm run lint && npm test && npm run build`
- Gate pass thì commit theo Conventional Commits, scope `seller-center`.
- Không push, không mở PR nếu chưa được yêu cầu.

### Bước 0: Branch (xong)

- Thay đổi đang dở trên `fix/guest-product-view` đã được commit ở đó (`1316a2c`), không mang sang branch này.
- Tạo `feature/seller-center-test-tools` từ `origin/develop` (`a994924`).

### Bước 1: Khung dùng chung

- `components/seller/TestTools.tsx`:
  - `TestBadge`.
  - `TestToolsButton`: nút trên toolbar, mở `Sheet` rộng khoảng 720px, có tiêu đề và dòng phạm vi.
  - `TestToolsFrame`: wrapper `.app .seller-test-tools`.
- `seller.css`: rule cho `.seller-test-tools`. Đặt lại `padding`, `min-width`, `height` của `.app`, và tắt các rule
  `:has(.admin-console)`, để panel console hiển thị gọn trong Sheet.
- `SellerLayout.tsx`: thêm nhóm sidebar **Testing** với 2 mục Integration và System. Route trong `App.tsx`, mỗi trang
  tạm thời là trang trống.
- **Test:** `TestTools.test.tsx`.
  - Sheet mở và đóng được.
  - `TestToolsFrame` render panel mẫu có class `.app`.
  - Sidebar có 2 link mới, route hoạt động.
- **Kiểm tra bằng mắt:** chạy `npm run dev`, nhúng thử `ClockPanel` trong Sheet, chụp màn hình để chắc style không
  vỡ. Nếu vỡ, sửa CSS trước khi sang bước 2.

### Bước 2: Manage orders và Order detail

- Tách `NEXT` sang `lib/orderNext.ts`. `orders.console.tsx` và `fulfillment.console.tsx` import lại từ đây.
- Tách form loyalty orders thành `components/seller/LoyaltyOrdersForm.tsx`.
  - Có bảng kết quả 7 cột: label, orderId, status, completedAt, subTotal, total, cùng ghi chú `note` của API.
  - `orders.console.tsx` dùng lại form này.
- Thêm vào `SellerOrders`:
  - Nút Test tools, mở Sheet có 2 tab: "Create test orders" (`SandboxPanel`) và "Loyalty orders".
  - Menu "Force status" trên từng dòng.
  - Sau khi chuyển trạng thái thành công: `list.reload()`, kèm toast `from → status`. Khi lỗi 400: toast thông báo lỗi
    từ API.
- `SellerOrderDetail`: thêm "Force status" và nút "Audit log" (mở `OrderAuditPanel`).
- Hàm gọi API (`adminEndpoints.ts`): thêm `transitionOrder(shopId, ref, to?)` và `createLoyaltyOrders(body)`.
- **Test:**
  - Body đúng `{ to, shopId }`. Không chọn `to` thì gửi `{ shopId }`.
  - Bảng loyalty hiện đủ 5 dòng và số tiền.
  - Audit mở đúng `orderRef`.

### Bước 3: Returns & refunds

- Trên mỗi yêu cầu: nút "Records" (Sheet), "Complete refund" (có xác nhận) và "Arbitrate" (Sheet `ArbitrationPanel`
  với `initialRef`).
- Nút Test tools của trang: tab "Disputes" (`DisputesPanel`).
- Hàm gọi API: `getAftersaleRecords`, `completeAftersale` (chuyển từ `aftersale.console.tsx` sang
  `adminEndpoints.ts` để dùng chung).
- **Test:**
  - Đúng URL `/test-admin/aftersale/{ref}/complete?shopId=`.
  - Arbitrate gửi `arbitration_status`.
  - Disputes lọc theo shop.

### Bước 4: Products

- Nút Test tools với 2 tab:
  - "Bulk products": `BulkProductsForm`, tách từ `ShopsPanel`, sau đó `ShopsPanel` dùng lại form này.
  - "Media upload API": `MediaPanel`.
- Tạo xong thì reload catalog.
- **Test:** body `{ shopId, count, skusPerProduct }`, giới hạn 1–500 và 1–5. Upload gửi `multipart`.

### Bước 5: Vouchers

- Nút Test tools với 2 tab:
  - "Loyalty batches": `LoyaltyVouchersForm`. Tạo xong thì reload danh sách batch và chuyển sang tab Code batches.
  - "Code usage": `CouponsPanel`.
- Dialog Codes có thêm link "View usage", mở Sheet với `batchId`. `CouponsPanel` cần nhận thêm prop
  `initialBatchId`.
- **Test:** cập nhật `AdminLoyaltyScenarios.test.tsx` và `SellerCenterPages.test.tsx`.

### Bước 6: Messages

- Nút Test tools → `ChatPanel`.
- Trong khung chat đang mở: thêm nút "Simulate buyer reply", gọi `buyer-message` với conversation đang chọn, sau đó
  reload tin nhắn.
- **Test:** body `{ text }`, đúng `ref` của hội thoại, tin nhắn mới hiện sau khi reload.

### Bước 7: Shop

- Nút Test tools → `ShopScenarioPanel`: liệt kê scenario của shop đang làm việc (từ `GET /test-admin/shops`) và cho
  kích hoạt.
- **Test:** body `{ key }`, đúng `shopId` trong URL.

### Bước 8: Trang Integration

- 4 tab: Authorization (`TokensPanel`), Webhooks, HTTP log, Faults.
- Tab hiện tại lưu vào `?tab=` để link trực tiếp được.
- Mọi panel nhận `shopId = seller.shopId`.
- Thêm xác nhận cho revoke và xóa fault nếu panel chưa có.
- **Test:** mỗi tab gọi đúng endpoint đầu tiên với `shopId`.

### Bước 9: Trang System

- `StatusPanel`, `ClockPanel`. Không có Reset (đã chốt).
- Đầu trang có cảnh báo: "These tools affect every shop".
- **Test:** seed gọi `POST /test-admin/seed`. Clock `PUT` gửi đúng body.

### Bước 10: Tổng kiểm tra

- `__tests__/sellerTestToolsCoverage.test.ts`: danh sách cứng 44 API ở mục 3, kèm trang và component tương ứng.
  Test fail nếu có API không có trong cả Seller Center lẫn danh sách loại trừ ở mục 3.3.
- Thêm một test e2e Playwright `e2e/tests/seller-test-tools.spec.ts`:
  1. Đăng nhập seller.
  2. Tạo đơn sandbox.
  3. Force status tới `COMPLETED`.
  4. Tạo loyalty batches.
  5. Xem code usage.
- Cập nhật `README.md` (mục Seller Center) và `docs/api-reference.md` (ghi chú vị trí trên giao diện).
- Kiểm tra `/console` vẫn chạy và e2e cũ vẫn pass.

---

## 5. Đã chốt (2026-11-27)

1. Công cụ test nằm trong Sheet trên từng trang (D1).
2. Không có công tắc ẩn/hiện: công cụ test luôn hiện.
3. Không đưa Reset vào Seller Center; Reset chỉ còn ở `/console`.
4. Thay đổi đang dở trên `fix/guest-product-view` đã được commit ở branch đó.
