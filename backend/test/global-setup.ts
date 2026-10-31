import { execSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Integration/e2e tests need a real PostgreSQL (FOR UPDATE SKIP LOCKED cannot be faked).
 * Use TEST_DATABASE_URL if provided; otherwise boot a throw-away embedded PostgreSQL 16 (devDependency).
 * The database name must contain "simulator" (reset safety rail).
 */
export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const EmbeddedPostgres = require('embedded-postgres').default;
    const dir = mkdtempSync(join(tmpdir(), 'sim-pg-'));
    const port = Number(process.env.TEST_PG_PORT ?? 55432);
    const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'sim', password: 'sim-test-pw', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => undefined, onError: () => undefined });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('tiktok_simulator_test');
    (globalThis as any).__SIM_PG__ = pg;
    url = `postgresql://sim:sim-test-pw@localhost:${port}/tiktok_simulator_test`;
  }
  process.env.TEST_DATABASE_URL = url;
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
}
