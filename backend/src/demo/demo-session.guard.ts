import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { hashToken } from '../common/hash';
import { PrismaService } from '../prisma/prisma.service';

export interface DemoPrincipal {
  sessionId: string;
  role: 'SELLER' | 'BUYER';
  scope: 'SHOP' | 'MARKETPLACE';
  shopId: string;
  buyerId: string | null;
}
export type DemoRequest = Request & { demo?: DemoPrincipal; shopId?: string };

/**
 * Seller can only access their own shop.
 */
export function assertSellerShop(p: DemoPrincipal, shopId: string): void {
  if (p.role !== 'SELLER') throw new ForbiddenException('Only a seller session can do this');
  if (p.shopId !== shopId) throw new ForbiddenException('This session cannot access another shop');
}

/**
 * Access check for shop resources:
 * - Seller must access their own shop.
 * - Buyer can access any ACTIVE shop on the marketplace.
 */
export async function assertShopAccess(p: DemoPrincipal, shopId: string, prisma?: PrismaService): Promise<void> {
  if (p.role === 'SELLER') {
    if (p.shopId !== shopId) throw new ForbiddenException('This session cannot access another shop');
    return;
  }
  if (p.role === 'BUYER') {
    if (prisma) {
      const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { status: true } });
      if (!shop || shop.status !== 'ACTIVE') throw new ForbiddenException('Shop is not active or does not exist');
    }
    return;
  }
  throw new ForbiddenException('Invalid session role');
}

/**
 * @deprecated Use assertSellerShop or assertShopAccess
 */
export function assertOwnShop(p: DemoPrincipal, shopId: string): void {
  assertSellerShop(p, shopId);
}

/** Session isolation for the Seller/Buyer UIs. This is NOT TikTok auth and is unrelated to SmartOmni login. */
@Injectable()
export class DemoSessionGuard implements CanActivate {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<DemoRequest>();
    const raw = req.header('x-demo-session');
    if (!raw) throw new UnauthorizedException('Missing x-demo-session header');
    const session = await this.prisma.demoSession.findUnique({ where: { tokenHash: hashToken(raw) } });
    if (!session || session.expiresAt.getTime() < Date.now()) throw new UnauthorizedException('Invalid or expired demo session');
    const scope: 'SHOP' | 'MARKETPLACE' = session.role === 'BUYER' ? 'MARKETPLACE' : 'SHOP';
    req.demo = { sessionId: session.id, role: session.role, scope, shopId: session.shopId, buyerId: session.buyerId };
    req.shopId = session.shopId;
    return true;
  }
}
