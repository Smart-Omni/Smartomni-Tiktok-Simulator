import { Controller, Get, Inject, Query, Req, UseFilters } from '@nestjs/common';
import type { App } from '@prisma/client';
import { TiktokFault } from '../common/tiktok-fault';
import { IssuedTokens, OAuthService } from '../oauth/oauth.service';
import type { TiktokRequest } from './tiktok-api.guard';
import { TiktokFaultFilter } from './tiktok-fault.filter';

/**
 * Token exchange / refresh. PROVISIONAL shapes from contracts/schemas/token-response.json (secondary sources only,
 * status `unverified`). Authenticated by app_key + app_secret in the query (not signed), per the manifest.
 * `grant_type` is accepted but not enforced: the contract does not pin its value.
 * `access_token_expire_in` / `refresh_token_expire_in` are ABSOLUTE Unix seconds (as in fixtures/token.json), not TTLs; unconfirmed.
 */
@Controller()
@UseFilters(TiktokFaultFilter)
export class TokenController {
  constructor(@Inject(OAuthService) private readonly oauth: OAuthService) {}

  private body(req: TiktokRequest, issued: IssuedTokens, shopId: string) {
    req.shopId = shopId;
    return {
      code: 0,
      message: 'success',
      request_id: req.requestId ?? 'unknown',
      data: {
        access_token: issued.accessToken,
        access_token_expire_in: Math.floor(issued.accessExpiresAt.getTime() / 1000),
        refresh_token: issued.refreshToken,
        refresh_token_expire_in: Math.floor(issued.refreshExpiresAt.getTime() / 1000),
        open_id: issued.openId,
        granted_scopes: issued.scopes,
      },
    };
  }

  private async app(q: Record<string, unknown>): Promise<App> {
    if (Object.values(q).some((v) => typeof v !== 'string')) throw new TiktokFault(400, 'invalid_input', 'query parameters must be plain strings');
    return this.oauth.authenticateApp(q.app_key as string | undefined, q.app_secret as string | undefined);
  }

  @Get('api/v2/token/get')
  async get(@Req() req: TiktokRequest, @Query() q: Record<string, unknown>) {
    const app = await this.app(q);
    const { issued, shopId } = await this.oauth.exchangeCode(app, q.auth_code as string | undefined);
    return this.body(req, issued, shopId);
  }

  @Get('api/v2/token/refresh')
  async refresh(@Req() req: TiktokRequest, @Query() q: Record<string, unknown>) {
    const app = await this.app(q);
    const { issued, shopId } = await this.oauth.refresh(app, q.refresh_token as string | undefined);
    return this.body(req, issued, shopId);
  }
}
