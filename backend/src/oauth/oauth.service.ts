import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { App, Shop, Token } from '@prisma/client';
import { timingSafeEqual } from 'crypto';
import { AuthClock } from '../clock/clock';
import { hashToken, newSecret } from '../common/hash';
import { TiktokFault } from '../common/tiktok-fault';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  openId: string;
  /** The token's GRANTED scopes (what the API guard enforces), echoed as `data.granted_scopes`. */
  scopes: string[];
}

export interface ConsentContext {
  app: { appKey: string; name: string };
  shop: { id: string; name: string; region: string; currency: string };
  scopes: string[];
  redirectUri: string;
  state: string | null;
}

export type TokenWithShop = Token & { shop: Shop; app: App };

const MAX_STATE_LENGTH = 512;

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Authorization-code and token lifecycle shared by the demo consent flow and the TikTok-shaped token/auth endpoints.
 * Code and token expiry use the AuthClock (real time): shifting the business clock must not change authentication.
 * Raw codes/tokens exist only in the return value of the issuing call; the database holds SHA-256 hashes.
 */
@Injectable()
export class OAuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AuthClock) private readonly clock: AuthClock,
  ) {}

  // ---------- app / consent (demo side) ----------

  async findAppByKey(appKey: string): Promise<App | null> {
    return this.prisma.app.findUnique({ where: { appKey } });
  }

  /** The redirect target must EXACTLY equal a registered URI; without `redirect_uri` the first registered one is used. */
  private resolveRedirect(app: App, requested?: string | null): string {
    if (requested) {
      if (!app.redirectUris.includes(requested)) throw new BadRequestException('redirect_uri is not registered for this app');
      return requested;
    }
    if (app.redirectUris.length === 0) throw new BadRequestException('The app has no registered redirect URI');
    return app.redirectUris[0];
  }

  private validateState(state?: string | null): string | null {
    if (state === undefined || state === null || state === '') return null;
    // eslint-disable-next-line no-control-regex
    if (state.length > MAX_STATE_LENGTH || /[\u0000-\u001f\u007f]/.test(state)) throw new BadRequestException('state is too long or contains control characters');
    return state;
  }

  async consentContext(shopId: string, appKey: string, redirectUri?: string | null, state?: string | null): Promise<ConsentContext> {
    const app = await this.findAppByKey(appKey);
    if (!app) throw new BadRequestException('Unknown app_key');
    const shop = await this.prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
    return {
      app: { appKey: app.appKey, name: app.name },
      shop: { id: shop.id, name: shop.name, region: shop.region, currency: shop.currency },
      scopes: app.scopes,
      redirectUri: this.resolveRedirect(app, redirectUri),
      state: this.validateState(state),
    };
  }

  /**
   * Accept creates a single-use code and redirects to the registered URI with `code` and the echoed `state`;
   * deny redirects with `error=access_denied` (OAuth-style names, UNVERIFIED for TikTok). The URL is built here so the
   * browser can only be sent to a registered redirect URI.
   */
  async decide(
    shopId: string,
    input: { appKey: string; redirectUri?: string | null; state?: string | null; decision: 'accept' | 'deny' },
  ): Promise<{ decision: string; redirectUrl: string }> {
    const ctx = await this.consentContext(shopId, input.appKey, input.redirectUri, input.state);
    const url = new URL(ctx.redirectUri);
    if (input.decision === 'deny') {
      url.searchParams.append('error', 'access_denied');
    } else {
      const app = (await this.findAppByKey(input.appKey))!;
      const rawCode = newSecret('sim_ac');
      await this.prisma.authorizationCode.create({
        data: {
          codeHash: hashToken(rawCode),
          appId: app.id,
          shopId,
          redirectUri: ctx.redirectUri,
          state: ctx.state,
          scopes: app.scopes,
          expiresAt: new Date(this.clock.now().getTime() + this.config.oauth.authCodeTtlMs),
        },
      });
      url.searchParams.append('code', rawCode);
    }
    if (ctx.state !== null) url.searchParams.append('state', ctx.state);
    return { decision: input.decision, redirectUrl: url.toString() };
  }

  // ---------- TikTok-shaped token endpoints ----------

  async authenticateApp(appKey: string | undefined, appSecret: string | undefined): Promise<App> {
    if (!appKey || !appSecret) throw new TiktokFault(400, 'invalid_input', 'app_key and app_secret are required');
    const app = await this.findAppByKey(appKey);
    // Same fault for unknown key and wrong secret so the endpoint does not reveal which app keys exist.
    if (!app || !safeEqual(app.appSecret, appSecret)) throw new TiktokFault(401, 'invalid_app_credentials', 'app_key/app_secret rejected');
    return app;
  }

  private newPair(now: Date): { access: string; refresh: string; accessExpiresAt: Date; refreshExpiresAt: Date } {
    return {
      access: newSecret('sim_at'),
      refresh: newSecret('sim_rt'),
      accessExpiresAt: new Date(now.getTime() + this.config.oauth.accessTokenTtlMs),
      refreshExpiresAt: new Date(now.getTime() + this.config.oauth.refreshTokenTtlMs),
    };
  }

  /** auth_code -> tokens. The code is consumed in the same transaction that creates the token (atomic single use). */
  async exchangeCode(app: App, rawCode: string | undefined): Promise<{ issued: IssuedTokens; shopId: string }> {
    if (!rawCode) throw new TiktokFault(400, 'invalid_input', 'auth_code is required');
    const now = this.clock.now();
    const row = await this.prisma.authorizationCode.findUnique({ where: { codeHash: hashToken(rawCode) } });
    if (!row || row.appId !== app.id) throw new TiktokFault(400, 'auth_code_invalid', 'auth_code is not valid for this app');
    const pair = this.newPair(now);
    const shop = await this.prisma.shop.findUniqueOrThrow({ where: { id: row.shopId }, include: { seller: true } });
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.authorizationCode.updateMany({ where: { id: row.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
      if (consumed.count !== 1) {
        const current = await tx.authorizationCode.findUniqueOrThrow({ where: { id: row.id } });
        if (current.consumedAt) throw new TiktokFault(400, 'auth_code_used', 'auth_code was already used');
        throw new TiktokFault(400, 'auth_code_expired', 'auth_code has expired');
      }
      // One live authorization per (app, shop): re-authorizing supersedes the previous tokens.
      await tx.token.updateMany({ where: { appId: app.id, shopId: row.shopId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } });
      await tx.token.create({
        data: {
          appId: app.id,
          shopId: row.shopId,
          accessTokenHash: hashToken(pair.access),
          refreshTokenHash: hashToken(pair.refresh),
          accessExpiresAt: pair.accessExpiresAt,
          refreshExpiresAt: pair.refreshExpiresAt,
          scopes: row.scopes,
        },
      });
    });
    return {
      shopId: row.shopId,
      issued: { accessToken: pair.access, refreshToken: pair.refresh, accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt, openId: shop.seller.openId, scopes: row.scopes },
    };
  }

  /**
   * Rotating refresh. One conditional UPDATE keyed on the OLD refresh hash decides the winner: under READ COMMITTED a
   * concurrent loser re-evaluates the WHERE after the winner commits, matches 0 rows and is rejected. The old refresh
   * token is dead afterwards. There is no retry and no token-family revocation on reuse.
   */
  async refresh(app: App, rawRefresh: string | undefined): Promise<{ issued: IssuedTokens; shopId: string }> {
    if (!rawRefresh) throw new TiktokFault(400, 'invalid_input', 'refresh_token is required');
    const now = this.clock.now();
    const oldHash = hashToken(rawRefresh);
    const row = await this.prisma.token.findUnique({ where: { refreshTokenHash: oldHash }, include: { shop: { include: { seller: true } } } });
    if (!row || row.appId !== app.id) throw new TiktokFault(400, 'refresh_token_invalid', 'refresh_token is not valid for this app');
    if (row.status === 'REVOKED') throw new TiktokFault(400, 'authorization_revoked', 'the authorization was revoked; the seller must authorize again');
    if (row.refreshExpiresAt.getTime() <= now.getTime()) throw new TiktokFault(400, 'refresh_token_expired', 'refresh_token has expired; the seller must authorize again');
    const pair = this.newPair(now);
    const updated = await this.prisma.token.updateMany({
      where: { id: row.id, refreshTokenHash: oldHash, status: 'ACTIVE', refreshExpiresAt: { gt: now } },
      data: { accessTokenHash: hashToken(pair.access), refreshTokenHash: hashToken(pair.refresh), accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt },
    });
    if (updated.count !== 1) throw new TiktokFault(400, 'refresh_token_invalid', 'refresh_token was already used or is no longer valid');
    return {
      shopId: row.shopId,
      issued: { accessToken: pair.access, refreshToken: pair.refresh, accessExpiresAt: pair.accessExpiresAt, refreshExpiresAt: pair.refreshExpiresAt, openId: row.shop.seller.openId, scopes: row.scopes },
    };
  }

  // ---------- API access token ----------

  async authenticateAccessToken(rawAccess: string): Promise<TokenWithShop> {
    const row = await this.prisma.token.findUnique({ where: { accessTokenHash: hashToken(rawAccess) }, include: { shop: true, app: true } });
    if (!row) throw new TiktokFault(401, 'token_invalid', 'access token is not recognised');
    if (row.status === 'REVOKED') throw new TiktokFault(401, 'authorization_revoked', 'the authorization was revoked');
    if (row.accessExpiresAt.getTime() <= this.clock.now().getTime()) throw new TiktokFault(401, 'token_expired', 'access token has expired');
    return row;
  }

  /**
   * Shop of an access token WITHOUT authenticating it (no expiry/revocation/signature check), or null.
   * Only for matching shop-scoped fault rules, which run before the guard; never use it to authorize anything.
   */
  async shopIdOfAccessToken(rawAccess: string): Promise<string | null> {
    const row = await this.prisma.token.findUnique({ where: { accessTokenHash: hashToken(rawAccess) }, select: { shopId: true } });
    return row?.shopId ?? null;
  }
}
