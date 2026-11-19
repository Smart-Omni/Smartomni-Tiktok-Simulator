import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PersistentBusinessClock } from '../src/clock/clock';
import { configureApp } from '../src/configure-app';
import { SeedService } from '../src/seed/seed.service';
import { WebhookTransport, WorkerTime } from '../src/webhooks/webhook-worker.service';

export const ADMIN_TOKEN = 'test-admin-token-1234';

export function prepareEnv(extra: Record<string, string> = {}): void {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
  process.env.TEST_ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.WEBHOOK_WORKER_ENABLED = 'false';
  process.env.SEED_ON_START = 'false';
  process.env.MEDIA_DIR = './.tmp-test/media';
  process.env.PDF_DIR = './.tmp-test/pdf';
  Object.assign(process.env, extra);
}

export async function cleanDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE "WebhookAttempt","WebhookJob","FaultRule","DemoSession","HttpRequestLog","AuthorizationCode","Token","InventoryLevel","InventoryUpdateAttempt","Sku","Product","Warehouse","Buyer","Scenario","Shop","Seller","App","ClockState" RESTART IDENTITY CASCADE`,
  );
}

/** Schema that holds the seeded rows of the current run (dropped by global-setup at the start of every run). */
const SNAPSHOT = 'seed_snapshot';
const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const TX = { timeout: 120_000, maxWait: 30_000 };

/** Parents first, so that every INSERT ... SELECT finds the rows its foreign keys point to. */
function inForeignKeyOrder(tables: string[], edges: { child: string; parent: string }[]): string[] {
  const left = new Set(tables);
  const ordered: string[] = [];
  while (left.size) {
    const ready = [...left].filter((t) => edges.every((e) => e.child !== t || e.parent === t || !left.has(e.parent)));
    // a foreign-key cycle cannot be ordered: take what is left as it is
    const next = ready.length ? ready : [...left];
    for (const t of next) {
      ordered.push(t);
      left.delete(t);
    }
  }
  return ordered;
}

/**
 * Puts the database in the state `cleanDb` + `SeedService.seedAll()` leaves it in, without paying for the seed on every test.
 * The first call of a run seeds for real and copies every non-empty table to the `seed_snapshot` schema; later calls
 * empty the tables and copy the rows back (INSERT ... SELECT in foreign-key order), then move every serial/identity
 * sequence to the max of its column, as the seed would have left it.
 */
export async function resetToSeed(app: INestApplication, prisma: PrismaClient): Promise<void> {
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = '${SNAPSHOT}'`);
  if (n === 0) {
    await cleanDb(prisma);
    await app.get(SeedService).seedAll();
    await prisma.$transaction(async (tx) => {
      const tables = await tx.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`,
      );
      await tx.$executeRawUnsafe(`CREATE SCHEMA ${SNAPSHOT}`);
      for (const { table_name: t } of tables) {
        const [{ c }] = await tx.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int AS c FROM public.${ident(t)}`);
        if (c > 0) await tx.$executeRawUnsafe(`CREATE TABLE ${SNAPSHOT}.${ident(t)} AS TABLE public.${ident(t)}`);
      }
    }, TX);
    return;
  }
  await cleanDb(prisma);
  await prisma.$transaction(async (tx) => {
    const snap = (await tx.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${SNAPSHOT}'`)).map((r) => r.table_name);
    const edges = await tx.$queryRawUnsafe<{ child: string; parent: string }[]>(
      `SELECT cl.relname AS child, pl.relname AS parent FROM pg_constraint c
         JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace JOIN pg_class pl ON pl.oid = c.confrelid
        WHERE c.contype = 'f' AND n.nspname = 'public'`,
    );
    for (const t of inForeignKeyOrder(snap, edges)) {
      await tx.$executeRawUnsafe(`INSERT INTO public.${ident(t)} OVERRIDING SYSTEM VALUE SELECT * FROM ${SNAPSHOT}.${ident(t)}`);
    }
    const serials = await tx.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND (column_default LIKE 'nextval(%' OR is_identity = 'YES')`,
    );
    for (const { table_name: t, column_name: col } of serials) {
      const target = `public.${ident(t)}`;
      await tx.$queryRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('${target}', '${col}'), COALESCE((SELECT MAX(${ident(col)}) FROM ${target}), 1), (SELECT MAX(${ident(col)}) FROM ${target}) IS NOT NULL)`,
      );
    }
  }, TX);
}

export class FakeTime extends WorkerTime {
  constructor(public current: Date = new Date()) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class FakeTransport extends WebhookTransport {
  calls: { jobId: string; attemptNo: number }[] = [];
  responses: (number | Error)[] = [];
  defaultStatus = 200;
  gate: Promise<void> | null = null;
  async send(job: { id: string }, ctx: { attemptNo: number }) {
    this.calls.push({ jobId: job.id, attemptNo: ctx.attemptNo });
    if (this.gate) await this.gate;
    const next = this.responses.shift() ?? this.defaultStatus;
    if (next instanceof Error) throw next;
    return { httpStatus: next, body: next < 300 ? 'ok' : 'error' };
  }
}

export async function createApp(opts: { transport?: FakeTransport; time?: FakeTime; env?: Record<string, string>; beforeInit?: (app: INestApplication) => void } = {}): Promise<INestApplication> {
  prepareEnv(opts.env);
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.transport) builder = builder.overrideProvider(WebhookTransport).useValue(opts.transport);
  if (opts.time) builder = builder.overrideProvider(WorkerTime).useValue(opts.time);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
  configureApp(app);
  opts.beforeInit?.(app);
  await app.init();
  // Listen once: supertest otherwise binds a fresh ephemeral port per request, and concurrent requests race (read ECONNRESET).
  await app.listen(0, '127.0.0.1');
  // The business clock row lives in the shared test database: a suite that advanced it must not leak into the next suite's app.
  await app.get(PersistentBusinessClock).reset();
  return app;
}
