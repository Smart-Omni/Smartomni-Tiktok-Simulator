# TikTok Shop FE – Plan + Prompts cho Claude Code

Design (10 board): https://claude.ai/artifact/4tae5Qdrpv7ncLQL6BXMV9
Repo: `Hxvf123/Smartomni-Tiktok-Simulator`, thư mục `frontend/`.

## Cách dùng file này
1. Copy file này vào repo: `docs/tiptopshop-plan.md`.
2. Mở Claude Code tại thư mục repo.
3. Làm **từng bước một**: dán prompt của bước đó → Claude Code đưa plan → bạn đọc → gõ `go` → nó code → nó chạy kiểm tra → bạn mở `npm run dev` xem → commit.
4. Bước sau chỉ bắt đầu khi bước trước đã commit.
5. Mỗi bước, mở board tương ứng trên canvas để so sánh giao diện.

## Quy tắc chung (đã nhúng vào CLAUDE.md ở Bước 0)
- Toàn bộ chữ trên UI: **tiếng Anh**.
- Không sửa `backend/`.
- Thứ gì backend chưa có thì lấy từ `src/mocks/` (sau này xoá được bằng cách xoá 1 thư mục).
- Giữ nguyên các trang cũ (`/buyer`, `/seller`, `/console`, `/seller/authorize`) cho tới Bước 13 để e2e cũ vẫn chạy.
- Mỗi bước phải pass: `npm run typecheck && npm run lint && npm test && npm run build` (trong `frontend/`).

## Bản đồ route mới
| Route | Board | API chính (prefix `/demo/shops/{shopId}`) |
|---|---|---|
| `/` | Home | mock catalog (guest) · `storefront/products` khi đã login |
| `/product/:id` | Product | `storefront/products/{id}` + mock rating/review |
| `/login` | Login | `GET /demo/identities`, `POST /demo/sessions` |
| `/cart` | Cart | `GET cart`, `PUT cart/items` |
| `/checkout` | Checkout | `POST checkout`, `POST orders/{id}/pay` |
| `/account/orders` | Orders | `GET orders`, `orders/{id}`, `orders/{id}/fulfillment`, `orders/{id}/cancel`, `aftersale/*` |
| `/seller-center` | SellerHome | `GET /demo/shops/{id}`, `catalog`, `coupons`, `orders` |
| `/seller-center/orders` | SellerOrders | `orders`, `arrange-shipment`, `shipping-label`, `advance-shipment` |
| `/seller-center/orders/:id` | SellerOrderDetail | `orders/{id}`, `orders/{id}/fulfillment` |
| `/seller-center/returns`, `/products`, `/vouchers`, `/messages` | (dùng lại logic feature cũ) | `aftersale`, `catalog`, `coupons`, `chat` |

Phần mock (viền hồng nét đứt trên canvas): catalog public cho guest, rating/review/sold, giá gốc/%giảm/free shipping, ảnh sản phẩm, số liệu Business overview.

---

## Bước 0 – Branch + CLAUDE.md
```text
Đọc README.md, DECISIONS.md, frontend/package.json, frontend/src/App.tsx, frontend/src/lib/*.ts và docs/tiptopshop-plan.md.
Việc cần làm:
1. Tạo branch mới `feat/tiptopshop-ui` từ `main`.
2. Tạo (hoặc bổ sung) file CLAUDE.md ở gốc repo với các quy tắc:
   - Luôn đưa plan ngắn và CHỜ tôi gõ "go" rồi mới sửa code.
   - Làm từng bước theo docs/tiptopshop-plan.md, không làm trước bước sau.
   - UI text tiếng Anh; không sửa backend/; dữ liệu thiếu thì lấy từ frontend/src/mocks/.
   - Kết thúc mỗi bước: chạy typecheck, lint, test, build trong frontend/ và báo kết quả.
   - Không push, không tạo PR khi tôi chưa yêu cầu.
Chỉ làm 2 việc trên. Đưa plan trước.
```

