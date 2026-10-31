import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { WebhookJob } from '@prisma/client';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { APP_CONFIG, AppConfig } from '../config/config';
import { FaultService } from '../faults/fault.service';
import { ClaimedJob, QueueOptions, WebhookQueueService, AttemptOutcome } from './webhook-queue.service';

export interface TransportResult {
  httpStatus: number;
  body: string;
}

/** Delivery transport; replaced in tests. Signing of real TikTok webhooks is added in Phase 05. */
export abstract class WebhookTransport {
  abstract send(job: WebhookJob, ctx: { attemptNo: number; timeoutMs: number }): Promise<TransportResult>;
}

/** localhost / 127.0.0.1 / ::1 in a subscription address mean "the machine running SmartOmni", which from inside Docker is the host. */
export function resolveTargetUrl(address: string, rewriteLocalhost: boolean, hostCallbackBaseUrl: string): string {
  if (!rewriteLocalhost) return address;
  try {
    const url = new URL(address);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return address;
    const host = new URL(hostCallbackBaseUrl);
    url.hostname = host.hostname;
    return url.toString();
  } catch {
    return address;
  }
}

/** Webhook signature (SECONDARY source, see contracts/signing/README.md): `Authorization` = lowercase hex HMAC-SHA256(app_secret, app_key + raw body). */
export function webhookSignature(appSecret: string, appKey: string, rawBody: string): string {
  return createHmac('sha256', appSecret).update(appKey + rawBody).digest('hex');
}

@Injectable()
export class FetchWebhookTransport extends WebhookTransport {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    super();
  }

  async send(job: WebhookJob, ctx: { attemptNo: number; timeoutMs: number }): Promise<TransportResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      // The exact bytes sent are the bytes signed.
      const body = JSON.stringify(job.payload);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-simulator-webhook-id': job.id,
        'x-simulator-attempt': String(ctx.attemptNo),
        ...(job.requestId ? { 'x-request-id': job.requestId } : {}),
      };
      if (job.appId) {
        const app = await this.prisma.app.findUnique({ where: { id: job.appId } });
        if (app) headers.authorization = webhookSignature(app.appSecret, app.appKey, body);
      }
      const res = await fetch(resolveTargetUrl(job.targetUrl, this.config.webhook.rewriteLocalhost, this.config.hostCallbackBaseUrl), { method: 'POST', headers, body, signal: controller.signal });
      const text = await res.text();
      return { httpStatus: res.status, body: text.slice(0, 1000) };
    } finally {
      clearTimeout(timer);
    }
  }
}

export abstract class WorkerTime {
  abstract now(): Date;
}
@Injectable()
export class SystemWorkerTime extends WorkerTime {
  now(): Date {
    return new Date();
  }
}

@Injectable()
export class WebhookWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WebhookWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  readonly workerId: string;
  lastTickAt: Date | null = null;
  lastError: string | null = null;

  constructor(
    @Inject(WebhookQueueService) private readonly queue: WebhookQueueService,
    @Inject(FaultService) private readonly faults: FaultService,
    @Inject(WebhookTransport) private readonly transport: WebhookTransport,
    @Inject(WorkerTime) private readonly time: WorkerTime,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.workerId = queue.newWorkerId();
  }

  get queueOptions(): QueueOptions {
    const w = this.config.worker;
    return { leaseMs: w.leaseMs, baseBackoffMs: w.baseBackoffMs, maxBackoffMs: w.maxBackoffMs };
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  onApplicationBootstrap(): void {
    if (this.config.worker.enabled) this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.tick()
        .catch((e: Error) => {
          this.lastError = e.message;
          this.logger.warn(`tick failed: ${e.message}`);
        })
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(loop, this.config.worker.pollIntervalMs);
        });
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Claim a batch and deliver it. Returns the number of jobs processed. Safe to call from tests. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const now = this.time.now();
      const claimed = await this.queue.claim(this.workerId, now, this.config.worker.batchSize, this.queueOptions);
      this.lastTickAt = now;
      await Promise.all(claimed.map((c) => this.process(c)));
      return claimed.length;
    } finally {
      this.running = false;
    }
  }

  async process(claimed: ClaimedJob): Promise<void> {
    const started = Date.now();
    let outcome: AttemptOutcome;
    try {
      outcome = await this.deliver(claimed);
    } catch (e) {
      outcome = { ok: false, error: (e as Error).message, durationMs: Date.now() - started };
    }
    outcome.durationMs ??= Date.now() - started;
    try {
      const applied = await this.queue.complete(claimed, outcome, this.time.now(), this.queueOptions);
      if (!applied) this.logger.warn(`job ${claimed.job.id} attempt ${claimed.attemptNo} finished after losing its lease`);
    } catch (e) {
      this.logger.warn(`could not record result for job ${claimed.job.id}: ${(e as Error).message}`);
    }
  }

  private async deliver(claimed: ClaimedJob): Promise<AttemptOutcome> {
    const { job } = claimed;
    const fault = await this.faults.consume('WEBHOOK', job.shopId, job.topic);
    const timeoutMs = this.config.worker.requestTimeoutMs;
    if (fault?.kind === 'DROP') return { ok: false, terminal: true, error: 'dropped by fault injection', deliveries: 0 };
    if (fault?.kind === 'HTTP_ERROR') {
      const status = Number((fault.params as any)?.status ?? 500);
      return { ok: false, httpStatus: status, error: `simulated receiver error ${status} (fault injection)`, deliveries: 0 };
    }
    if (fault?.kind === 'DELAY') {
      const delay = Math.min(Number((fault.params as any)?.delayMs ?? 1000), 30000);
      await new Promise((r) => setTimeout(r, delay));
    }
    const first = await this.transport.send(job, { attemptNo: claimed.attemptNo, timeoutMs });
    let deliveries = 1;
    let last = first;
    if (fault?.kind === 'DUPLICATE') {
      deliveries = 2;
      last = await this.transport.send(job, { attemptNo: claimed.attemptNo, timeoutMs });
    }
    const ok = last.httpStatus >= 200 && last.httpStatus < 300;
    return { ok, httpStatus: last.httpStatus, responseExcerpt: last.body, deliveries, error: ok ? null : `receiver returned HTTP ${last.httpStatus}` };
  }
}
