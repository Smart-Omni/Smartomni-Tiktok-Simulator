// Builds contracts/manifest.json from snapshots/oas-extract.json (run build-from-oas.mjs first) plus the hand-written
// decisions below. Run from contracts/:  node tools/build-manifest.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extract = JSON.parse(readFileSync(join(root, "snapshots/oas-extract.json"), "utf8"));
const DATE = extract.accessDate;
const BUNDLE = `tts-openapi-guide bundled OAS, shipped with @tts-open-toolkit/cli ${extract.bundledWith.split(" ")[1]}`;
const byId = new Map(extract.operations.map((o) => [o.id, o]));
const docUrl = (id) => `https://partner.tiktokshop.com/docv2/page/${id}`;

const MARKET = "VN domestic shop: applicability NOT verified. The OAS states no market restriction for this operation and does not list VN as a shop region value; no claim that a real VN shop is granted access.";
const SCOPE = "not stated in the OAS (no x-scopes / scope text); official scope name unresolved";
const OAS_VS_DOCV2 = "docv2 not readable on 2026-10-14 (client-rendered SPA; unauthenticated API returns 'internal error'), so OAS-vs-docv2 differences and any docv2-only newer version are UNKNOWN";
const COMMON_BLOCKER = [
  "docv2 page unreadable, so freshness of the selected version and OAS-vs-docv2 differences are unchecked",
  "OAS declares no per-field required flags for body/response and no structured enums, so 'required fields' cannot be fully verified",
  "scope name is not in the OAS",
  "error codes/messages for invalid input, expired token and missing scope are not documented in any readable official source",
  "request signing rests only on indirect evidence (the toolkit's local proxy-broker signer mirrors it), not the Common Parameters page (server-side timestamp window, Content-Type and multipart rules unread)",
  "VN applicability not stated",
];
const blockerFor = (extra) => `${extra ? extra + " Also: " : "Not promoted to supported: "}${COMMON_BLOCKER.join("; ")}.`;