## Bước 1 – Tailwind + shadcn/ui + tokens
```text
Theo docs/tiptopshop-plan.md, Bước 1. Đưa plan trước, chờ "go".
Trong frontend/:
1. Cài Tailwind CSS v4 (@tailwindcss/vite) và cấu hình alias "@/" -> src/ (vite.config.ts + tsconfig.json). Giữ nguyên proxy hiện có trong vite.config.ts.
2. Khởi tạo shadcn/ui (style new-york, base color neutral, CSS variables). Thêm component: button, input, label, checkbox, radio-group, tabs, badge, card, separator, dialog, select, dropdown-menu, sheet, skeleton, sonner, table, textarea, tooltip, avatar.
3. Font Inter (Google Fonts trong index.html) + JetBrains Mono cho mã đơn.
4. Đặt token trong src/index.css (dùng @theme) với đúng mã màu:
   ink #161823, buyer/primary #E11D48, buyer-soft #FFF0F3, buyer-ink #B0123A,
   seller/teal #00807C, teal-soft #E6F4F3, free-ship #0B7F79, star #F5A400,
   muted #5E6066, muted-2 #6B6D73, line #D9DADC, line-soft #EDEDEF,
   surface #F1F1F2, surface-2 #F4F4F5. Radius: button pill 999px, card 12px.
   Map --primary của shadcn sang #E11D48; tạo class .theme-seller đổi --primary sang #00807C.
5. Tạo component src/components/ui/mock-badge.tsx: khung nền #FFF0F3, viền 2px dashed #FE2C55, chữ #B0123A, nhãn "MOCK".
6. KHÔNG xoá styles.css cũ, trang cũ phải trông như cũ (nếu Tailwind preflight làm vỡ trang cũ, báo tôi phương án).
Chạy typecheck/lint/test/build và báo kết quả.
```

## Bước 2 – Mock module + API types + session theo role
```text
Theo docs/tiptopshop-plan.md, Bước 2. Đưa plan trước, chờ "go".
1. Đọc docs/openapi.json, tạo src/lib/types.ts với type cho: Identity, DemoSession, StorefrontProduct, Sku, Cart, CartItem, Order (amounts, items, status, recipient), Fulfillment/Package, Aftersale, Coupon. Chỉ những field các màn hình cần.
2. Tạo src/lib/endpoints.ts: các hàm gọi API dùng lại helper api() trong src/lib/api.ts (không viết lại fetch). Mỗi hàm = 1 endpoint trong bảng route của plan.
3. Tạo src/mocks/ :
   - catalog.ts: danh sách sản phẩm cho guest (tên, giá, giá gốc, % giảm, rating, sold, freeShipping, ảnh/màu nền).
   - reviews.ts: điểm 4.8, phân bố sao, 3-5 review mẫu.
   - enrich.ts: hàm enrichProduct(p) gộp field mock vào product thật theo productId/tên.
   - index.ts export tất cả. Ghi chú đầu file: "Delete this folder when the backend provides these fields."
4. src/lib/auth.tsx: AuthProvider + useAuth() đọc/ghi session ở sessionStorage (giữ đúng key cũ `sim.demo-session.{ROLE}` để trang cũ vẫn dùng được). Có role BUYER/SELLER, signIn(identity), signOut().
5. Viết unit test cho enrichProduct và AuthProvider.
Chạy typecheck/lint/test/build.
```

