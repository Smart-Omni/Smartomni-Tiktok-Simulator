import { Inject, Injectable } from '@nestjs/common';
import { Prisma, WebhookJob } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { redactString } from '../common/redaction';

export interface EnqueueInput {
  shopId: string;
  /** App whose secret signs the delivery. Null/omitted = unsigned (ad-hoc /test-admin/webhooks jobs). */
  appId?: string | null;
  topic: string;
  payload: Prisma.InputJsonValue;
  targetUrl: string;
  requestId?: string | null;
  maxAttempts?: number;
  replayOfId?: string | null;
}

export interface ClaimedJob {
  job: WebhookJob;
  attemptId: string;
  attemptNo: number;
  leaseToken: string;
  /** True when a previous attempt was abandoned mid-flight, so the receiver may see this event twice. */
  possibleDuplicate: boolean;
}

export interface AttemptOutcome {
  ok: boolean;
  httpStatus?: number | null;
  error?: string | null;
  responseExcerpt?: string | null;
  durationMs?: number;
  deliveries?: number;
  /** Do not retry (e.g. event dropped by fault injection). */
  terminal?: boolean;
}

export interface QueueOptions {
  leaseMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export function backoffMs(attemptNo: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** Math.max(0, attemptNo - 1));
}

type ClaimRow = { id: string; prevStatus: string; leaseToken: string };

/**
 * Durable queue on PostgreSQL. All state transitions are single SQL statements or short transactions:
 * - claim: UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED) so two workers never claim the same row;
 * - lease: claimed rows carry leaseExpiresAt; expired leases are reclaimable (worker crash/restart);
 * - fencing: completion only mutates the job when its leaseToken still matches.
 * Scheduling uses the supplied `now` (real system time), never the business clock.
 */