const OAS_STATUS = "unverified";
/** [id, capability, phase, versionChoice, extraBlocker, notes, docv2PageHint] */
const OPS = [
  ["auth.shops", "Authorized shops", 3, "Only version in bundle (GET 202309). The similarly named seller/202309/shops GetActiveShops is a different capability (not compared).", "", "seller_type is documented as CROSS_BORDER | LOCAL (schema enum). region is a free string in the OAS (example GB); whether VN is returned for a Vietnamese local shop is NOT stated. Target seller: All. Source description links the 'Seller authorization guide' docv2 page 678e3a344ddec3030b238fa0."],
  ["product.search", "Product search", 4, "Candidates SearchProducts 202309, 202312, 202502; selected 202502 (highest, same capability, no documented market exclusion).", "", "Cursor pagination: query page_size (required, 1-100) + page_token; response next_page_token + total_count. Several body filters are market-specific (e.g. listing_quality_tiers US only); VND appears in product currency enums."],
  ["product.detail", "Product detail", 4, "Only GET candidate is 202309. product/202509 products/{product_id} is a PUT EditProduct (different capability), so it is not an upgrade.", "", null],
  ["product.media_upload", "Upload product image (media upload)", 4, "Only candidate POST /product/202309/images/upload (multipart/form-data: data, use_case).", "Upload is multipart/form-data and the multipart signing rule is unverified.", "Max 10MB; JPG/JPEG/PNG/WEBP/HEIC/BMP; 100x100-20000x20000 px; use_case values in the description. Its response image uri is what return.reject.images[].image_id expects."],
  ["product.file_upload", "Upload product file (document/video)", 4, "Only candidate POST /product/202309/files/upload (multipart).", "Upload is multipart/form-data and the multipart signing rule is unverified.", null],
  ["logistics.warehouses", "Warehouse list", 4, "Only candidate GET 202309 (GetWarehouseList).", "", null],
  ["product.inventory_update", "Update inventory", 6, "Only candidate POST 202309 (UpdateInventory). global_products inventory update is a different capability.", "", null],
  ["order.search", "Order search (list)", 5, "Only candidate POST 202309 (GetOrderList).", "", "Cursor pagination: page_size (required, default 20, range 1-100) + page_token; response next_page_token + total_count."],
  ["order.detail", "Order detail", 5, "Candidates GetOrderDetail 202309 and 202507; selected 202507 (highest, same capability).", "", "GET with required query ids (max 50 order IDs). Not paginated."],
  ["fulfillment.tracking", "Order tracking", 7, "Only candidate GET 202309 (GetTracking).", "", null],
  ["fulfillment.shipping_documents", "Package shipping documents", 7, "Only candidate GET 202309 (GetPackageShippingDocument).", "", "document_type is a required query param (SHIPPING_LABEL | PACKING_SLIP per description). Applies to TikTok Shipping orders only; requires Ship Package first."],
  ["fulfillment.package_detail", "Package detail", 7, "Only candidate GET 202309 (GetPackageDetail).", "", "Added: needed to read delivery_option/status before shipping. Replaces part of the old fulfillment.actions placeholder."],
  ["fulfillment.package_ship", "Ship package (fulfillment action)", 7, "Only candidate POST /fulfillment/202309/packages/{package_id}/ship (ShipPackage). Related but NOT compared: orders/{order_id}/packages MarkPackageAsShipped, packages/ship batch.", "Which shipping operation(s) Phase 07 should mimic is a team decision.", "Replaces the old unsupported fulfillment.actions placeholder (path now known). TikTok Shipping needs handover_method + pickup_slot; seller shipping needs self_shipment.{shipping_provider_id,tracking_number}."],
  ["return.search", "Search returns", 7, "Only candidate POST 202309 (SearchReturns). RMA 202604 is NOT in the bundle and does NOT replace Search Returns.", "", "Cursor pagination: page_size (default 10, range 10-50) + page_token; response next_page_token + total_count."],
  ["return.approve", "Approve return/refund", 7, "Only candidate POST 202309 (ApproveReturn).", "", "decision values: APPROVE_REFUND, APPROVE_RETURN, APPROVE_RECEIVED_PACKAGE, APPROVE_REPLACEMENT (per description; list may be longer). Part of the old return.actions placeholder."],
  ["return.reject", "Reject return/refund", 7, "Only candidate POST 202309 (RejectReturn).", "", "decision REJECT_REFUND | REJECT_RETURN | REJECT_RECEIVED_PACKAGE | REJECT_REPLACEMENT; reject_reason ids come from return.reject_reasons; images need image_id from product.media_upload."],
  ["return.records", "Return records (history)", 7, "Only candidate GET 202309 (GetReturnRecords).", "", null],
  ["return.reject_reasons", "Reject reasons", 7, "Only candidate GET 202309 (GetRejectReasons).", "", "Required query return_or_cancel_id."],
  ["return.aftersale_eligibility", "Aftersale eligibility", 7, "Candidates 202309 and 202512; selected 202512 (highest, same capability).", "", "Also referenced by the customer-service RETURN_REFUND_CARD message."],
  ["cancellation.search", "Search cancellations", 7, "Only candidate POST 202309 (SearchCancellations).", "", "Cursor pagination: page_size (default 10, range 1-50) + page_token."],
  ["cancellation.approve", "Approve cancellation", 7, "Only candidate POST 202309 (ApproveCancellation).", "", null],
  ["cancellation.reject", "Reject cancellation", 7, "Only candidate POST 202309 (RejectCancellation).", "", null],
  ["cs.conversations", "Conversation list", 8, "Only candidate GET 202309 (GetConversations).", "", "Cursor pagination: page_size (required, max 20) + page_token; response next_page_token."],
  ["cs.messages", "Conversation messages", 8, "Only candidate GET 202309 (GetConversationMessages).", "", "Cursor pagination: page_size (required, max 10) + page_token; response next_page_token."],
  ["cs.conversation_detail", "Conversation detail", 8, "Only candidate GET 202601 (GetConversation); baseline version confirmed present in the bundle.", "", null],
  ["cs.send_message", "Send message", 8, "Phase-file baseline is POST 202606. The bundle only has 202309 (OAS coverage gap). Per the version rule 202606 stays selected but its schema cannot be read, so it has no schema; 202309 is kept as a separate candidate (cs.send_message_202309).", "Send Message 202606 schema/docv2 page unreadable; bundle only has 202309.", "Send Message 202606 is missing from the bundled OAS (OAS coverage gap)."],
  ["cs.send_message_202309", "Send message (bundle candidate 202309, NOT the selected version)", 8, "Fallback candidate only: highest version present in the bundle (POST 202309, SendMessage). Using it instead of 202606 is a team decision.", "Older version than the phase baseline; not selected.", "Message types in the OAS: TEXT, IMAGE, VIDEO, PRODUCT_CARD, ORDER_CARD, RETURN_REFUND_CARD, COUPON_CARD, LOGISTICS_CARD; content is a JSON-serialised string; TEXT max 2000 characters. IMAGE needs a url from cs.image_upload."],
  ["cs.image_upload", "Upload buyer-message image", 8, "Only candidate POST /customer_service/202309/images/upload (multipart).", "Upload is multipart/form-data and the multipart signing rule is unverified.", null],
  ["promotion.coupon_search", "Search coupons (read)", 9, "Only candidate POST 202406 (SearchCoupons).", "", "Read-only listing; the OAS says coupons are created in Seller Center or Seller App. Limits: page_size 1-100 (default 50); usage_limits.redemption_limit is 'only available in ID, MY, PH, TH, SG, VN regions'. Cursor pagination: page_token (omit for first page), response next_page_token ('' on last page) + total_count."],
  ["promotion.coupon_detail", "Coupon detail (read)", 9, "Only candidate GET 202406 (GetCoupon).", "", null],
  ["event.webhooks_get", "Get webhook subscriptions", 5, "Only candidate GET 202309 (GetShopWebhooks).", "", "Lists configured topics (event_type) and addresses. Not paginated (total_count only)."],
  ["event.webhooks_put", "Set webhook address for a topic", 5, "Only candidate PUT 202309 (UpdateShopWebhook).", "", "Body address (max 255 chars) + event_type (one topic per call)."],
  ["event.webhooks_delete", "Delete webhook for a topic", 5, "Only candidate DELETE 202309 (DeleteShopWebhook).", "", "Succeeds whether or not the webhook existed (per OAS description). DELETE carries a JSON body {event_type}."],
  ["product.category_attributes", "Category attributes", 4, "Only candidate GET 202309 (GetAttributes).", "", "category_id must be a leaf category. Field name is_requried is the OAS spelling."],
  ["product.category_rules", "Category rules", 4, "Only candidate GET 202309 (GetCategoryRules).", "", "cod / package_dimension / size_chart / certifications; manufacturer and responsible_person apply to the EU only."],
  ["product.update_price", "Update price", 4, "Only candidate POST 202309 (UpdatePrice).", "", "Product must be ACTIVATE and not in an ongoing campaign."],
  ["product.inventory_search", "Inventory search", 6, "Only candidate POST 202309 (InventorySearch).", "", "product_ids max 100 or sku_ids max 600; sku_ids wins when both are sent."],
  ["product.delete", "Delete products", 4, "Only candidate DELETE 202309 (DeleteProducts).", "", "Max 20 ids; FREEZE products cannot be deleted."],
  ["product.recover", "Recover products", 4, "Only candidate POST 202309 (RecoverProducts).", "", "DELETED -> SELLER_DEACTIVATED; max 20 ids."],
  ["fulfillment.package_search", "Package search", 7, "Only candidate POST 202309 (SearchPackage).", "", "page_size required [1-50]."],
  ["fulfillment.package_batch_ship", "Batch ship packages", 7, "Only candidate POST 202309 (BatchShipPackages).", "", "Per-package errors in data.errors."],
  ["return.create", "Create return on behalf of the buyer", 7, "Only candidate POST 202309 (CreateReturn).", "", "idempotency_key is a query parameter."],
  ["return.refund_calculate", "Calculate refund", 7, "Only candidate POST 202309 (CalculateRefund).", "", "retail_delivery_fee applies to the US only."],
  ["cancellation.seller_cancel", "Seller cancel order", 7, "Only candidate POST 202309 (CancelOrder).", "", "Partial cancellation is documented for the US and UK only."],
  ["cs.read_message", "Mark conversation messages as read", 8, "Only candidate POST 202309 (ReadMessage).", "", null],
  ["cs.create_conversation", "Create conversation", 8, "Only candidate POST 202309 (CreateConversation).", "", "buyer_user_id equals orders.user_id of Get Order Detail."],
  ["fulfillment.handover_slots", "Package handover time slots", 7, "Only candidate GET 202309 (GetPackageHandoverTimeSlots).", "", "van collection is UK only."],
  ["fulfillment.shipping_info_update", "Update package shipping info", 7, "Only candidate POST 202309 (UpdatePackageShippingInfo).", "", "Replaces tracking number and carrier."],
  ["fulfillment.package_deliver", "Update package delivery status", 7, "Only candidate POST 202309 (UpdatePackageDeliveryStatus).", "", "OAS: only seller-shipped packages; the simulator accepts any in-transit package (DECISIONS DA-11)."],
  ["logistics.delivery_options", "Warehouse delivery options", 7, "Only candidate GET 202309 (GetWarehouseDeliveryOptions).", "", "Simulator uses static options (DECISIONS DA-11)."],
  ["logistics.shipping_providers", "Shipping providers of a delivery option", 7, "Only candidate GET 202309 (GetShippingProviders).", "", "Simulator uses static providers (DECISIONS DA-11)."],
  ["order.price_detail", "Order price detail", 5, "Only candidate GET 202407 (GetPriceDetail).", "", "cod_fee and distance_fee are 0 for VN domestic orders (assumption)."],
  ["cs.agent_settings_get", "Get agent settings", 8, "Only candidate GET 202309 (GetAgentSettings).", "", null],
  ["cs.agent_settings_put", "Update agent settings", 8, "Only candidate PUT 202309 (UpdateAgentSettings).", "", null],
  ["auth.deauthorize", "Deauthorize shop", 3, "Only candidate DELETE 202403 (DeauthorizeShop).", "", "Revokes every token of the calling app for the shop."],
  ["product.partial_edit", "Partial edit product", 4, "Only candidate POST 202509 (PartialEditProduct).", "", "EU / Tokopedia body fields are ignored."],
];

