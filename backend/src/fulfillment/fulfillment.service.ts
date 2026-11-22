import { Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Package, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { BusinessClock } from '../clock/clock';
import { APP_CONFIG, AppConfig } from '../config/config';
import { OrderRow, OrderRuleError, OrdersService, TransitionContext } from '../orders/orders.service';
import { PrismaService } from '../prisma/prisma.service';
import { numericId } from '../seed/seed-data';
import { WebhookEmitter } from '../webhooks/webhook-emitter.service';
import { buildPdf, PdfPage } from './pdf';

export const DOC_TYPES = ['SHIPPING_LABEL', 'PACKING_SLIP', 'SHIPPING_LABEL_AND_PACKING_SLIP'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const PROVIDER = { id: 'SIM-CARRIER-1', name: 'Simulator Express (fake carrier)' };
export const PROVIDER_2 = { id: 'SIM-CARRIER-2', name: 'Simulator Saver (fake carrier)' };
/** Static delivery options (DECISIONS DA-11): provider lists per option. Assumption, not TikTok data. */
export const DELIVERY_OPTIONS = [
  { id: 'SIM-DO-STANDARD', name: 'Standard', type: 'STANDARD', description: 'Standard door-to-door delivery (simulator).', providers: [PROVIDER, PROVIDER_2] },
  { id: 'SIM-DO-EXPRESS', name: 'Express', type: 'EXPRESS', description: 'Express delivery (simulator).', providers: [PROVIDER] },
];

/** Package status when the seller has not arranged shipment yet (OAS line-item `package_status` value; no package-level equivalent exists). */
export const PKG_TO_FULFILL = 'TO_FULFILL';

const STATUS_BY_ORDER: Record<string, string> = { AWAITING_COLLECTION: 'PROCESSING', IN_TRANSIT: 'FULFILLING', DELIVERED: 'COMPLETED' };
const DESCRIPTION: Record<string, string> = {
  PROCESSING: 'Seller has arranged the shipment. Waiting for the carrier to collect the parcel.',
  FULFILLING: 'The parcel was collected by the carrier and is in transit.',
  COMPLETED: 'Your package was delivered!',
  CANCELLED: 'The package was cancelled.',
};

/**
 * Packages, tracking events and shipping documents. Package state follows the order state machine (OrdersService transition listener, same
 * transaction), so a package can never disagree with its order and PACKAGE_UPDATE is written together with the change.
 * Everything here is FAKE: tracking numbers use the "SIM" prefix and the PDFs are stamped as test data.
 */
@Injectable()
export class FulfillmentService implements OnModuleInit {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OrdersService) private readonly orders: OrdersService,
    @Inject(WebhookEmitter) private readonly emitter: WebhookEmitter,
    @Inject(BusinessClock) private readonly clock: BusinessClock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.orders.addTransitionListener((ctx) => this.onTransition(ctx));
  }

  // ---- reacting to order transitions (inside the order's transaction) --------------------------------------------

  private async onTransition(ctx: TransitionContext): Promise<void> {
    const { tx, to, after, now } = ctx;
    let pkg = await tx.package.findUnique({ where: { orderId: after.id } });
    if (to === 'AWAITING_SHIPMENT' && !pkg) {
      pkg = await this.createPackage(ctx);
      await this.emitPackage(ctx, pkg, after);
      return;
    }
    if (to === 'CANCELLED') {
      if (!pkg || pkg.status === 'COMPLETED' || pkg.status === 'CANCELLED') return;
      pkg = await tx.package.update({ where: { id: pkg.id }, data: { status: 'CANCELLED', updatedAt: now } });
      await tx.trackingEvent.create({ data: { orderId: after.id, packageId: pkg.id, status: 'CANCELLED', description: DESCRIPTION.CANCELLED, at: now } });
      await this.emitPackage(ctx, pkg, after);
      return;
    }
    const status = STATUS_BY_ORDER[to];
    if (!status) return;
    if (!pkg) pkg = await this.createPackage(ctx); // e.g. forced through the Test Console without passing AWAITING_SHIPMENT
    const data: Prisma.PackageUpdateInput = { status, updatedAt: now };
    if (status === 'PROCESSING' && !pkg.trackingNumber) data.trackingNumber = `SIM${numericId('', `tracking:${pkg.id}`).slice(-11)}`;
    pkg = await tx.package.update({ where: { id: pkg.id }, data });
    await tx.trackingEvent.create({ data: { orderId: after.id, packageId: pkg.id, status, description: DESCRIPTION[status], at: now } });
    await this.emitPackage(ctx, pkg, after);
  }

  private async createPackage(ctx: TransitionContext): Promise<Package> {
    const { tx, after, now, shop } = ctx;
    const externalId = numericId('5762', `package:${after.id}`);
    const pkg = await tx.package.create({
      data: { shopId: shop.id, orderId: after.id, externalId, status: PKG_TO_FULFILL, shippingProviderId: PROVIDER.id, shippingProviderName: PROVIDER.name, createdAt: now, updatedAt: now },
    });
    await tx.packageLine.createMany({ data: after.lines.map((l) => ({ packageId: pkg.id, orderLineId: l.id })) });
    await tx.orderLine.updateMany({ where: { orderId: after.id }, data: { packageId: externalId } });
    return pkg;
  }

  private async emitPackage(ctx: TransitionContext, pkg: Package, order: OrderRow): Promise<void> {
    await this.emitter.emit(
      ctx.tx,
      ctx.shop,
      'PACKAGE_UPDATE',
      { package_id: pkg.externalId, order_id: order.externalId, package_status: pkg.status, update_time: Math.floor(pkg.updatedAt.getTime() / 1000) },
      ctx.requestId,
    );
  }

  // ---- actions ---------------------------------------------------------------------------------------------------

  /** Arrange shipment. An UNPAID order is refused (`order_unpaid`, DECISIONS H8); repeating the call on an already arranged order returns the same package. */
  async arrangeShipment(shopId: string, orderExternalId: string, actor: 'SELLER' | 'TEST_CONSOLE', requestId?: string, handoverMethod?: string): Promise<Package> {
    const order = await this.orderOf(shopId, orderExternalId);
    if (order.status === 'UNPAID') throw new OrderRuleError('order_unpaid', 'an UNPAID order cannot be shipped before payment');
    if (order.status === 'CANCELLED') throw new OrderRuleError('order_cancelled', 'a cancelled order cannot be shipped');
    if (order.status === 'AWAITING_SHIPMENT') {
      await this.orders.transition(order.id, 'AWAITING_COLLECTION', actor, { note: 'shipment arranged', requestId });
    } else if (!['AWAITING_COLLECTION', 'IN_TRANSIT', 'DELIVERED', 'COMPLETED', 'PARTIALLY_SHIPPING'].includes(order.status)) {
      throw new OrderRuleError('order_not_shippable', `order status ${order.status} cannot be shipped`);
    }
    let pkg = await this.prisma.package.findUniqueOrThrow({ where: { orderId: order.id } });
    if (handoverMethod && !pkg.handoverMethod) pkg = await this.prisma.package.update({ where: { id: pkg.id }, data: { handoverMethod } });
    return pkg;
  }

  /** One carrier step: AWAITING_COLLECTION -> IN_TRANSIT -> DELIVERED. DELIVERED is not COMPLETED. */
  async advanceShipment(shopId: string, orderExternalId: string, actor: 'SELLER' | 'TEST_CONSOLE', requestId?: string): Promise<Package> {
    const order = await this.orderOf(shopId, orderExternalId);
    const next = order.status === 'AWAITING_COLLECTION' ? 'IN_TRANSIT' : order.status === 'IN_TRANSIT' ? 'DELIVERED' : null;
    if (!next) throw new OrderRuleError('nothing_to_advance', `an order in ${order.status} has no next carrier step`);
    await this.orders.transition(order.id, next, actor, { note: 'carrier step', requestId });
    return this.prisma.package.findUniqueOrThrow({ where: { orderId: order.id } });
  }

  /**
   * Update Package Shipping Info: replaces tracking number / carrier of an arranged package that is not finished.
   * Cached shipping documents are dropped so the next label request carries the new number. Emits PACKAGE_UPDATE.
   */
  async updateShippingInfo(shopId: string, packageExternalId: string, trackingNumber: string, providerId: string, requestId?: string): Promise<Package> {
    const provider = DELIVERY_OPTIONS.flatMap((o) => o.providers).find((p) => p.id === providerId);
    if (!provider) throw new OrderRuleError('unknown_shipping_provider', `shipping_provider_id ${providerId} is not a simulator carrier`);
    const found = await this.packageOf(shopId, packageExternalId);
    if (!found.trackingNumber) throw new OrderRuleError('package_not_arranged', 'the shipment has not been arranged yet');
    if (found.status === 'COMPLETED' || found.status === 'CANCELLED') throw new OrderRuleError('package_finished', `a ${found.status} package cannot be changed`);
    const shop = await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const pkg = await tx.package.update({ where: { id: found.id }, data: { trackingNumber, shippingProviderId: provider.id, shippingProviderName: provider.name, updatedAt: now } });
      await tx.shippingDocument.deleteMany({ where: { packageId: pkg.id } });
      await tx.trackingEvent.create({ data: { orderId: pkg.orderId, packageId: pkg.id, status: pkg.status, description: 'The seller updated the tracking information.', at: now } });
      await this.emitter.emit(tx, shop, 'PACKAGE_UPDATE', { package_id: pkg.externalId, order_id: found.order.externalId, package_status: pkg.status, update_time: Math.floor(now.getTime() / 1000) }, requestId);
      return pkg;
    });
  }

  /**
   * Update Package Delivery Status (seller-reported). DELIVERY_SUCCESS moves an in-transit order to DELIVERED (a repeat is a no-op);
   * DELIVERY_FAILED only records a tracking event and leaves the order IN_TRANSIT.
   */
  async reportDelivery(shopId: string, packageExternalId: string, type: 'DELIVERY_SUCCESS' | 'DELIVERY_FAILED', failReason: string | undefined, requestId?: string): Promise<void> {
    const pkg = await this.packageOf(shopId, packageExternalId);
    const status = pkg.order.status;
    if (type === 'DELIVERY_SUCCESS') {
      if (status === 'DELIVERED' || status === 'COMPLETED') return;
      if (status !== 'IN_TRANSIT') throw new OrderRuleError('package_not_in_transit', `an order in ${status} cannot be reported as delivered`);
      await this.orders.transition(pkg.order.id, 'DELIVERED', 'SELLER', { note: 'seller reported delivery', requestId });
      return;
    }
    if (status !== 'IN_TRANSIT') throw new OrderRuleError('package_not_in_transit', `an order in ${status} cannot be reported as a failed delivery`);
    await this.prisma.trackingEvent.create({ data: { orderId: pkg.orderId, packageId: pkg.id, status: pkg.status, description: `Delivery attempt failed: ${failReason}`, at: this.clock.now() } });
  }

  // ---- reads -----------------------------------------------------------------------------------------------------

  async orderOf(shopId: string, orderExternalId: string) {
    const order = await this.prisma.order.findFirst({
      where: { shopId, externalId: orderExternalId },
      include: { lines: { orderBy: [{ externalId: 'asc' }] }, buyer: { select: { externalId: true, name: true } } },
    });
    if (!order) throw new NotFoundException('Unknown order');
    return order;
  }

  /** A package that exists only in another shop is reported as unknown. */
  async packageOf(shopId: string, packageExternalId: string) {
    const pkg = await this.prisma.package.findUnique({
      where: { shopId_externalId: { shopId, externalId: packageExternalId } },
      include: { order: { include: { lines: { orderBy: [{ externalId: 'asc' }] }, buyer: { select: { externalId: true, name: true } } } }, lines: true },
    });
    if (!pkg) throw new NotFoundException('Unknown package');
    return pkg;
  }

  async trackingOf(shopId: string, orderExternalId: string) {
    const order = await this.orderOf(shopId, orderExternalId);
    return this.prisma.trackingEvent.findMany({ where: { orderId: order.id }, orderBy: [{ at: 'asc' }, { seq: 'asc' }] });
  }

  // ---- shipping documents ----------------------------------------------------------------------------------------

  /** Idempotent per (package, type): the same URL (and the same file) is returned on every call, also after a restart. */
  async documentFor(shopId: string, packageExternalId: string, docType: DocType): Promise<{ token: string; trackingNumber: string }> {
    const pkg = await this.packageOf(shopId, packageExternalId);
    if (!pkg.trackingNumber) throw new OrderRuleError('package_not_arranged', 'the shipment has not been arranged yet, so there is no label');
    const existing = await this.prisma.shippingDocument.findUnique({ where: { packageId_docType: { packageId: pkg.id, docType } } });
    if (existing) return { token: existing.token, trackingNumber: pkg.trackingNumber };

    const shop = await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    const pages: PdfPage[] = [];
    const stamp = 'TEST DATA - NOT A REAL SHIPPING LABEL';
    if (docType !== 'PACKING_SLIP') {
      const o = pkg.order;
      pages.push({
        title: stamp,
        lines: [
          `Carrier: ${pkg.shippingProviderName}`,
          `Tracking: ${pkg.trackingNumber}`,
          `Package: ${pkg.externalId}   Order: ${o.externalId}`,
          '',
          'SHIP TO',
          `${o.recipientName} - ${o.recipientPhone}`,
          `${o.addressLine}, ${o.district}, ${o.city}`,
          '',
          `FROM: ${shop.name}`,
          `Units: ${o.lines.length}`,
          '',
          'Generated by the SmartOmni TikTok Shop simulator.',
        ],
      });
    }
    if (docType !== 'SHIPPING_LABEL') {
      const per = new Map<string, number>();
      for (const l of pkg.order.lines) per.set(`${l.sellerSku} ${l.productName} (${l.skuName})`, (per.get(`${l.sellerSku} ${l.productName} (${l.skuName})`) ?? 0) + 1);
      pages.push({ title: `PACKING SLIP - ${stamp}`, lines: [`Order ${pkg.order.externalId}`, `Package ${pkg.externalId}`, '', ...[...per].map(([k, n]) => `${n} x ${k}`)] });
    }
    const bytes = buildPdf(pages);
    const token = randomBytes(24).toString('hex');
    const dir = join(this.config.pdfDir, 'shipping');
    await fs.mkdir(dir, { recursive: true });
    const filePath = join(dir, `${token}.pdf`);
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, filePath);
    try {
      await this.prisma.shippingDocument.create({ data: { packageId: pkg.id, docType, token, filePath, sizeBytes: bytes.length, createdAt: this.clock.now() } });
    } catch (e) {
      // a concurrent request created the row first: use theirs, drop our file
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await fs.rm(filePath, { force: true });
        const winner = await this.prisma.shippingDocument.findUniqueOrThrow({ where: { packageId_docType: { packageId: pkg.id, docType } } });
        return { token: winner.token, trackingNumber: pkg.trackingNumber };
      }
      throw e;
    }
    return { token, trackingNumber: pkg.trackingNumber };
  }

  /** Bytes of a generated document by its public token (unguessable); null when unknown. */
  async readDocument(token: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{48}$/.test(token)) return null;
    const doc = await this.prisma.shippingDocument.findUnique({ where: { token } });
    if (!doc) return null;
    try {
      return await fs.readFile(doc.filePath);
    } catch {
      return null;
    }
  }

  documentUrl(token: string): string {
    return `${this.config.publicApiBaseUrl.replace(/\/$/, '')}/demo/files/shipping-documents/${token}.pdf`;
  }
}
