import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AppConfig, APP_CONFIG, loadConfig } from './config/config';
import { AuthClock, BusinessClock, PersistentBusinessClock, SystemAuthClock } from './clock/clock';
import { DemoModule } from './demo/demo.module';
import { FaultService } from './faults/fault.service';
import { HealthModule } from './health/health.module';
import { RequestLogMiddleware } from './http-log/request-log.middleware';
import { PrismaService } from './prisma/prisma.service';
import { ResetService } from './reset/reset.service';
import { SeedService } from './seed/seed.service';
import { StartupSeeder } from './seed/startup-seeder';
import { TestAdminModule } from './test-admin/test-admin.module';
import { TiktokFaultMiddleware, TiktokModule } from './tiktok/tiktok.module';
import { MediaModule } from './media/media.module';
import { DisputeModule } from './dispute/dispute.module';
import { WebhookQueueService } from './webhooks/webhook-queue.service';
import { FetchWebhookTransport, SystemWorkerTime, WebhookTransport, WebhookWorkerService, WorkerTime } from './webhooks/webhook-worker.service';

/** Shared infrastructure. Business modules (Phase 03+) consume these; the TikTok module does not get admin services. */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    PrismaService,
    PersistentBusinessClock,
    { provide: BusinessClock, useExisting: PersistentBusinessClock },
    { provide: AuthClock, useClass: SystemAuthClock },
    FaultService,
    SeedService,
    ResetService,
    WebhookQueueService,
    { provide: WebhookTransport, useClass: FetchWebhookTransport },
    { provide: WorkerTime, useClass: SystemWorkerTime },
    WebhookWorkerService,
    StartupSeeder,
  ],
  exports: [APP_CONFIG, PrismaService, PersistentBusinessClock, BusinessClock, AuthClock, FaultService, SeedService, ResetService, WebhookQueueService, WebhookWorkerService, WebhookTransport, WorkerTime],
})
export class CoreModule {}

@Module({
  imports: [
    CoreModule,
    HealthModule,
    DemoModule,
    TestAdminModule,
    TiktokModule,
    MediaModule,
    DisputeModule,
    // Three separate routers. TikTok-shaped paths stay at the root (exact contract paths), /demo and /test-admin are namespaced.
    RouterModule.register([
      { path: 'health', module: HealthModule },
      { path: 'demo', module: DemoModule },
      { path: 'test-admin', module: TestAdminModule },
    ]),
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogMiddleware).forRoutes('*');
    consumer.apply(TiktokFaultMiddleware).forRoutes('*');
  }
}