const operations = [];
const push = (o) => operations.push(o);

// ---- OAS-backed API operations ----
for (const [id, capability, phase, versionChoice, extraBlocker, notes] of OPS) {
  const sourceId = id;
  const x = byId.get(sourceId);
  if (!x && id !== "cs.send_message") throw new Error(`missing extract for ${id}`);
  if (id === "cs.send_message") {
    push({
      id, capability, method: "POST", path: "/customer_service/202606/conversations/{conversation_id}/messages", version: "202606", phase, host: "openapi", kind: "real",
      source: ["Spec/tiktok-shop-simulator/01-api-contracts.md (baseline)", docUrl("send-message-202606") + " (unreadable SPA)", "bundle has only SendMessage 202309 -> see cs.send_message_202309"],
      accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice, oasVsDocv2: OAS_VS_DOCV2,
      status: "unverified", evidence: "baseline-only (no readable schema for 202606)", verification: { schema: "none", requestParams: "none", bodyRequiredFields: "none", signing: "indirect: toolkit local-broker signer (body appended, JSON)", errorCodes: "undocumented", scope: "unresolved", market: "unverified", docv2Diff: "not checked" },
      snapshot: null, schemaRef: null, requestSchemaRef: null, request: null, pagination: null, fixtures: null,
      blocker: blockerFor(extraBlocker), notes,
    });
    continue;
  }
  const hasBody = x.hasBody;
  const multipart = x.multipart;
  const request = { params: x.params.map((p) => ({ in: p.in, name: p.name, required: p.required, type: p.type, format: p.format })), contentType: multipart ? "multipart/form-data" : "application/json" };
  push({
    id, capability, method: x.method, path: x.path, version: x.path.split("/")[2], phase, host: "openapi", kind: "real",
    source: [`${BUNDLE} (${x.path})`, "docv2 page pattern https://partner.tiktokshop.com/docv2/page/{api-slug}-{version} (unreadable SPA)"],
    accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice: `${versionChoice} Candidates in bundle: ${x.candidates.join(", ")}.`, oasVsDocv2: OAS_VS_DOCV2,
    status: OAS_STATUS, evidence: "official-oas",
    verification: {
      schema: "official-oas (shape and field names/types); no per-field required flags, enums only in description text",
      requestParams: "official-oas (query/path/header with required flags)",
      bodyRequiredFields: hasBody ? "unknown (OAS declares none)" : multipart ? "unknown (multipart; OAS declares none)" : "n/a (no JSON body)",
      signing: multipart ? "unverified (multipart rule unknown)" : hasBody ? "indirect: toolkit local-broker signer (raw JSON body appended); Common Parameters page unread" : "indirect: toolkit local-broker signer (query only); Common Parameters page unread",
      errorCodes: "undocumented in readable sources", scope: "unresolved", market: "unverified", docv2Diff: "not checked",
    },
    snapshot: `snapshots/oas/${id}.json`, schemaRef: `schemas/ops/${id}.response.json`, requestSchemaRef: hasBody ? `schemas/ops/${id}.request.json` : null,
    request, pagination: x.pagination ? { style: "cursor", requestParams: x.pagination.requestParams, responseFields: x.pagination.responseFields } : "none documented in the operation schema",
    fixtures: `fixtures/ops/${id}.json`,
    oasSha256: x.sha,
    blocker: blockerFor(extraBlocker), notes,
  });
}

