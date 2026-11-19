// API and webhook signing helpers. Uses only node:crypto.
//
// API signing: the algorithm mirrors the TTS Open Toolkit's local proxy-broker signer (indirect evidence; see signing/README.md),
// NOT the Partner Center "common parameters" page (client-rendered, unreadable on 2026-10-14).
// Webhook signing per TikTok OpenAPI & SmartOmni WebhookHmacValidator: HMAC-SHA256(app_secret, path + timestamp + raw_body).
import { createHmac, timingSafeEqual } from "node:crypto";

const EXCLUDED_QUERY_KEYS = new Set(["sign", "access_token"]);

export type Body = string | Uint8Array | null | undefined;

function bodyToString(body: Body): string {
  if (body === null || body === undefined) return "";
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

/**
 * StringToSign = app_secret + path + (name + value for each query param sorted by name, excluding sign and access_token)
 *              + raw request body (empty string when there is none) + app_secret
 * The body is the exact bytes/characters sent on the wire (not re-serialised). Sorting is by UTF-16 code unit (the toolkit
 * uses localeCompare; the two agree for lowercase snake_case names, which is all the documented parameters).
 */
export function apiStringToSign(secret: string, path: string, query: Record<string, string>, body: Body = null): string {
  let s = secret + path;
  for (const k of Object.keys(query).filter((k) => !EXCLUDED_QUERY_KEYS.has(k)).sort()) {
    s += k + query[k];
  }
  return s + bodyToString(body) + secret;
}

/**
 * Throws for multipart/form-data: whether (and how) a multipart body enters the signature is not stated in any readable
 * official source, so upload operations stay unverified and are not signed here.
 */
export function signApiRequest(secret: string, path: string, query: Record<string, string>, body: Body = null, contentType = "application/json"): string {
  if (/^multipart\/form-data/i.test(contentType)) {
    throw new Error("multipart/form-data signing is unverified (see contracts/signing/README.md); refusing to guess");
  }
  return createHmac("sha256", secret).update(apiStringToSign(secret, path, query, body)).digest("hex");
}

export function signWebhook(path: string, timestamp: string | number, appSecret: string, rawBody: string): string;
export function signWebhook(appKey: string, appSecret: string, rawBody: string): string;
export function signWebhook(a: string, b: string | number, c: string, d?: string): string {
  if (d !== undefined) {
    // standard TikTok OpenAPI & SmartOmni WebhookHmacValidator: HMAC(app_secret, path + timestamp + raw_body)
    const path = a;
    const timestamp = b;
    const appSecret = c;
    const rawBody = d;
    return createHmac("sha256", appSecret).update(`${path}${timestamp}${rawBody}`).digest("hex");
  }
  // legacy: HMAC(app_secret, app_key + raw_body)
  return createHmac("sha256", b as string).update(a + c).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function verifyWebhook(path: string, timestamp: string | number, appSecret: string, rawBody: string, header: string): boolean;
export function verifyWebhook(appKey: string, appSecret: string, rawBody: string, header: string): boolean;
export function verifyWebhook(a: string, b: string | number, c: string, d: string, e?: string): boolean {
  if (e !== undefined) {
    return safeEqualHex(signWebhook(a, b, c, d), e);
  }
  return safeEqualHex(signWebhook(a, b as string, c), d);
}
