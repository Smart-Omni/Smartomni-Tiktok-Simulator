# Plan: dọn tên seed, buyer mua ở mọi shop, ảnh sản phẩm và category trong Seller Center

Mục tiêu:
1. Bỏ chữ "(demo)" khỏi tên shop; buyer trên màn Sign in không hiện tên shop và không trùng tên.
2. Buyer xem và mua hàng của mọi shop, không chỉ shop mặc định của mình.
3. Seller tạo/sửa sản phẩm với ảnh upload thật, category, brand, `productAttributes`, cân nặng và kích thước
   kiện hàng. Dùng lại dữ liệu category/attribute/brand đã setup cho router TikTok, không tạo dữ liệu mới.

Branch: `feature/product-media`, tách từ `feature/tts-oas-alignment` (không phải `develop`: `develop` chưa có
shop C/D/E, `fashion-catalog.json`, `simulator-catalog.json` và CLAUDE.md mới mà plan này dựa vào).

## Quyết định đã chốt

- Không xóa shop, seller, buyer hay sản phẩm nào. Shop A/B chỉ bỏ " (demo)" khỏi tên.
- Đổi tên 4 buyer trùng tên ở shop D/E (tên ở Phase 2, có thể đổi).
- Ảnh lưu trong Postgres (`bytea`, model `MediaAsset`).
- Form sản phẩm là trang riêng (`/seller-center/products/new`, `/seller-center/products/:id/edit`),
  thay cho dialog `NewProductDialog`.

## Thứ tự và lý do

| # | Phase | Vì sao ở vị trí này | Commit |
|---|---|---|---|
| 1 | Đổi tên shop | Nhỏ, đổi dữ liệu nền mà các phase sau và test dùng | ✅ |
| 2 | Đổi tên buyer + Sign in | Sign in bỏ tên shop chỉ dùng được khi tên buyer đã khác nhau | ✅ |
| 3 | Buyer mua ở mọi shop | Đổi luồng mua của buyer; nên xong trước khi sửa catalog để test không chồng nhau | ⭐ |
| 4 | Tách dữ liệu category dùng chung | Refactor không đổi hành vi; Phase 6 cần | ✅ |
| 5 | Lưu ảnh thật | Phase 6 cần uri ảnh để validate | ⭐ |
| 6 | Mở rộng API `/demo` catalog | Backend hoàn chỉnh trước khi làm form | ⭐ |
| 7 | Form sản phẩm (frontend) | Cần API của Phase 5-6 | ⭐ |
| 8 | Hoàn tất: e2e, tài liệu | Kiểm tra toàn bộ sau khi ghép | ✅ |

⭐ = phase quan trọng (đổi hành vi người dùng hoặc API, có migration).

### Quy tắc commit

- Mỗi phase kết thúc bằng **một commit** (Conventional Commits có scope, như `AGENTS.md`), chỉ commit khi
  test gate của phase đó pass. Phase ⭐ bắt buộc commit riêng, không gộp với phase khác.
- Test gate:
  - Backend đổi: trong `backend/`: `npm run typecheck && npm run lint && npm run build && npm test`.
  - Frontend đổi: trong `frontend/`: `npm run typecheck && npm run lint && npm test && npm run build`.
- Chỉ stage file của phase đó (không đụng `AGENTS.md`, `tiktok_shop_seed_*.json` đang sửa dở).
- Không push, không mở PR nếu chưa được yêu cầu.

---

## Phase 1 – Bỏ chữ "(demo)" khỏi tên shop

Hiện trạng: `backend/src/seed/seed-data.ts` (dòng 68, 133):
- Shop A `Cửa hàng Mộc Lan (demo)` → `Cửa hàng Mộc Lan`
- Shop B `Tiệm Gốm Bát Tràng (demo)` → `Tiệm Gốm Bát Tràng`