// ---- Authorization / token (not in OAS) ----
const NOT_IN_OAS = "Not in the bundled OAS (it only covers /{module}/{version}/... shop APIs). Partner Center docv2 pages unreadable.";
push({
  id: "auth.authorization_url", capability: "Seller authorization URL", method: "GET", path: "(unknown)", version: "-", phase: 3, host: "auth", kind: "real",
  source: ["tts-openapi-faq-index: FAQ titles 'What is the redirect url used for?', 'What does the \"state\" in the authorization link mean?', 'Can there be multiple Redirect urls'", "OAS authorization/202309/shops description links docv2 page 678e3a344ddec3030b238fa0 (Seller authorization guide)"],
  accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice: "n/a", oasVsDocv2: "n/a",
  status: "unsupported", evidence: "FAQ titles only (existence of an authorization link with a 'state' parameter and an app-level redirect URL; no URL, host or parameter list)",
  verification: { schema: "none", requestParams: "none", bodyRequiredFields: "n/a", signing: "n/a", errorCodes: "FAQ mentions (unexplained) 105004 and a message about region restriction", scope: "unresolved", market: "unverified", docv2Diff: "not checked" },
  snapshot: null, schemaRef: null, requestSchemaRef: null, request: null, pagination: null, fixtures: null,
  blocker: "Authorization URL format (host, path, query: app_key/state/...) is not in any readable official source; it is generated in Partner Center per app. Read docv2 page 678e3a344ddec3030b238fa0 (Seller authorization guide). Not invented. Simulator uses /demo/* for the seller consent screen until verified.",
  notes: "FAQ confirms: the redirect URL is configured per app in Partner Center (one URL; changing it does not take effect immediately); sellers outside the app's allowed regions get 'No authorization permission for your account region'.",
});
push({
  id: "auth.token_get", capability: "Token exchange (auth_code -> tokens)", method: "GET", path: "/api/v2/token/get", version: "v2", phase: 3, host: "auth", kind: "real",
  source: ["tts-openapi-faq-index FAQ title: 'When \"/api/v2/token/get\" is called, what is the length of the \"open_id\" field returned' (official, confirms the path exists)", "secondary: npm tiktok-shop-client, useresponse article (params, host)"],
  accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice: NOT_IN_OAS, oasVsDocv2: "n/a",
  status: "unverified", evidence: "official FAQ title (path name only) + secondary (shape)",
  verification: { schema: "secondary (provisional)", requestParams: "secondary", bodyRequiredFields: "n/a", signing: "unverified (token endpoints are called on the auth host with app_key/app_secret/auth_code query, not signed like shop APIs, per secondary sources)", errorCodes: "undocumented", scope: "n/a", market: "unverified", docv2Diff: "not checked" },
  snapshot: null, schemaRef: "schemas/token-response.json", requestSchemaRef: null, request: null, pagination: null, fixtures: "fixtures/token.json",
  blocker: blockerFor("Token request/response schema, host (auth.tiktok-shops.com), grant_type value and expiry semantics are from third-party sources only; no readable official page."),
  notes: "access_token_expire_in is reported by third-party clients as an absolute Unix timestamp, not a TTL: unconfirmed. FAQ: the OAS-era refresh path is '/api/token/refreshtoken' with message 'rt has expired' code 36004001 (legacy path; not mapped to 'access token expired').",
});
push({
  id: "auth.token_refresh", capability: "Token refresh", method: "GET", path: "/api/v2/token/refresh", version: "v2", phase: 3, host: "auth", kind: "real",
  source: ["secondary: packagist haistar/tiktokshop-api-client", "tts-openapi-faq-index FAQ titles: 'What is the current logic for refresh token and access token?', \"/api/token/refreshtoken ... rt has expired\" (36004001)"],
  accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice: NOT_IN_OAS, oasVsDocv2: "n/a",
  status: "unverified", evidence: "secondary (path); FAQ title mentions a legacy refresh path only",
  verification: { schema: "secondary (provisional)", requestParams: "secondary", bodyRequiredFields: "n/a", signing: "unverified", errorCodes: "FAQ: 36004001 'rt has expired' on the legacy path only", scope: "n/a", market: "unverified", docv2Diff: "not checked" },
  snapshot: null, schemaRef: "schemas/token-response.json", requestSchemaRef: null, request: null, pagination: null, fixtures: "fixtures/token.json",
  blocker: blockerFor("Refresh path /api/v2/token/refresh is from a third-party client only; the official FAQ only names the legacy /api/token/refreshtoken."),
  notes: null,
});