## Bước 3 – Layout + route mới
```text
Theo docs/tiptopshop-plan.md, Bước 3. Đưa plan trước, chờ "go".
1. Sửa App.tsx: bỏ topbar cũ khỏi các route mới. Route mới: "/", "/product/:id", "/login", "/cart", "/checkout", "/account/orders", "/seller-center/*". Giữ nguyên route cũ /buyer/*, /seller/*, /seller/authorize, /console/* (bọc trong layout cũ).
2. Tạo src/layouts/ShopLayout.tsx (buyer, board Home/Product): sidebar trái 280px ở Home (logo "t" + "TikTok Shop", Sell, More, link footer) và icon rail 76px ở các trang còn lại; góc phải: ô search pill + pill "Cart | Sign in" (hoặc avatar khi đã login).
3. Tạo src/layouts/SellerLayout.tsx (board SellerHome): header đen 56px, chữ "Seller Center" màu teal nhạt, chọn shop, avatar; menu trái 232px: Home / Orders(Manage orders, Returns & refunds) / Products / Marketing(Vouchers) / Customer service(Messages) / Shop. Bọc .theme-seller.
4. Guard: /cart, /checkout, /account/* cần BUYER -> nếu chưa login chuyển /login?next=...; /seller-center/* cần SELLER.
5. Các trang con tạm để placeholder "Coming soon".
Chạy typecheck/lint/test/build. Chụp mô tả ngắn các route để tôi tự mở.
```

## Bước 4 – Login (board Login)
```text
Theo docs/tiptopshop-plan.md, Bước 4. Đưa plan trước, chờ "go".
Làm trang /login giống board "Sign in (shared, role-based)":
- Header đen "TikTok Shop | Sign in" + "Back to shopping".
- Banner hồng khi có ?next=: "Sign in to buy. You will return to <tên sản phẩm> after signing in."
- Card trắng: hình minh hoạ bên trái; bên phải Tabs Buyer/Seller, RadioGroup danh sách account từ GET /demo/identities (avatar chữ cái, tên, shop, thành phố), hint "No password. A buyer can only buy from their own shop.", nút pill đỏ "Sign in as <name>", "Continue browsing as guest".
- Đăng nhập: POST /demo/sessions -> lưu qua useAuth -> BUYER về ?next hoặc "/", SELLER về "/seller-center".
- Không có account: hiện link "Open Test Console and run Seed" -> /console.
- Loading/error dùng Skeleton và Alert.
Viết test: chọn seller thì nút đổi tên, sign in gọi đúng endpoint.
Chạy typecheck/lint/test/build.
```

## Bước 5 – Home (board Home)
```text
Theo docs/tiptopshop-plan.md, Bước 5. Đưa plan trước, chờ "go".
Trang "/" giống board Home:
- Section "Deals on 4★+ products for you": hàng 5 card + nút mũi tên.
- Section "Best sellers": lưới 5 cột, nút "See more".
- ProductCard (src/components/shop/ProductCard.tsx): ảnh vuông bo 8px, tên 2 dòng, giá đỏ + % giảm, badge Free shipping (#0B7F79), ★ rating + "x sold".
- Guest: dữ liệu từ src/mocks/catalog. Đã login BUYER: GET storefront/products rồi enrichProduct.
- Search pill: lọc client-side theo tên (backend chưa có search).
- Responsive: 5 -> 3 -> 2 cột.
Chạy typecheck/lint/test/build.
```

## Bước 6 – Product detail (board Product)
```text
Theo docs/tiptopshop-plan.md, Bước 6. Đưa plan trước, chờ "go".
Trang /product/:id giống board Product:
- Breadcrumb pill.
- 2 cột: TRÁI cuộn (ảnh lớn + thumbnails, khối đánh giá 4.8★ + thanh phân bố, ảnh review, chip lọc, danh sách review, mô tả); PHẢI `sticky top-6` (giá -35% ₫129.000 + giá gạch, Free shipping, badge "Trending", tên, "Sold by <shop>", ★ | sold, tile biến thể, stepper số lượng, nút "Buy now" pill đỏ và "Add to cart" viền).
- Biến thể từ SKU thật; SKU hết hàng thì disabled + gạch. Giá/kho đổi theo SKU chọn. Stepper giới hạn theo stock.
- Tile biến thể là radio có accessible name đúng tên SKU (vd "Trắng / M").
- Add to cart: chưa login -> /login?next=/product/:id; đã login -> PUT cart/items + toast. Buy now -> thêm rồi chuyển /checkout.
- Rating/review lấy từ mocks (bọc MockBadge nhỏ khi ở dev).
Viết test: chọn SKU đổi giá, SKU hết hàng không chọn được, guest bấm Add to cart bị chuyển login.
Chạy typecheck/lint/test/build.
```