Việc cần làm:
1. Sửa 2 tên trong `seed-data.ts`.
2. DB đang chạy tự đổi tên khi seed lại (khởi động với `SEED_ON_START=true` hoặc `npm run seed`), vì upsert
   shop có cập nhật `name` ([seed.service.ts:103](../backend/src/seed/seed.service.ts)). Không cần reset.
3. Cập nhật các chỗ so sánh theo tên cũ:
   - `frontend/src/mocks/catalog.ts` (`seedShop`), `frontend/src/mocks/identities.ts` (`defaultMockShop`).
   - `frontend/src/__tests__/LoginPage.test.tsx`.
   - Test backend và e2e Playwright có nhắc tên cũ (khoảng 24 chỗ, tìm bằng `grep "(demo)"`), trừ category
     `Hàng hạn chế (demo)` không liên quan.

Gate: backend + frontend.
Commit: `fix(seed): drop the "(demo)" suffix from shop names`

## Phase 2 – Buyer không trùng tên, Sign in không hiện tên shop

Hiện trạng:
- Shop C/D/E dùng chung 2 buyer `Nguyễn Minh Khôi`, `Trịnh Bảo Ngọc`, cùng địa chỉ
  ([seed-data.ts:203-206](../backend/src/seed/seed-data.ts)).
- `frontend/src/pages/LoginPage.tsx` (dòng 63-70) hiện dòng phụ của buyer là `tên shop · thành phố`,
  ví dụ "Tiệm Gốm Bát Tràng (demo) · Da Nang".

Việc cần làm:
1. Đổi tên và địa chỉ buyer ở shop D/E (tên đề xuất):

   | Shop | Buyer 1 | Buyer 2 |
   |---|---|---|
   | C (giữ nguyên) | Nguyễn Minh Khôi · Hồ Chí Minh | Trịnh Bảo Ngọc · Hà Nội |
   | D | Phan Gia Huy · Đà Nẵng | Đỗ Thanh Hương · Cần Thơ |
   | E | Bùi Quang Vinh · Hải Phòng | Lý Ngọc Trâm · Huế |

   - Đổi `FASHION_SHOPS_SEED` để mỗi shop có danh sách buyer riêng thay vì 2 tên dùng chung.
   - Upsert buyer hiện chỉ cập nhật `name`, `phone` ([seed.service.ts:129](../backend/src/seed/seed.service.ts)).
     Thêm `addressLine`, `district`, `city` vào `update` để DB đang chạy cũng nhận địa chỉ mới.
   - `id`, `externalId`, email (`buyer.d-1@...`) giữ nguyên, nên cart/đơn/chat cũ không mất.
2. Sign in: dòng phụ của buyer chỉ còn thành phố; seller vẫn hiện tên shop.
3. Sửa câu không còn đúng: "Shop from your own demo shop..." (dòng 93) và
   "A buyer can only buy from their own shop." (dòng 229).
4. Cập nhật `LoginPage.test.tsx` và test/e2e tìm buyer theo tên ở shop D/E (nếu có).

Gate: backend + frontend.
Commit: `feat(seed): give every seeded buyer a unique name and hide the shop on buyer sign-in`

## Phase 3 ⭐ – Buyer xem và mua hàng của mọi shop

Hiện trạng:
- Backend đã gần như sẵn sàng:
  - `assertShopAccess` cho buyer vào mọi shop ACTIVE.
  - Có `GET /demo/catalog` (mọi shop, tìm kiếm, phân trang) và `GET /demo/catalog/:shopId/:productId`.
  - Có `GET /demo/cart` (cart gộp theo shop) và `GET /demo/buyer/orders`.
  - Cart/checkout theo shop lấy `shopId` từ URL. Checkout xóa cart đúng shop của đơn, vì
    `buyerOf(p, shopId)` trả `shopId` của URL ([orders.controller.ts:38-41](../backend/src/demo/orders.controller.ts)).
- Frontend bị giới hạn 1 shop vì mọi call dùng `session.shopId` (`frontend/src/lib/endpoints.ts`, hàm `shop(s, ...)`):
  `HomePage`, `ProductPage`, `CartPage`, `CheckoutPage` gọi `listStorefrontProducts(buyer)`.

