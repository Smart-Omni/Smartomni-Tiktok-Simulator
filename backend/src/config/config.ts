import { DEFAULT_APP_SCOPES } from '../oauth/scopes';

export interface AppConfig {
  port: number;
  databaseUrl: string;
  testAdminToken: string;
  /** Public base URL other systems (browser, SmartOmni on host) use to reach this API. */
  publicApiBaseUrl: string;
  /** Callback URL base the simulator puts into webhooks/redirects when running inside Docker. */
  hostCallbackBaseUrl: string;
  mediaDir: string;
  pdfDir: string;
  worker: {
    enabled: boolean;
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    requestTimeoutMs: number;
  };
  seed: {
    onStart: boolean;
    appKey: string;
    appSecret: string;
    appRedirectUris: string[];
    /** Simulator-defined placeholder scopes granted by consent (official scope names are unresolved in the contract). */
    appScopes: string[];
  };
  oauth: {
    /** All durations are simulator choices (TikTok's values are undocumented in readable sources). */
    authCodeTtlMs: number;
    accessTokenTtlMs: number;
    refreshTokenTtlMs: number;
    /** Accepted |now - timestamp| for API request signatures. UNVERIFIED: TikTok's server-side window is undocumented. */
    signatureWindowMs: number;
  };
  orders: {
    /** Flat shipping fee (VND). A simulator choice. */
    shippingFeeVnd: number;
  };
  webhook: {
    /** Rewrite localhost/127.0.0.1 subscription addresses to HOST_CALLBACK_BASE_URL (needed inside Docker). */
    rewriteLocalhost: boolean;
  };
  aftersale: {
    /** Days (business clock) after DELIVERY during which a buyer may request a return/refund. A SIMULATOR / SmartOmni test rule, NOT a verified TikTok policy. */
    returnWindowDays: number;
  };
  demoSessionTtlMs: number;
  resetConfirmTtlMs: number;
}

function int(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

function bool(name: string, fallback: boolean, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const testAdminToken = env.TEST_ADMIN_TOKEN;
  if (!testAdminToken || testAdminToken.length < 8) {
    throw new Error('TEST_ADMIN_TOKEN is required (min 8 chars). Copy .env.example to .env and change it.');
  }
  const port = int('PORT', 8090, env);
  return {
    port,
    databaseUrl,
    testAdminToken,
    publicApiBaseUrl: env.PUBLIC_API_BASE_URL ?? `http://localhost:${port}`,
    hostCallbackBaseUrl: env.HOST_CALLBACK_BASE_URL ?? 'http://host.docker.internal',
    mediaDir: env.MEDIA_DIR ?? './data/media',
    pdfDir: env.PDF_DIR ?? './data/pdf',
    worker: {
      enabled: bool('WEBHOOK_WORKER_ENABLED', true, env),
      pollIntervalMs: int('WEBHOOK_POLL_INTERVAL_MS', 1000, env),
      batchSize: int('WEBHOOK_BATCH_SIZE', 5, env),
      leaseMs: int('WEBHOOK_LEASE_MS', 30000, env),
      baseBackoffMs: int('WEBHOOK_BASE_BACKOFF_MS', 2000, env),
      maxBackoffMs: int('WEBHOOK_MAX_BACKOFF_MS', 300000, env),
      requestTimeoutMs: int('WEBHOOK_REQUEST_TIMEOUT_MS', 10000, env),
    },
    seed: {
      onStart: bool('SEED_ON_START', true, env),
      appKey: env.SEED_APP_KEY ?? 'smartomni-dev-app-key',
      appSecret: env.SEED_APP_SECRET ?? 'smartomni-dev-app-secret-fake',
      appRedirectUris: (env.SEED_APP_REDIRECT_URIS ?? 'http://localhost:5174/merchant/channels/tiktok-shop/callback,smartomni://oauth/tiktok')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      appScopes: (env.SEED_APP_SCOPES || DEFAULT_APP_SCOPES.join(','))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    oauth: {
      authCodeTtlMs: int('OAUTH_AUTH_CODE_TTL_MS', 5 * 60 * 1000, env),
      accessTokenTtlMs: int('OAUTH_ACCESS_TOKEN_TTL_MS', 60 * 60 * 1000, env),
      refreshTokenTtlMs: int('OAUTH_REFRESH_TOKEN_TTL_MS', 30 * 24 * 3600 * 1000, env),
      signatureWindowMs: int('OAUTH_SIGNATURE_WINDOW_MS', 5 * 60 * 1000, env),
    },
    orders: {
      shippingFeeVnd: int('ORDER_SHIPPING_FEE_VND', 25000, env),
    },
    webhook: { rewriteLocalhost: bool('WEBHOOK_REWRITE_LOCALHOST', false, env) },
    aftersale: { returnWindowDays: int('RETURN_WINDOW_DAYS', 15, env) },
    demoSessionTtlMs: int('DEMO_SESSION_TTL_MS', 8 * 3600 * 1000, env),
    resetConfirmTtlMs: int('RESET_CONFIRM_TTL_MS', 120000, env),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
