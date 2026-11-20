import { defineConfig } from '@playwright/test';

/**
 * Runs against a RUNNING stack (docker compose up) - never against production. UI: E2E_UI_URL (default http://localhost:3090),
 * test-admin calls go through the UI proxy (nginx injects the admin token), so no secret lives in the tests.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { baseURL: process.env.E2E_UI_URL ?? 'http://localhost:3090', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
