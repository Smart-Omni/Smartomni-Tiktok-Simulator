# Signing notes (API request and webhook)

Access date: **2026-10-14**. The Partner Center "Common parameters" page (the official signing description) is a client-rendered SPA and could not be read, and no official test vector was available. Do not treat the repo's existing HMAC code as TikTok compatible.

## API request signing (OpenAPI) - body handling: indirect official evidence only

Source: the TTS Open Toolkit (`@tts-open-toolkit/cli` 0.1.7, installed locally), function `W6` in `dist/tts_open_toolkit.mjs`. IMPORTANT: this is the toolkit's LOCAL proxy broker, not the server rule. The broker verifies a signature from local SDK clients with a random per-process secret (`z6()`: 32 random bytes, not the app secret), then deletes `sign`/`timestamp`/`access_token`/`nonce` and forwards the request with its own Partner Center authorization header, so `W6` output never reaches open-api.tiktokglobalshop.com. What it does show: TikTok's own tooling reimplements the TikTok-style OpenAPI signature as below, with the body appended. That is useful indirect evidence, NOT verification against the Common Parameters page or the server.

```
StringToSign = app_secret
             + path                                   (request path only, e.g. /product/202502/products/search)
             + for each query param sorted by name, excluding "sign" and "access_token":  name + value
             + raw request body                       (exact string sent; "" when there is none)
             + app_secret
sign = lowercase_hex(HMAC_SHA256(key = app_secret, message = StringToSign))
```

- **Body:** the raw JSON body is appended AFTER the sorted query parameters and BEFORE the trailing `app_secret`. GET (no body) and bodiless POST append the empty string. `signing/sign.ts` implements this; the old behaviour (refusing a body) is gone.
- `sign` and `access_token` are the only excluded query keys. `app_key`, `timestamp`, `shop_cipher` and all operation query params (`page_size`, `page_token`, `ids`, ...) ARE signed. `x-tts-access-token` is a header, not signed.
- Sorting: the toolkit sorts with `localeCompare`; `sign.ts` sorts by code unit. They agree for the lowercase snake_case names used by documented parameters.
- Query values are signed as the raw (decoded) strings; percent-encoding is not part of the string to sign here (not exercised by any vector).
- The toolkit's local verifier rejects timestamps outside a configurable window (default 60 s: a toolkit choice). The window TikTok enforces server-side is NOT documented in any readable source.

### Still unverified (blockers, not guessed)

- **multipart/form-data** (`product.media_upload`, `product.file_upload`, `cs.image_upload`): the toolkit signer has no multipart case; `signApiRequest` throws for a multipart content type. The upload operations stay `unverified`. (A commonly cited rule is that multipart bodies are excluded from the string to sign, but no readable official source states it, so it is not implemented.)
- The official Common Parameters page (timestamp unit/tolerance, `version` param, whether `shop_id` can replace `shop_cipher`) was not read.
- Whether `shop_cipher` is needed for a Vietnamese local shop (the OAS says it is optional; incorrect responses are described for cross-border shops).

## Webhook signing

**What the simulator sends (since DECISIONS.md D9):** the rule SmartOmni's `WebhookHmacValidator.validateTikTokWebhook` verifies, `lowercase_hex(HMAC_SHA256(key = app_secret, message = app_secret + path + timestamp + raw_body))`, with `path` = pathname of the receiving URL and `timestamp` = the `timestamp` header (real send time, Unix seconds). Implemented by the 4-argument `signWebhook` in `sign.ts`. TikTok's real rule is still unverified.

**Secondary source (kept for reference; the vector in `test-vectors.json` follows it, through the 3-argument `signWebhook`).** Source: Hookdeck TikTok Shop webhook guide (https://hookdeck.com/webhooks/skills/tiktok-shop-webhooks.md). Not in the OAS.

- Header `Authorization` (no `Bearer` prefix).
- `lowercase_hex(HMAC_SHA256(key = app_secret, message = app_key + raw_request_body))`, computed on the raw bytes before JSON parsing; compare in constant time.
- No timestamp in the signature: no replay protection. De-duplicate on `tts_notification_id` and reconcile by polling.
- Receiver replies HTTP 200 with empty body within 3 s; HTTP 401 on rejected signature (secondary).

## Test vectors

`test-vectors.json` has 5 API vectors (GET without params, GET with unsorted input including `shop_cipher`, POST JSON body, POST with empty body, PUT with a non-ASCII JSON body) and 1 webhook vector.

Each API digest agrees across four tools, but they are not four independent derivations of the string to sign: only (1) the toolkit's `W6` function (extracted from the installed package and executed) and (4) `sign.ts` build the string to sign; (2) Python `hmac`/`hashlib` and (3) the OpenSSL CLI only re-run the HMAC over the string to sign recorded in the vector. This validates the implementation of the *described* algorithm, not the algorithm itself; TikTok published no vector that was readable. Credentials are synthetic.

Regenerate/recheck: extract `La`, `Z6`, `W6` from the toolkit bundle and call `W6({path, query, body, secret})`; compare with `openssl dgst -sha256 -hmac <secret>` over the `string_to_sign` field.
