import { Module } from '@nestjs/common';
import { CouponBatchService } from './coupon-batch.service';

/** Phase 09c: promo code batches. Imported by Demo (Seller Center) and TestAdmin; the TikTok router never imports it (no coupon-creation API, Q1). */
@Module({ providers: [CouponBatchService], exports: [CouponBatchService] })
export class CouponsModule {}