## Bước 7 – Cart (board Cart)
```text
Theo docs/tiptopshop-plan.md, Bước 7. Đưa plan trước, chờ "go".
Trang /cart giống board Cart:
- Tiêu đề "Cart (n)", pill "My orders" + avatar.
- "Select all", nhóm theo shop, từng dòng: checkbox, ảnh, tên, chip biến thể, giá + giá gạch, stepper, nút xoá.
- Dòng available:false: mờ, nhãn "No longer available", chỉ có Remove.
- Đổi số lượng: PUT cart/items (quantity 0 = xoá). Optimistic + rollback khi lỗi.
- Cột phải sticky "Order summary": Items, "Shipping · vouchers · tax: At checkout", Total đỏ, nút "Check out (n)" -> /checkout với các dòng được chọn.
- Giỏ trống: empty state + nút "Continue shopping".
Viết test cho stepper và chọn dòng.
Chạy typecheck/lint/test/build.
```

## Bước 8 – Checkout + thanh toán giả (board Checkout)
```text
Theo docs/tiptopshop-plan.md, Bước 8. Đưa plan trước, chờ "go".
Trang /checkout giống board Checkout:
- Card địa chỉ (địa chỉ mặc định của account); nút Change mở Dialog nhập name/phone/addressLine/district/city theo schema checkout trong docs/openapi.json.
- Bảng item theo shop, ô "Message to seller" (max 500), khung Shipping "Simulator Express".
- Ô Voucher -> gửi couponCode.
- Cột phải sticky "Payment details": Product total, Seller discount, Platform discount, Shipping fee, Tax, Total; badge "Simulated payment"; nút "Place order".
- Place order: POST checkout (kèm idempotency key nếu API yêu cầu) -> hiện trạng thái "Order placed · UNPAID" với số tiền thật từ order.amounts -> nút "Pay now (simulated)" gọi POST orders/{id}/pay -> toast + chuyển /account/orders.
- Lỗi voucher/hết hàng: hiện message từ ApiError ngay dưới ô liên quan.
Viết test luồng place -> pay (mock fetch).
Chạy typecheck/lint/test/build.
```

## Bước 9 – My orders + tracking + huỷ/trả hàng (board Orders)
```text
Theo docs/tiptopshop-plan.md, Bước 9. Đưa plan trước, chờ "go".
Trang /account/orders giống board Orders:
- Tabs pill: All / To pay / To ship / Shipping / Delivered / Cancelled (+ số lượng), map sang status backend.
- Card đơn: shop, mã đơn (mono), badge trạng thái màu theo board, item, Total, dòng gợi ý và nút hành động:
  UNPAID: Cancel + Pay now; AWAITING_SHIPMENT: Cancel (aftersale/cancellations); đang giao: Track; DELIVERED: Request return.
- Panel phải sticky "Tracking": carrier, tracking no., package status, timeline từ GET orders/{id}/fulfillment.
- Dialog "Request return": Type, Reason, chọn item + số lượng -> POST aftersale/returns.
- Đọc logic từ src/features/orders.buyer.tsx, fulfillment.buyer.tsx, aftersale.buyer.tsx để dùng lại, không đoán API.
Viết test cho map tab->status và nút theo trạng thái.
Chạy typecheck/lint/test/build.
```