Việc cần làm:
1. Backend:
   - Giữ nguyên buyer và `Buyer.shopId`; shop đó chỉ còn là shop mặc định lúc đăng nhập.
   - Rà coupon, chat, aftersale của buyer: phải lấy `shopId` từ URL, không dùng `p.shopId`.
2. Frontend:
   - Home: dùng `GET /demo/catalog` (mọi shop), hiện tên shop trên `ProductCard`.
   - Product page: route mang `shopId` (ví dụ `/product/:shopId/:productId`), gọi API của shop đó.
     Giữ route cũ chạy được (redirect hoặc tự tìm shop).
   - Add to cart, chat với shop, coupon: dùng `shopId` của sản phẩm.
   - Cart: dùng `GET /demo/cart`, nhóm theo shop như TikTok.
   - Checkout: mỗi shop một đơn riêng, trang hiện tổng của các đơn.
   - My orders: dùng `GET /demo/buyer/orders`.
3. Test: buyer xem được sản phẩm shop khác, thêm vào cart từ 2 shop, checkout ra 2 đơn, cart của shop chưa
   đặt vẫn còn.

Gate: backend + frontend.
Commit: `feat(frontend): let buyers browse and buy from every shop`
(nếu backend có sửa thì commit backend riêng trước: `fix(demo): ...`).

## Phase 4 – Tách dữ liệu category dùng chung

Hiện trạng: category, attribute, brand chỉ có trong router TikTok
([products.controller.ts:90-124](../backend/src/tiktok/products.controller.ts)):
- `CATEGORIES_DATA`: 9 category demo và 148 category từ `simulator-catalog.json`.
- `attributesByCategory`: 123 leaf category (ví dụ "Quốc gia xuất xứ" là bắt buộc).
- `BRANDS_DATA`, `REQUIRED_ATTRS`, `DIMENSIONS_REQUIRED`, hàm validate listing (dòng 161-195).
- Test `backend/test/routers.e2e-spec.ts` cố định danh sách import của `TiktokModule`.

Việc cần làm:
1. Chuyển các hằng số và hàm trên sang file thuần TS `backend/src/catalog-meta/` (không phải Nest module).
2. Router TikTok import lại từ đó, hành vi giữ nguyên.

Gate: backend; test hiện có pass không cần sửa, import của `TiktokModule` không đổi.
Commit: `refactor(catalog): move category, attribute and brand data out of the TikTok controller`

## Phase 5 ⭐ – Lưu ảnh thật trong Postgres

Hiện trạng: `POST /product/202309/images/upload` ([products.controller.ts:863](../backend/src/tiktok/products.controller.ts)) là giả:
ghi file theo `originalname` (rủi ro path traversal / ghi đè), trả URL `https://simulator.smartomni.local/uploads/...`
không ai serve, và ghi vào `./data/media` (mất khi deploy Render vì `render.yaml` không có disk).

Việc cần làm:
1. Migration mới: model `MediaAsset` (`id`, `shopId`, `mimeType`, `bytes Bytes`, `width`, `height`, `sizeBytes`, `createdAt`).
2. `POST /demo/shops/:shopId/media/images` (multipart, chỉ seller của shop đó):
   - Chỉ nhận jpg/png/webp, kiểm tra bằng magic bytes (không tin `mimetype`); tối đa 5 MB; đọc width/height.
   - Trả `{ uri, url, width, height }`.
3. `GET /demo/media/images/:id`: public (thẻ `<img>` không gửi được header session), có `Content-Type` và cache.
4. Tùy chọn: `product/202309/images/upload` của TikTok dùng cùng kho này.
5. Test e2e: sai định dạng, quá 5 MB, shop khác → bị từ chối; ảnh upload xong lấy lại được đúng byte.
6. Cập nhật `backend/src/openapi/`, export lại `docs/openapi.json`.

