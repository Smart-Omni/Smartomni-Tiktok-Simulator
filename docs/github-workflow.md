# Quy trình làm việc với GitHub

`develop` là nhánh tích hợp hằng ngày. `main` chỉ nhận những thay đổi đã sẵn sàng phát hành. Mỗi công việc bắt đầu từ `develop` trên một nhánh riêng:

```text
feature/* hoặc fix/* → Pull Request vào develop → Pull Request phát hành vào main
```

Đặt tên nhánh `feature/<phan-he>-<mo-ta-ngan>` hoặc `fix/<phan-he>-<mo-ta-ngan>`, dùng chữ thường và dấu gạch nối. Ví dụ: `feature/order-webhook-idempotency`, `fix/frontend-checkout-total`. Chọn phần hệ phù hợp như `backend`, `frontend`, `order`, `catalog`, hoặc `repo`.

## 1. Tạo nhánh công việc

Hoàn tất hoặc lưu các thay đổi đang làm trước khi chuyển nhánh. Từ thư mục gốc repository, chạy trong PowerShell:

```powershell
git fetch origin
git switch develop
git pull --ff-only origin develop
git switch -c feature/order-webhook-idempotency
```

Nếu vừa clone và chưa có nhánh `develop` cục bộ, thay `git switch develop` bằng `git switch --track origin/develop`. Đổi tên nhánh ví dụ theo công việc thực tế.

## 2. Sửa code, kiểm tra và đẩy nhánh

Giữ mỗi PR tập trung vào một công việc. Cập nhật test và tài liệu liên quan. Thay đổi Prisma schema phải có migration mới trong `backend/prisma/migrations/`; không sửa migration đã áp dụng. Khi thay đổi route, cập nhật định nghĩa OpenAPI và `backend/test/openapi.e2e-spec.ts`; xuất lại `docs/openapi.json` nếu cần bằng `cd backend; npm run build; npm run openapi:export`.

Chạy các quality gate cho phần bị ảnh hưởng; trước PR có thay đổi code, chạy đủ hai package:

```powershell
Push-Location backend
npm ci
npm run typecheck
npm run lint
npm run build
npm test
Pop-Location

Push-Location frontend
npm ci
npm run typecheck
npm run lint
npm test
npm run build
Pop-Location
```

`backend` dùng Jest và PostgreSQL tạm khi `npm test`; `frontend` dùng Vitest. Nếu thay đổi luồng người dùng cần kiểm tra trình duyệt, chạy thêm `cd e2e; npm ci; npm test` với stack đang chạy theo hướng dẫn test e2e. Không dùng `mvn -B clean verify` vì repo này không phải dự án Maven.

Xem lại trạng thái và diff trước khi commit. Chỉ stage file thuộc công việc, tránh `.env`, secret, dữ liệu test và thay đổi của người khác. Commit theo Conventional Commits, ví dụ `feat(order): add webhook idempotency` hoặc `fix(frontend): correct checkout total`.

```powershell
git status --short --branch
git diff
git add backend/src/... backend/test/...
git diff --cached --check
git diff --cached --stat
git commit -m "feat(order): add webhook idempotency"
git push -u origin feature/order-webhook-idempotency
```

Thay các đường dẫn `...` bằng file thực tế. Trước khi tạo PR, cập nhật nhánh với `develop` mới nhất và giải quyết xung đột nếu có.

## 3. Mở và review Pull Request

Trên GitHub, chọn **base `develop`** và **compare là nhánh công việc**. Mô tả mục tiêu, thay đổi chính, kết quả kiểm thử, ảnh hưởng tới API và migration, issue hoặc phase liên quan. Với UI, thêm ảnh chụp; với API, thêm ví dụ request/response. Dùng checklist trong [CONTRIBUTING.md](../CONTRIBUTING.md).

Yêu cầu ít nhất một thành viên khác review và approval, xử lý góp ý, rồi chỉ merge khi các kiểm tra bắt buộc đạt. Hiện repository chưa có GitHub Actions; quality gate ở trên phải được chạy và ghi kết quả trong PR cho đến khi CI được cấu hình. Không tự ghi “CI đạt” nếu chưa có check chạy thực tế.

Khi chuẩn bị phát hành, mở PR **`develop` → `main`**. Xem lại toàn bộ diff từ lần phát hành trước, kết quả kiểm thử, thay đổi API/schema và cấu hình triển khai. Cần review và các kiểm tra bắt buộc đạt trước khi merge. Sau khi phát hành, tiếp tục tạo nhánh công việc từ `develop` mới nhất.

## Gợi ý cấu hình bảo vệ nhánh

Trong **Settings → Branches** hoặc rulesets của GitHub, áp dụng cho cả `develop` và `main`: yêu cầu PR, ít nhất một approval từ người khác, xử lý review còn mở, và chặn force push/xóa nhánh. Khi đã có GitHub Actions, thêm các job backend/frontend vào required status checks. Chỉ bật yêu cầu status check sau khi workflow thực sự chạy ổn định trên PR vào cả hai nhánh.

Nếu Render/Vercel đang triển khai từ `main`, kiểm tra tác động trước khi đổi nhánh triển khai. Branch protection là cấu hình repository trên GitHub, không được tạo chỉ bằng tài liệu này.