// ---- Locked / unsupported capabilities ----
push({
  id: "return.rma_202604", capability: "Returns/RMA 202604", method: "-", path: "(unknown)", version: "202604", phase: 7, host: "openapi", kind: "real",
  source: ["Spec/tiktok-shop-simulator/01-api-contracts.md (gap note)", "bundled OAS return_refund versions: 202309, 202405, 202512 (no 202604)"],
  accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice: "RMA 202604 does NOT replace Search Returns; return.search stays on 202309 (only version present).", oasVsDocv2: OAS_VS_DOCV2,
  status: "unsupported", evidence: "absent from the bundled OAS", verification: { schema: "none", requestParams: "none", bodyRequiredFields: "n/a", signing: "n/a", errorCodes: "none", scope: "unresolved", market: "unverified", docv2Diff: "not checked" },
  snapshot: null, schemaRef: null, requestSchemaRef: null, request: null, pagination: null, fixtures: null,
  blocker: "No 202604 RMA operation exists in the bundled OAS and the docv2 page is unreadable; capability/path/schema unknown. Not used for returns.",
  notes: "RMA 202604 does NOT replace Search Returns.",
});
push({
  id: "promotion.coupon_create", capability: "Create coupon via OpenAPI", method: "-", path: "(none)", version: "-", phase: 9, host: "openapi", kind: "real",
  source: ["bundled OAS promotion module: coupons/search and coupons/{coupon_id} only; activities (CreateActivity 202309) is a different capability", "OAS SearchCoupons description: 'The coupons are created in Seller Center or Seller App.'"],
  accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice: "n/a", oasVsDocv2: OAS_VS_DOCV2,
  status: "unsupported", evidence: "official OAS shows no coupon-create operation", verification: { schema: "none", requestParams: "none", bodyRequiredFields: "n/a", signing: "n/a", errorCodes: "none", scope: "unresolved", market: "unverified", docv2Diff: "not checked" },
  snapshot: null, schemaRef: null, requestSchemaRef: null, request: null, pagination: null, fixtures: null,
  blocker: "LOCKED: no coupon-creation endpoint is verified for VN (none in the OAS). /promotion/202309/activities is a promotion-activity API, not a coupon API: not substituted. Simulator creates coupon data only via /demo.",
  notes: "Coupon listing is read-only (promotion.coupon_search / promotion.coupon_detail).",
});