## Bước 10 – Seller Center home (board SellerHome)
```text
Theo docs/tiptopshop-plan.md, Bước 10. Đưa plan trước, chờ "go".
Trang /seller-center giống board SellerHome:
- "Good afternoon, <seller name>".
- To-do list 5 ô (To pay, To ship, In transit, Returns, Unread messages) đếm từ orders/aftersale/chat thật; bấm vào -> trang tương ứng có filter.
- "Business overview" là MOCK (bọc MockBadge, số + sparkline từ src/mocks).
- Card Shop: tên, region, status, số products, active vouchers, low stock SKUs.
- "Latest orders" 5 đơn mới nhất, link "View all".
Chạy typecheck/lint/test/build.
```

## Bước 11 – Seller quản lý đơn + chi tiết (board SellerOrders, SellerOrderDetail)
```text
Theo docs/tiptopshop-plan.md, Bước 11. Đưa plan trước, chờ "go".
1. /seller-center/orders giống board SellerOrders: tabs gạch chân teal (All, Unpaid, To ship, Shipped, Completed, Cancelled + số), ô lọc Order ID / Buyer name, bảng shadcn Table: Product | Total | Status | Package | Actions. Hành động theo trạng thái: Arrange shipment (arrange-shipment), Print label (shipping-label, mở file), Simulate carrier (advance-shipment), Cancel order.
2. /seller-center/orders/:id giống board SellerOrderDetail: thanh 5 bước (Placed, Paid, Shipment arranged, In transit, Delivered), bảng Items + amounts, Status history (time, from -> to, actor, source), Recipient + buyer message, Package (id, status, carrier, tracking), Payment.
3. Dùng lại logic từ src/features/orders.seller.tsx và fulfillment.seller.tsx.
Viết test cho nút hành động theo trạng thái.
Chạy typecheck/lint/test/build.
```

## Bước 12 – Các trang seller còn lại
```text
Theo docs/tiptopshop-plan.md, Bước 12. Đưa plan trước, chờ "go".
Chuyển các tab seller cũ sang SellerLayout mới, style Tailwind/shadcn giống phong cách board SellerOrders (card trắng bo 12px trên nền #F4F4F5, nút teal):
- /seller-center/returns  <- aftersale.seller.tsx
- /seller-center/products <- SellerCatalog.tsx + inventory.seller.tsx
- /seller-center/vouchers <- coupons.seller.tsx
- /seller-center/messages <- chat.seller.tsx (2 cột: danh sách hội thoại | khung chat)
Giữ nguyên logic gọi API, chỉ thay UI. Liệt kê cho tôi các file sẽ chuyển trước khi làm.
Chạy typecheck/lint/test/build.
```

## Bước 13 – Dọn dẹp + cập nhật test/e2e
```text
Theo docs/tiptopshop-plan.md, Bước 13. Đưa plan trước, chờ "go".
1. Xoá route/trang cũ /buyer/* và /seller/* (trừ /seller/authorize), xoá component/feature không còn dùng, xoá CSS cũ không còn dùng. /console giữ nguyên chức năng.
2. Cập nhật unit test trong src/__tests__ theo UI mới.
3. Cập nhật e2e/tests/*.spec.ts và e2e/tests/helpers.ts cho route và nhãn mới (ví dụ signInAs dùng trang /login mới). Liệt kê selector cũ -> mới trước khi sửa.
4. Cập nhật README phần Frontend: route mới, thư mục src/mocks và cách xoá mock.
Chạy typecheck/lint/test/build; nếu tôi bật backend local thì chạy e2e.
Không push. Tóm tắt thay đổi để tôi tự commit/PR.
```

---

## Mẹo khi làm với Claude Code
- Nếu nó code mà chưa đưa plan: gõ `Stop. Plan first.`.
- Muốn sửa nhỏ giao diện: chụp màn hình + nói "giống board X hơn ở chỗ Y".
- Mỗi bước xong: `git add -A && git commit -m "step N: ..."` để dễ quay lại.
- Push cần cài Claude GitHub App cho repo (nếu muốn Claude tạo PR), hoặc tự push bằng git.