@Injectable()
export class WebhookQueueService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async enqueue(input: EnqueueInput): Promise<WebhookJob> {
    return this.prisma.webhookJob.create({
      data: {
        shopId: input.shopId,
        appId: input.appId ?? null,
        topic: input.topic,
        payload: input.payload,
        targetUrl: input.targetUrl,
        requestId: input.requestId ?? null,
        maxAttempts: input.maxAttempts ?? 5,
        replayOfId: input.replayOfId ?? null,
      },
    });
  }

  async replay(jobId: string, requestId?: string): Promise<WebhookJob> {
    const original = await this.prisma.webhookJob.findUniqueOrThrow({ where: { id: jobId } });
    return this.enqueue({
      shopId: original.shopId,
      appId: original.appId, // a replay of a signed event must be signed too
      topic: original.topic,
      payload: original.payload as Prisma.InputJsonValue,
      targetUrl: original.targetUrl,
      requestId: requestId ?? original.requestId,
      maxAttempts: original.maxAttempts,
      replayOfId: original.id,
    });
  }

  async claim(workerId: string, now: Date, limit: number, opts: QueueOptions): Promise<ClaimedJob[]> {
    // Timestamps are bound as ISO strings and converted to UTC `timestamp` explicitly so the comparison
    // does not depend on the PostgreSQL session time zone (Prisma stores DateTime as UTC timestamp(3)).
    const nowTs = now.toISOString();
    const leaseTs = new Date(now.getTime() + opts.leaseMs).toISOString();
    return this.prisma.$transaction(async (tx) => {
      // Jobs whose lease expired on their final attempt are retired instead of re-sent forever.
      const exhausted = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "WebhookJob"
        SET status = 'DEAD', "leaseOwner" = NULL, "leaseToken" = NULL, "leaseExpiresAt" = NULL,
            "lastError" = 'lease expired on final attempt', "updatedAt" = (${nowTs}::timestamptz AT TIME ZONE 'UTC')
        WHERE id IN (
          SELECT id FROM "WebhookJob"
          WHERE status = 'IN_PROGRESS' AND "leaseExpiresAt" <= (${nowTs}::timestamptz AT TIME ZONE 'UTC') AND "attemptCount" >= "maxAttempts"
          FOR UPDATE SKIP LOCKED)
        RETURNING id`;
      if (exhausted.length > 0) {
        await tx.webhookAttempt.updateMany({
          where: { jobId: { in: exhausted.map((r) => r.id) }, status: 'STARTED' },
          data: { status: 'LEASE_EXPIRED', finishedAt: now },
        });
      }

      const rows = await tx.$queryRaw<ClaimRow[]>`
        WITH picked AS (
          SELECT id, status::text AS "prevStatus"
          FROM "WebhookJob"
          WHERE (status = 'PENDING' AND "nextAttemptAt" <= (${nowTs}::timestamptz AT TIME ZONE 'UTC'))
             OR (status = 'IN_PROGRESS' AND "leaseExpiresAt" <= (${nowTs}::timestamptz AT TIME ZONE 'UTC') AND "attemptCount" < "maxAttempts")
          ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED)
        UPDATE "WebhookJob" j
        SET status = 'IN_PROGRESS',
            "leaseOwner" = ${workerId},
            "leaseToken" = gen_random_uuid()::text,
            "leaseExpiresAt" = (${leaseTs}::timestamptz AT TIME ZONE 'UTC'),
            "attemptCount" = j."attemptCount" + 1,
            "updatedAt" = (${nowTs}::timestamptz AT TIME ZONE 'UTC')
        FROM picked
        WHERE j.id = picked.id
        RETURNING j.id AS id, picked."prevStatus" AS "prevStatus", j."leaseToken" AS "leaseToken"`;

      const claimed: ClaimedJob[] = [];
      for (const row of rows) {
        const job = await tx.webhookJob.findUniqueOrThrow({ where: { id: row.id } });
        // Any attempt still STARTED belongs to a worker that lost its lease; the receiver may have got it.
        const abandoned = await tx.webhookAttempt.updateMany({
          where: { jobId: job.id, status: 'STARTED' },
          data: { status: 'LEASE_EXPIRED', finishedAt: now },
        });
        const possibleDuplicate = abandoned.count > 0;
        const attempt = await tx.webhookAttempt.create({
          data: {
            jobId: job.id,
            attemptNo: job.attemptCount,
            workerId,
            leaseToken: row.leaseToken,
            status: 'STARTED',
            possibleDuplicate,
            startedAt: now,
          },
        });
        claimed.push({ job, attemptId: attempt.id, attemptNo: job.attemptCount, leaseToken: row.leaseToken, possibleDuplicate });
      }
      return claimed;
    });
  }

  /** Record the result. Returns false when the lease was lost (result is recorded as a late completion). */
  async complete(claimed: ClaimedJob, outcome: AttemptOutcome, now: Date, opts: QueueOptions): Promise<boolean> {
    const { job } = claimed;
    return this.prisma.$transaction(async (tx) => {
      let applied: boolean;
      if (outcome.ok) {
        const r = await tx.webhookJob.updateMany({
          where: { id: job.id, leaseToken: claimed.leaseToken, status: 'IN_PROGRESS' },
          data: { status: 'SUCCEEDED', deliveredAt: now, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, lastError: null },
        });
        applied = r.count === 1;
      } else {
        const dead = outcome.terminal || claimed.attemptNo >= job.maxAttempts;
        const r = await tx.webhookJob.updateMany({
          where: { id: job.id, leaseToken: claimed.leaseToken, status: 'IN_PROGRESS' },
          data: {
            status: dead ? 'DEAD' : 'PENDING',
            nextAttemptAt: dead ? undefined : new Date(now.getTime() + backoffMs(claimed.attemptNo, opts.baseBackoffMs, opts.maxBackoffMs)),
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            lastError: redactString(outcome.error ?? `HTTP ${outcome.httpStatus ?? '?'}`).slice(0, 500),
          },
        });
        applied = r.count === 1;
      }
      await tx.webhookAttempt.update({
        where: { id: claimed.attemptId },
        data: {
          status: outcome.ok ? 'SUCCEEDED' : 'FAILED',
          finishedAt: now,
          httpStatus: outcome.httpStatus ?? null,
          error: outcome.error ? redactString(outcome.error).slice(0, 500) : null,
          responseExcerpt: outcome.responseExcerpt ? redactString(outcome.responseExcerpt).slice(0, 500) : null,
          durationMs: outcome.durationMs ?? null,
          deliveries: outcome.deliveries ?? 1,
          lateCompletion: !applied,
        },
      });
      return applied;
    });
  }

  newWorkerId(): string {
    return `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  }
}