// ---- Webhooks (event topics are official; payload schema is not in the OAS) ----
const TOPICS = [
  ["ORDER_STATUS_CHANGE", "650300b8a57708028b430b4a", "Triggers on each order status update, from new order placement through all subsequent status changes."],
  ["RECIPIENT_ADDRESS_UPDATE", "650301af5a12ff0294ea3bf9", "Triggers when the recipient's address is updated."],
  ["PACKAGE_UPDATE", "650955cabace3e02b73cc886", "Triggers when a package is updated (combined, split, address changed)."],
  ["CANCELLATION_STATUS_CHANGE", "65030150746462028285f657", "Triggers when an order's cancellation status changes."],
  ["RETURN_STATUS_CHANGE", "65030162bb2a4d028d50cc51", "Triggers when an order's return status changes."],
  ["REVERSE_STATUS_UPDATE", "63fd7459715d622a338c5437", "Triggers when a buyer raises cancellation/refund-only/return&refund requests needing seller action. Linked to the older partner.tiktokshop.com/doc/ page: relation to RETURN_STATUS_CHANGE / CANCELLATION_STATUS_CHANGE unclear."],
  ["PRODUCT_STATUS_CHANGE", "650956aff1fd3102b90b6261", "Triggers when product audit results are updated."],
  ["SELLER_DEAUTHORIZATION", "65095746defece02be4d749d", "Triggers when a seller is deauthorized."],
  ["UPCOMING_AUTHORIZATION_EXPIRATION", "6509579c0fcef602bf11312c", "Triggers 30 days before authorization expiration, daily at 0:00 until re-authorization."],
  ["NEW_CONVERSATION", "6614330bfe9fdc02e002abfd", "Triggers when a customer service agent joins or leaves a conversation."],
  ["NEW_MESSAGE", "66143486ef8a1202dc323258", "Triggers when a new message is sent in a customer service conversation."],
];
for (const [topic, pageId, trig] of TOPICS) {
  const legacy = topic === "REVERSE_STATUS_UPDATE";
  push({
    id: `webhook.${topic}`, capability: `Webhook topic ${topic}`, method: "POST", path: "(inbound to SmartOmni)", version: "-", phase: 5, host: "callback", kind: "real",
    source: [`${BUNDLE}: event/202309/webhooks event_type list`, legacy ? "https://partner.tiktokshop.com/doc/page/63fd7459715d622a338c5437 (legacy doc page, unreadable)" : docUrl(pageId) + " (payload page, unreadable)"],
    accessDate: DATE, scope: SCOPE, market: MARKET, versionChoice: "Topic name is official (OAS event_type list). Payload page version unknown.", oasVsDocv2: OAS_VS_DOCV2,
    status: "unverified", evidence: "official-oas (topic name and trigger text only)",
    verification: { schema: "secondary (envelope from Hookdeck; data{} per topic unknown)", requestParams: "n/a", bodyRequiredFields: "unknown", signing: "secondary (Hookdeck: HMAC-SHA256(app_secret, app_key + raw body) in Authorization header)", errorCodes: "n/a", scope: "unresolved", market: "unverified", docv2Diff: "not checked" },
    snapshot: null, schemaRef: "schemas/webhook-envelope.json", requestSchemaRef: null, request: null, pagination: null, fixtures: "fixtures/webhook.json",
    blocker: blockerFor("Inbound payload (data{} fields), numeric 'type' value for this topic and webhook signature are NOT in the OAS; payload page " + (legacy ? "63fd7459715d622a338c5437 (legacy)" : pageId) + " unreadable. Envelope and signature are third-party (Hookdeck)."),
    notes: trig + (topic === "NEW_MESSAGE" ? " A customer-service new-message topic DOES exist (answers the open question); NEW_CONVERSATION is separate." : ""),
  });
}

