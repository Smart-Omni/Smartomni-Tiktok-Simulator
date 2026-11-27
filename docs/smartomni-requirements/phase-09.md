# Phase 09 - SmartOmni-side requirements (not implemented here)

Status: **BLOCKED** for this work (the SmartOmni platform repo is reference only). The simulator side of steps 1-4 is Phase 09a (coupon data, read API, checkout discount). Steps 5-11 below belong to SmartOmni; 09b adds only the simulator-side data they rely on.

## Step 5 - loyalty vouchers from pre-created code batches (Phase 09c)
SmartOmni never creates a coupon through the API: `promotion.coupon_create` stays `unsupported` + `LOCKED` in `contracts/manifest.json` (the OAS has none; `/promotion/202309/activities` is a promotion-activity API and must NOT be substituted). SmartOmni must still return a clear "not supported" message for "Admin creates a voucher through the API" and never email a code as if it had been created. Signed `POST/PUT/PATCH/DELETE` on any `/promotion/...` path other than coupon search returns the router's plain 404 (`tiktok-coupons.e2e-spec.ts`).

Instead, like on the real TikTok Shop, the seller creates a **batch of single-use codes** on the Seller Center beforehand (simulator: Seller Center > Vouchers > Code batches, or `POST /test-admin/scenarios/loyalty-vouchers` for test data). Every code is its own coupon with `usage_limits.redemption_limit = 1`; codes of one batch share the title, discount and validity. Batch codes are private: buyers never see them in the shop and must type the code SmartOmni gave them.

SmartOmni flow:
1. **Staff configure tier -> batch** by title (e.g. Diamond -> `Loyalty Diamond 30%`). The percentages are SmartOmni configuration, not simulator rules.
2. **Pull the codes** with `POST /promotion/202406/coupons/search` (`title_keyword` = the batch title, case-insensitive "contains"; `status: ["ONGOING"]`; `page_size=100`, follow `next_page_token`). Store `coupon_id` + `promo_code`. Pull again when the pool of free codes runs low (the seller can add a new batch with the same title).
3. **Customer claims** -> hand out one code not handed out yet. Who received which code, and the issue/claim dates, are SmartOmni data (the simulator has no claim concept; `claimed_count` = `redeemed_count`).
4. **Track usage** with `GET /promotion/202406/coupons/{coupon_id}`, `usage_stats.redeemed_count` and `status` (Search has no `usage_stats`):

   | `status` | `redeemed_count` | Meaning | SmartOmni |
   |---|---|---|---|
   | `ONGOING` | 0 | Free / handed out, not used yet | Keep polling if handed out |
   | `ONGOING` | 1 | Used in an order | Stop polling, mark used |
   | `DEACTIVATED` | 0 or 1 | Burned (an UNPAID order using it was cancelled) or switched off by the seller | Stop polling, never hand out again |
   | `EXPIRED` | 0 or 1 | Expired | Stop polling |
   | `NOT_START` | 0 | Not started | Do not hand out yet |

   Every state other than "free" is final, so the set of codes to poll only shrinks. Poll only codes handed out and not final; filter expired/deactivated codes in bulk with Search `status: ["EXPIRED", "DEACTIVATED"]`. `status` stays `ONGOING` after use (the OAS has no "used up" status).
5. **Orders do not say which code was used** (Order Detail has no coupon field). Loyalty does not need it: points come from `sub_total` after discount; the discount itself is in `seller_discount` / `subtotal_deduction_seller`. `voucher_deduction_seller` is a discount type code in the OAS, not an amount.

Decisions and the full contract: `DECISIONS.md` section Phase 09c. Reading coupons (scope placeholder `sim.promotion.read`) proves nothing about the right to create or audit them.

## Steps 6-11 (loyalty / Customer Portal) - see 09b
Order data SmartOmni needs: shop/connection, source status, completion time, payable product amount after discount (`payment.sub_total`, with `seller_discount`, shipping and tax as separate components), tax and shipping excluded from points. Claim endpoint, 15-day rule, one-time claim by constraint, tiers (Standard <500, Gold >=500, Platinum >=1000, Diamond >=1500) and the Customer Portal account are SmartOmni work.

## Not supported by the simulator (do not assume)
- Coupon card in chat (Phase 09 step 4): it depends on Phase 08 Send Message supporting `COUPON_CARD`; until that is verified in a snapshot, nothing sends a coupon card.
- Audience `REPEAT_CUSTOMERS`, product-scoped coupons (`SPECIFIC_PRODUCTS`), claim limits and per-buyer claims: not modelled.

## 09b - Loyalty (steps 6-11): SmartOmni-side requirements (BLOCKED here)

The simulator supplies the test data (`POST /test-admin/scenarios/loyalty-orders`, see below). Everything else belongs to the SmartOmni platform repo (reference-only for this work).

1. **Order data to keep** (from webhook/polling): shop/connection, the SOURCE status and `update_time` (COMPLETED time = the `update_time` of the transition to COMPLETED; the OAS has no separate completed field), and the payment components `sub_total`, `original_total_product_price`, `seller_discount`, `platform_discount`, `shipping_fee`, `tax`, `total_amount`.
2. **Customer Portal claim**: authenticated Customer Portal account (never merge it with the TikTok buyer identity); tenant from the authenticated account; never trust a `customer_id` or `tenant_id` from the client; first valid claimer wins (decision already settled), enforced by a unique constraint/transaction so two concurrent claims award points once.
3. **Eligibility**: order in the right tenant/shop, source status COMPLETED (DELIVERED is not enough), and at least 15 days since completion (SmartOmni business rule, not a TikTok policy). Boundary cases are generated by the simulator: exactly 15 days (eligible), 14 days 23 h (not eligible), 16 days (eligible), DELIVERED, paid but AWAITING_SHIPMENT.
4. **Points** = `floor(actually_paid_product_amount / 1000 VND)` where the amount is `sub_total` (after seller/platform discount), NOT `total_amount` (includes shipping/tax). If the components cannot be separated, keep the claim in `pending_reconciliation`.
5. **Tiers** (points never expire or get spent when a perk is received): Standard < 500, Gold >= 500, Platinum >= 1000, Diamond >= 1500.
6. **Refund/return after the claim** is recorded as a pending decision; the policy is not changed automatically.
7. **Migrations**: new Flyway versions only (V7/V8 differ from the newer decision; never edit applied versions).

### Simulator test data
`POST /test-admin/scenarios/loyalty-orders` `{ "shopId": "...", "thresholdDays": 15 }` (admin token) runs five orders through the real state machine with the BUSINESS clock frozen at the wanted completion time: N+1 days ago, exactly N days, N days minus 1 hour, DELIVERED only, paid but still AWAITING_SHIPMENT (the simulator has no ON_HOLD). The clock is restored afterwards; the request-signature clock is never changed.
