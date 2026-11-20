import { request } from '@playwright/test';

/**
 * Waits until the stack answers before any test runs: the API's /health/ready (DB reachable, seed done) and the UI root.
 * `docker compose up -d` returns before the API is ready, so without this the first test of a fresh stack can fail.
 * Override the wait with E2E_READY_TIMEOUT_MS (default 180 s).
 */
export default async function globalSetup(): Promise<void> {
  const apiUrl = process.env.E2E_API_URL ?? 'http://localhost:8090';
  const uiUrl = process.env.E2E_UI_URL ?? 'http://localhost:3090';
  const deadline = Date.now() + Number(process.env.E2E_READY_TIMEOUT_MS ?? 180_000);
  const ctx = await request.newContext();
  const up = async (url: string) => {
    try {
      return (await ctx.get(url, { timeout: 3000 })).ok();
    } catch {
      return false;
    }
  };
  try {
    for (const url of [`${apiUrl}/health/ready`, uiUrl]) {
      while (!(await up(url))) {
        if (Date.now() > deadline) throw new Error(`e2e: ${url} is not ready; start the stack with "docker compose up --build -d" first`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    await ctx.dispose();
  }
}
