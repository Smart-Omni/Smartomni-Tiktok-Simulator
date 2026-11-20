# Repository Guidelines

## Project Structure & Module Organization

`backend/` contains the NestJS API, Prisma schema and migrations (`backend/prisma/`), and Jest tests (`backend/test/`). `frontend/` contains the React/Vite demo UI and Vitest tests in `frontend/src/__tests__/`. `contracts/` records simulated TikTok API contracts; `docs/` holds integration notes and the exported OpenAPI spec. `spec/` tracks implementation phases. The root `docker-compose.yml` starts the local database, API, and UI.

## Build, Test, and Development Commands

- `docker compose up --build -d`: build and run the complete local stack; `docker compose ps` shows health.
- `cd backend && npm ci && npm run build && npm start`: install, compile, and start the API. Set `DATABASE_URL` and `TEST_ADMIN_TOKEN` first; see `README.md`.
- `cd frontend && npm ci && npm run dev`: run the UI locally on port 3090.
- In each package, run `npm run typecheck`, `npm run lint`, and `npm test` before a PR. Run `npm run build` to check production output.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation and the existing ESLint configuration in each package. Keep backend feature code under `backend/src/` and match nearby NestJS module, service, and controller naming. React components use PascalCase files; feature panels follow `frontend/src/features/<feature>.<buyer|seller|console>.tsx`. Add Prisma schema changes through new migrations rather than editing applied migrations.

## Testing Guidelines

Backend tests use Jest; integration tests are named `*.e2e-spec.ts`, while focused tests use `*.spec.ts`. `npm test` starts disposable embedded PostgreSQL unless `TEST_DATABASE_URL` is set. Frontend tests use Vitest and `*.test.tsx`. Update `backend/test/openapi.e2e-spec.ts` and the OpenAPI definition when routes change. Keep the full typecheck, lint, build, and test gates passing; no numeric coverage threshold is documented.

## Commit & Pull Request Guidelines

Recent commits use short subject lines with a scope or phase prefix, such as `docs(api): ...` or `phase-10: ...`. Describe behavior, affected APIs, migrations, and test results in PRs. Link the related issue or phase; include screenshots for UI changes and example requests/responses for API changes. Do not commit populated `.env` files, secrets, or test data.

After completing work that changes files in this Git repository, review and commit only the changes you made for that work. Stage only files related to the task; exclude pre-existing user changes and unrelated files. Use a short commit message describing the result, and include the commit hash in the final response. If a commit cannot be made, explain why.