const doc = {
  manifestVersion: "0.2.0",
  accessDate: DATE,
  oasBundle: { name: BUNDLE, openapi: "3.0.0", paths: 405, server: "https://open-api.tiktokglobalshop.com", snapshotDir: "snapshots/oas/" },
  summary: "Phase 01 second pass (2026-10-14). The official OAS bundle (tts-openapi-guide, 0.1.7) is now the schema source for 32 shop-API operations. Partner Center docv2 is still unreadable (client-rendered SPA), so token/authorization/signing/webhook-payload/error-code/scope pages were not read. Therefore NO operation is promoted to supported: the gates listed in statusLegend.supported are not all met.",
  statusLegend: {
    supported: "ALL of: official schema (shape) + required fields + request signing verified against the official Common Parameters page + documented error codes + scope + VN applicability; none met yet",
    unverified: "path/version from the official OAS (evidence 'official-oas') or only from baseline/secondary sources; adapter may be built to the OAS shape but must not claim TikTok compatibility. 'verification' shows what is still missing.",
    unsupported: "no verified path or deliberately locked; simulator must return not-implemented, never fake success",
  },
  apiKinds: {
    real: "TikTok Shop OpenAPI (never called by the simulator)",
    demo: "/demo/* simulator scenario API",
    test: "/test-admin/* simulator control API",
  },
  hosts: {
    openapi: "https://open-api.tiktokglobalshop.com (official: OAS servers[0] and the TTS Open Toolkit)",
    auth: "https://auth.tiktok-shops.com (secondary: third-party docs; not in the OAS)",
    callback: "SmartOmni webhook URL",
  },
  commonRequest: {
    note: "Common query/header parameters. Per-operation parameters are in each operation's 'request.params'.",
    queryAlwaysSent: ["app_key", "timestamp", "sign"],
    queryAlsoSent: ["shop_cipher (OAS: optional on every shop API; 'incorrect response for cross-border shops' if missing; need for a VN local shop unverified)"],
    headers: ["x-tts-access-token (required in every OAS operation)", "Content-Type: application/json (required in OAS; multipart/form-data for uploads)"],
    evidence: "headers/shop_cipher: official OAS; app_key/timestamp/sign: toolkit local-broker signer (indirect) + secondary; Common Parameters page unread",
  },
  operations,
};
writeFileSync(join(root, "manifest.json"), JSON.stringify(doc, null, 2) + "\n");
const counts = operations.reduce((a, o) => ((a[o.status] = (a[o.status] ?? 0) + 1), a), {});
console.log(operations.length, "operations", counts);