Gate: backend.
Commit: `feat(media): store uploaded product images in PostgreSQL`

## Phase 6 ⭐ – Mở rộng API `/demo` catalog

Hiện trạng: `/demo` create/update product ([catalog.controller.ts:46-71](../backend/src/demo/catalog.controller.ts))
chỉ nhận `title`, `description`, `status` và SKU; `mainImages` luôn `[]`; `sellerView` không trả field listing.

Việc cần làm:
1. Endpoint mới (đọc từ `catalog-meta`):
   - `GET /demo/shops/:shopId/catalog/categories` (dạng cây)
   - `GET /demo/shops/:shopId/catalog/categories/:id/attributes`
   - `GET /demo/shops/:shopId/catalog/categories/:id/rules`
   - `GET /demo/shops/:shopId/catalog/brands`
2. `CreateProduct` và `UpdateProduct` nhận thêm `categoryId`, `brandId`, `images` (1-9 uri của `MediaAsset`
   thuộc shop), `productAttributes`, `packageWeight`, `packageDimensions`.
   - Validate bằng đúng hàm của TikTok: category là leaf, đủ attribute bắt buộc, có dimensions khi category
     yêu cầu, brand tồn tại.
   - Lưu `mainImages` dạng `{ uri, urls: [url tuyệt đối từ PUBLIC_API_BASE_URL], thumb_urls, width, height }`,
     để storefront và TikTok Get Product trả ảnh thật.
3. `sellerView` trả thêm `images`, `categoryId`, `brandId`, `productAttributes`, `packageWeight`, `packageDimensions`.
4. Test e2e: thiếu attribute bắt buộc, category không phải leaf, uri ảnh của shop khác → 400; tạo xong thì
   storefront và TikTok Get Product trả ảnh thật.
5. Cập nhật `backend/src/openapi/`, export lại `docs/openapi.json`, thêm mục DA-14 vào `DECISIONS.md`.

Gate: backend (gồm `test/openapi.e2e-spec.ts`).
Commit: `feat(demo): accept images, category, brand and attributes when creating products`

## Phase 7 ⭐ – Form sản phẩm (frontend)

Việc cần làm:
1. Trang `/seller-center/products/new` và `/seller-center/products/:id/edit`, gồm:
   - **Basic info:** title, description.
   - **Images:** kéo-thả hoặc chọn tối đa 9 ảnh; preview, xóa, đổi thứ tự; ảnh đầu là ảnh chính. Mỗi ảnh
     upload ngay khi chọn, có trạng thái loading/lỗi.
   - **Category:** chọn theo cấp (cha → con → leaf), có ô tìm theo tên.
   - **Brand:** select.
   - **Attributes:** sinh theo category. Bắt buộc có dấu `*`; có `values` thì select (multi nếu
     `is_multiple_selection`); `is_customizable` thì nhập tự do; đổi category thì xóa attribute không hợp lệ.
   - **Shipping:** cân nặng; kích thước (bắt buộc khi rules yêu cầu).
   - **Variants:** giữ như hiện tại.
2. Thêm hàm vào `frontend/src/lib/endpoints.ts` (upload dùng `FormData`, không set `Content-Type` JSON) và
   type mới vào `frontend/src/lib/types.ts`.
3. `ProductCard` của seller hiện thumbnail và nút "Edit details"; bỏ `NewProductDialog`.
4. Text UI bằng tiếng Anh.
5. Vitest: sinh attribute theo category, validate, upload.

Gate: frontend.
Commit: `feat(seller-center): add a product page with image upload, category and attributes`

## Phase 8 – Hoàn tất

1. Chạy e2e Playwright (`cd e2e && npm test`) trên stack đầy đủ; sửa test hỏng vì route/text mới.
2. Cập nhật `README.md` (luồng buyer marketplace, upload ảnh) và `PROGRESS.md` nếu có.
3. Chạy lại gate của cả backend và frontend.

Commit: `test(e2e): cover cross-shop buying and product images`
