# Đóng góp cho SmartOmni TikTok Shop Simulator

Xem [quy trình GitHub](docs/github-workflow.md) để tạo nhánh, mở Pull Request và phát hành. Công việc mới bắt đầu từ `develop`; đặt tên nhánh `feature/<phan-he>-<mo-ta-ngan>` hoặc `fix/<phan-he>-<mo-ta-ngan>`. PR công việc vào `develop`, PR phát hành từ `develop` vào `main`.

## Commit

Dùng Conventional Commits với tiêu đề ngắn, ví dụ `feat(order): add webhook idempotency`, `fix(frontend): correct checkout total`, `docs(repo): describe GitHub workflow`. Scope nên phản ánh phần hệ thay đổi. Một commit nên chứa một thay đổi hoàn chỉnh, dễ review. Xem `git status` và `git diff --cached` trước khi commit; không đưa `.env`, secret hoặc dữ liệu test vào Git.

## Checklist Pull Request

- [ ] Base và compare đúng: nhánh công việc → `develop`, hoặc `develop` → `main` khi phát hành.
- [ ] Mục tiêu, thay đổi chính, issue/phase liên quan và cách kiểm tra được ghi trong mô tả.
- [ ] `backend`: typecheck, lint, build, test đạt nếu có code liên quan.
- [ ] `frontend`: typecheck, lint, test, build đạt nếu có code liên quan.
- [ ] Test và tài liệu liên quan được cập nhật; API mới/sửa có OpenAPI và ví dụ request/response.
- [ ] Prisma schema change có migration mới; không sửa migration đã áp dụng.
- [ ] Thay đổi UI có ảnh chụp hoặc mô tả cách kiểm tra trực quan.
- [ ] Diff không chứa secret, `.env`, dữ liệu test hoặc thay đổi không thuộc PR.
- [ ] Có approval của ít nhất một thành viên khác; mọi góp ý và kiểm tra bắt buộc đã được xử lý trước khi merge.
