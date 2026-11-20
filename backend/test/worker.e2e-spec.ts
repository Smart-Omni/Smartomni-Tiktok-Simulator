import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { FaultService } from '../src/faults/fault.service';
import { WebhookQueueService } from '../src/webhooks/webhook-queue.service';
import { WebhookWorkerService } from '../src/webhooks/webhook-worker.service';
import { createApp, FakeTime, FakeTransport, resetToSeed } from './helpers';

const OPTS = { leaseMs: 30_000, baseBackoffMs: 1_000, maxBackoffMs: 60_000 };

describe('durable webhook worker', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: WebhookQueueService;
  let worker: WebhookWorkerService;
  let transport: FakeTransport;
  let time: FakeTime;
  let shopId: string;

  beforeAll(async () => {
    transport = new FakeTransport();
    time = new FakeTime(new Date('2026-10-14T00:00:00Z'));
    app = await createApp({ transport, time, env: { WEBHOOK_LEASE_MS: '30000', WEBHOOK_BASE_BACKOFF_MS: '1000', WEBHOOK_MAX_BACKOFF_MS: '60000' } });
    prisma = app.get(PrismaService);
    queue = app.get(WebhookQueueService);
    worker = app.get(WebhookWorkerService);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetToSeed(app, prisma);
    shopId = (await prisma.shop.findFirstOrThrow()).id;
    transport.calls = [];
    transport.responses = [];
    transport.defaultStatus = 200;
    transport.gate = null;
    // jobs default nextAttemptAt to the DB clock, so the fake worker time starts just after real now
    time.current = new Date(Date.now() + 5_000);
  });

  const enqueue = (n = 1, maxAttempts = 3) =>
    Promise.all(Array.from({ length: n }, (_, i) => queue.enqueue({ shopId, topic: 'TEST', payload: { i }, targetUrl: 'http://receiver.local/hook', maxAttempts })));

  it('claims atomically: two concurrent claimers never receive the same job', async () => {
    const jobs = await enqueue(30);
    const [a, b, c] = await Promise.all([
      queue.claim('w-a', time.now(), 12, OPTS),
      queue.claim('w-b', time.now(), 12, OPTS),
      queue.claim('w-c', time.now(), 12, OPTS),
    ]);
    const ids = [...a, ...b, ...c].map((x) => x.job.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids.length).toBe(30); // nothing lost (12+12+6)
    expect(new Set(jobs.map((j) => j.id))).toEqual(new Set(ids));
    // every claim wrote its attempt row before any send happened
    expect(await prisma.webhookAttempt.count({ where: { status: 'STARTED' } })).toBe(30);
    expect(transport.calls.length).toBe(0);
  });

  it('delivers, records attempt result and marks the job SUCCEEDED', async () => {
    const [job] = await enqueue();
    expect(await worker.tick()).toBe(1);
    const row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.deliveredAt).not.toBeNull();
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({ status: 'SUCCEEDED', httpStatus: 200, attemptNo: 1, possibleDuplicate: false, lateCompletion: false });
    expect(row.leaseToken).toBeNull();
  });

  it('retries with exponential backoff, keeps history, and ends DEAD after maxAttempts', async () => {
    const [job] = await enqueue(1, 3);
    transport.defaultStatus = 500;

    await worker.tick(); // attempt 1 fails -> retry in 1s
    let row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('PENDING');
    expect(row.nextAttemptAt.getTime() - time.now().getTime()).toBe(1000);

    expect(await worker.tick()).toBe(0); // not due yet
    time.advance(1000);
    await worker.tick(); // attempt 2 fails -> retry in 2s
    row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.nextAttemptAt.getTime() - time.now().getTime()).toBe(2000);

    time.advance(2000);
    await worker.tick(); // attempt 3 fails -> DEAD
    row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('DEAD');
    expect(row.lastError).toMatch(/500/);

    const attempts = await prisma.webhookAttempt.findMany({ where: { jobId: job.id }, orderBy: { attemptNo: 'asc' } });
    expect(attempts.map((a) => [a.attemptNo, a.status, a.httpStatus])).toEqual([[1, 'FAILED', 500], [2, 'FAILED', 500], [3, 'FAILED', 500]]);

    // replay creates a fresh job linked to the original
    const replay = await queue.replay(job.id);
    expect(replay.replayOfId).toBe(job.id);
    expect(replay.status).toBe('PENDING');
  });

  it('recovers after a transport exception and then succeeds', async () => {
    const [job] = await enqueue();
    transport.responses = [new Error('ECONNREFUSED'), 200];
    await worker.tick();
    expect((await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING');
    time.advance(1000);
    await worker.tick();
    const row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attempts[0].error).toMatch(/ECONNREFUSED/);
  });

  it('a worker crash mid-flight leaves a STARTED attempt; after lease expiry another worker reclaims and flags a possible duplicate', async () => {
    const [job] = await enqueue();
    // worker A claims (attempt row STARTED) and then "crashes": it never calls complete().
    const [crashed] = await queue.claim('worker-crashed', time.now(), 1, OPTS);
    expect(crashed.job.id).toBe(job.id);

    // lease still valid -> nobody else can take it
    expect(await worker.tick()).toBe(0);

    time.advance(30_001); // lease expired; a new worker instance (restart) picks it up
    expect(await worker.tick()).toBe(1);

    const row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: { orderBy: { attemptNo: 'asc' } } } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.attempts).toHaveLength(2);
    expect(row.attempts[0]).toMatchObject({ attemptNo: 1, status: 'LEASE_EXPIRED', workerId: 'worker-crashed' });
    expect(row.attempts[1]).toMatchObject({ attemptNo: 2, status: 'SUCCEEDED', possibleDuplicate: true });
  });

  it('a late worker that lost its lease cannot overwrite the job; its result is recorded as late completion', async () => {
    const [job] = await enqueue();
    const [slow] = await queue.claim('worker-slow', time.now(), 1, OPTS);
    time.advance(30_001);
    const [fast] = await queue.claim('worker-fast', time.now(), 1, OPTS);
    expect(fast.job.id).toBe(job.id);

    // slow worker eventually reports a failure: must be fenced out
    const applied = await queue.complete(slow, { ok: false, httpStatus: 503, error: 'timeout' }, time.now(), OPTS);
    expect(applied).toBe(false);
    let row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.leaseOwner).toBe('worker-fast');

    const okApplied = await queue.complete(fast, { ok: true, httpStatus: 200 }, time.now(), OPTS);
    expect(okApplied).toBe(true);
    row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('SUCCEEDED');
    const attempts = await prisma.webhookAttempt.findMany({ where: { jobId: job.id }, orderBy: { attemptNo: 'asc' } });
    expect(attempts[0]).toMatchObject({ workerId: 'worker-slow', lateCompletion: true });
    expect(attempts[1]).toMatchObject({ workerId: 'worker-fast', possibleDuplicate: true, lateCompletion: false });
  });

  it('retires a job whose lease expired on its final attempt instead of re-sending forever', async () => {
    const [job] = await enqueue(1, 1);
    await queue.claim('worker-crashed', time.now(), 1, OPTS);
    time.advance(30_001);
    expect(await worker.tick()).toBe(0);
    const row = await prisma.webhookJob.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
    expect(row.status).toBe('DEAD');
    expect(row.attempts[0].status).toBe('LEASE_EXPIRED');
    expect(transport.calls).toHaveLength(0);
  });

  it('two worker ticks in parallel deliver each job exactly once', async () => {
    await enqueue(10);
    const w2 = new WebhookWorkerService(queue, app.get(FaultService), transport, time, (app.get(WebhookWorkerService) as any).config);
    const [a, b] = await Promise.all([worker.tick(), w2.tick()]);
    expect(a + b).toBe(10);
    expect(transport.calls).toHaveLength(10);
    expect(new Set(transport.calls.map((c) => c.jobId)).size).toBe(10);
    expect(await prisma.webhookJob.count({ where: { status: 'SUCCEEDED' } })).toBe(10);
  });

  it('records an injected duplicate delivery on the attempt', async () => {
    const [job] = await enqueue();
    await app.get(FaultService).create({ shopId, target: 'WEBHOOK', kind: 'DUPLICATE', pathMatch: 'TEST', remaining: 1 });
    await worker.tick();
    const attempt = await prisma.webhookAttempt.findFirstOrThrow({ where: { jobId: job.id } });
    expect(attempt.deliveries).toBe(2);
    expect(transport.calls).toHaveLength(2);
    // counted rule is consumed
    const [job2] = await enqueue();
    await worker.tick();
    expect((await prisma.webhookAttempt.findFirstOrThrow({ where: { jobId: job2.id } })).deliveries).toBe(1);
  });

  it('DROP fault ends the job without delivery and HTTP_ERROR fault drives retry', async () => {
    const [dropped] = await enqueue();
    await app.get(FaultService).create({ shopId, target: 'WEBHOOK', kind: 'DROP', remaining: 1 });
    await worker.tick();
    const d = await prisma.webhookJob.findUniqueOrThrow({ where: { id: dropped.id } });
    expect(d.status).toBe('DEAD');
    expect(transport.calls).toHaveLength(0);

    const [flaky] = await enqueue();
    await app.get(FaultService).create({ shopId, target: 'WEBHOOK', kind: 'HTTP_ERROR', params: { status: 503 }, remaining: 1 });
    await worker.tick();
    expect((await prisma.webhookJob.findUniqueOrThrow({ where: { id: flaky.id } })).status).toBe('PENDING');
    time.advance(1000);
    await worker.tick();
    expect((await prisma.webhookJob.findUniqueOrThrow({ where: { id: flaky.id } })).status).toBe('SUCCEEDED');
  });
});
