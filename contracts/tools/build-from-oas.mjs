// Regenerates contracts/snapshots/oas, contracts/schemas/ops and contracts/fixtures/ops from the
// bundled official OAS (skill tts-openapi-guide, shipped with @tts-open-toolkit/cli).
// Read-only: it never calls TikTok. Usage (from contracts/):
//   node tools/build-from-oas.mjs <oasDir> <bundleVersion> <accessDate>
// e.g. node tools/build-from-oas.mjs ~/.claude/skills/tts-openapi-guide/references/oas 0.1.7 2026-10-14
// The manifest is edited by hand / by tools/apply-manifest.mjs; this script only owns generated artifacts.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [oasDir, bundleVersion = "unknown", accessDate = "unknown"] = process.argv.slice(2);
if (!oasDir) throw new Error("usage: build-from-oas.mjs <oasDir> <bundleVersion> <accessDate>");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** id -> [oasFile, path, method]. Paths are the versions SELECTED after comparing candidates (see manifest). */
export const OPS = {
  "auth.shops": ["authorization", "/authorization/202309/shops", "get"],
  "product.search": ["product", "/product/202502/products/search", "post"],
  "product.detail": ["product", "/product/202309/products/{product_id}", "get"],
  "product.media_upload": ["product", "/product/202309/images/upload", "post"],
  "product.file_upload": ["product", "/product/202309/files/upload", "post"],
  "logistics.warehouses": ["logistics", "/logistics/202309/warehouses", "get"],
  "product.inventory_update": ["product", "/product/202309/products/{product_id}/inventory/update", "post"],
  "order.search": ["order", "/order/202309/orders/search", "post"],
  "order.detail": ["order", "/order/202507/orders", "get"],
  "fulfillment.tracking": ["fulfillment", "/fulfillment/202309/orders/{order_id}/tracking", "get"],
  "fulfillment.shipping_documents": ["fulfillment", "/fulfillment/202309/packages/{package_id}/shipping_documents", "get"],
  "fulfillment.package_detail": ["fulfillment", "/fulfillment/202309/packages/{package_id}", "get"],
  "fulfillment.package_ship": ["fulfillment", "/fulfillment/202309/packages/{package_id}/ship", "post"],
  "return.search": ["return_refund", "/return_refund/202309/returns/search", "post"],
  "return.approve": ["return_refund", "/return_refund/202309/returns/{return_id}/approve", "post"],
  "return.reject": ["return_refund", "/return_refund/202309/returns/{return_id}/reject", "post"],
  "return.records": ["return_refund", "/return_refund/202309/returns/{return_id}/records", "get"],
  "return.reject_reasons": ["return_refund", "/return_refund/202309/reject_reasons", "get"],
  "return.aftersale_eligibility": ["return_refund", "/return_refund/202512/orders/{order_id}/aftersale_eligibility", "get"],
  "cancellation.search": ["return_refund", "/return_refund/202309/cancellations/search", "post"],
  "cancellation.approve": ["return_refund", "/return_refund/202309/cancellations/{cancel_id}/approve", "post"],
  "cancellation.reject": ["return_refund", "/return_refund/202309/cancellations/{cancel_id}/reject", "post"],
  "cs.conversations": ["customer_service", "/customer_service/202309/conversations", "get"],
  "cs.messages": ["customer_service", "/customer_service/202309/conversations/{conversation_id}/messages", "get"],
  "cs.conversation_detail": ["customer_service", "/customer_service/202601/conversations/{conversation_id}", "get"],
  "cs.send_message_202309": ["customer_service", "/customer_service/202309/conversations/{conversation_id}/messages", "post"],
  "cs.image_upload": ["customer_service", "/customer_service/202309/images/upload", "post"],
  "promotion.coupon_search": ["promotion", "/promotion/202406/coupons/search", "post"],
  "promotion.coupon_detail": ["promotion", "/promotion/202406/coupons/{coupon_id}", "get"],
  "event.webhooks_get": ["event", "/event/202309/webhooks", "get"],
  "event.webhooks_put": ["event", "/event/202309/webhooks", "put"],
  "event.webhooks_delete": ["event", "/event/202309/webhooks", "delete"],
  "product.category_attributes": ["product", "/product/202309/categories/{category_id}/attributes", "get"],
  "product.category_rules": ["product", "/product/202309/categories/{category_id}/rules", "get"],
  "product.update_price": ["product", "/product/202309/products/{product_id}/prices/update", "post"],
  "product.inventory_search": ["product", "/product/202309/inventory/search", "post"],
  "product.delete": ["product", "/product/202309/products", "delete"],
  "product.recover": ["product", "/product/202309/products/recover", "post"],
  "fulfillment.package_search": ["fulfillment", "/fulfillment/202309/packages/search", "post"],
  "fulfillment.package_batch_ship": ["fulfillment", "/fulfillment/202309/packages/ship", "post"],
  "return.create": ["return_refund", "/return_refund/202309/returns", "post"],
  "return.refund_calculate": ["return_refund", "/return_refund/202309/refunds/calculate", "post"],
  "cancellation.seller_cancel": ["return_refund", "/return_refund/202309/cancellations", "post"],
  "cs.read_message": ["customer_service", "/customer_service/202309/conversations/{conversation_id}/messages/read", "post"],
  "cs.create_conversation": ["customer_service", "/customer_service/202309/conversations", "post"],
  "fulfillment.handover_slots": ["fulfillment", "/fulfillment/202309/packages/{package_id}/handover_time_slots", "get"],
  "fulfillment.shipping_info_update": ["fulfillment", "/fulfillment/202309/packages/{package_id}/shipping_info/update", "post"],
  "fulfillment.package_deliver": ["fulfillment", "/fulfillment/202309/packages/deliver", "post"],
  "logistics.delivery_options": ["logistics", "/logistics/202309/warehouses/{warehouse_id}/delivery_options", "get"],
  "logistics.shipping_providers": ["logistics", "/logistics/202309/delivery_options/{delivery_option_id}/shipping_providers", "get"],
  "order.price_detail": ["order", "/order/202407/orders/{order_id}/price_detail", "get"],
  "cs.agent_settings_get": ["customer_service", "/customer_service/202309/agents/settings", "get"],
  "cs.agent_settings_put": ["customer_service", "/customer_service/202309/agents/settings", "put"],
  "auth.deauthorize": ["authorization", "/authorization/202403/shops", "delete"],
  "product.partial_edit": ["product", "/product/202509/products/{product_id}/partial_edit", "post"],
};

const files = {};
const oas = (f) => (files[f] ??= JSON.parse(readFileSync(join(oasDir, "paths", `${f}.json`), "utf8")));
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
// Doc examples in the OAS contain expired CDN URLs with signature/authkey query values; redact them (defence in depth).
const redact = (txt) => txt.replace(/(x-tos-(?:signature|authkey)|x-signature)=[^&"\\\s]+/g, "$1=REDACTED");
const write = (rel, data) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, redact(JSON.stringify(data, null, 2)) + "\n"); };

/** Every operation in the bundle with the same OperationId-like summary = same capability candidates. */
function candidatesFor(summary) {
  const out = [];
  for (const f of Object.keys(JSON.parse(readFileSync(join(oasDir, "index.json"), "utf8")).modules.reduce((a, m) => ({ ...a, [m.first_level_path]: 1 }), {}))) {
    for (const [p, item] of Object.entries(oas(f).paths)) for (const [m, o] of Object.entries(item)) if (o.summary === summary) out.push({ method: m.toUpperCase(), path: p, version: p.split("/")[2] });
  }
  return out.sort((a, b) => a.version.localeCompare(b.version));
}

/** OAS schema -> the validator's JSON-Schema subset. The OAS has no "required" arrays, so none are emitted. */
function convert(s) {
  if (!s) return {};
  const out = {};
  const t = s.type ?? (s.properties ? "object" : s.items ? "array" : undefined);
  if (t) out.type = t;
  if (s.enum) out.enum = s.enum;
  if (s["x-sample"] !== undefined) out["x-sample"] = s["x-sample"];
  if (s.properties) { out.properties = {}; for (const [k, v] of Object.entries(s.properties)) out.properties[k] = convert(v); }
  if (s.items) out.items = convert(s.items);
  return out;
}

/** Deterministic synthetic instance. Prefers the OAS example when it matches the declared type. */
function sample(s, raw, key = "", depth = 0, mode = "success") {
  const t = s.type;
  if (s["x-sample"] !== undefined) return s["x-sample"];
  if (s.enum) return s.enum[0];
  if (t === "object" || s.properties) {
    if (depth > 7) return {};
    const o = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) o[k] = sample(v, raw?.properties?.[k] ?? {}, k, depth + 1, mode);
    return o;
  }
  if (t === "array") {
    if (mode === "empty") return [];
    return [sample(s.items ?? {}, raw?.items ?? {}, key, depth + 1, mode)];
  }
  if (t === "integer" || t === "number") {
    const ex = raw?.example; const n = typeof ex === "number" ? ex : Number(ex);
    return mode === "empty" && /count|total/.test(key) ? 0 : Number.isFinite(n) && ex !== undefined && ex !== "" ? n : 1;
  }
  if (t === "boolean") return false;
  if (t === "string") {
    if (key === "next_page_token") return mode === "multi_last" ? "" : mode === "multi_first" ? "TEST_PAGE_TOKEN_2" : "";
    return `TEST_${key || "value"}`;
  }
  return null;
}

/** Hand overlays on top of the generated shape. Each must say why it exists. */
const OVERLAYS = {
  // seller_type values are documented in the OAS description text ("Possible values"); the six item fields are what the
  // SmartOmni adapter needs (SmartOmni requirement, NOT an OAS required flag - OAS has none).
  "auth.shops": (sch) => {
    const data = sch.properties.data; data.required = ["shops"];
    const item = data.properties.shops.items;
    item.required = ["cipher", "code", "id", "name", "region", "seller_type"];
    item.properties.seller_type.enum = ["CROSS_BORDER", "LOCAL"];
    item.properties.id["x-sample"] = "7000000000000000001"; item.properties.id.pattern = "^[0-9]+$";
    sch["x-adapterRequired"] = "data.shops[].{cipher,code,id,name,region,seller_type} are required by SmartOmni's adapter, not by an OAS required flag.";
  },
};
const EXTRA_CASES = {
  "auth.shops": [{ case: "local_shop_region_vn_unverified", note: "Synthetic. 'VN' as a shop region code is NOT documented in the OAS (region is a free string with example GB); no claim that a real VN shop is granted access.", response: { code: 0, message: "Success", request_id: "TEST-auth.shops-vn", data: { shops: [{ cipher: "TEST_CIPHER_VN", code: "TESTVN000001", id: "7000000000000000002", name: "Test VN Shop", region: "VN", seller_type: "LOCAL" }] } }, expect: "valid" }],
};

for (const d of ["snapshots/oas", "schemas/ops", "fixtures/ops"]) rmSync(join(root, d), { recursive: true, force: true });
const summaryRows = [];
for (const [id, [file, path, method]] of Object.entries(OPS)) {
  const op = oas(file).paths[path]?.[method];
  if (!op) throw new Error(`${id}: ${method} ${path} not in OAS`);
  const sha = createHash("sha256").update(canon(op)).digest("hex");
  const cands = candidatesFor(op.summary);
  write(`snapshots/oas/${id}.json`, {
    _meta: {
      source: "tts-openapi-guide bundled OAS (OpenAPI 3.0.0, server https://open-api.tiktokglobalshop.com)",
      bundledWith: `@tts-open-toolkit/cli ${bundleVersion}`,
      oasFile: `references/oas/paths/${file}.json`,
      accessDate,
      sha256OfCanonicalOperation: sha,
      candidatesInBundle: cands,
      note: "Verbatim OAS operation object (descriptions/examples included); sha256OfCanonicalOperation hashes the UNREDACTED bundle operation (expired CDN signature values are redacted in this file). Contains no secrets. docv2 pages could not be read (client-rendered SPA), so docv2 differences are UNKNOWN.",
    },
    method: method.toUpperCase(),
    path,
    operation: op,
  });

  const params = (op.parameters ?? []).map((p) => ({ in: p.in, name: p.name, required: !!p.required, type: p.schema?.type ?? null, format: p.schema?.format ?? null, description: (p.description ?? "").replace(/\s+/g, " ").trim() }));
  const bodyRaw = op.requestBody?.content?.["application/json"]?.schema ?? null;
  const multipart = op.requestBody?.content && Object.keys(op.requestBody.content).some((c) => c.startsWith("multipart"));
  const respRaw = op.responses?.["200"]?.content?.["application/json"]?.schema ?? {};
  const resp = convert(respRaw);
  resp.required = ["code", "message", "request_id"];
  const respSchema = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `ops/${id}.response.json`, title: `${method.toUpperCase()} ${path} response`, "x-verification": `official OAS ${bundleVersion} (${accessDate}); OAS declares no per-field required flags, so only the envelope trio code/message/request_id is required here (envelope trio taken from every OAS response schema)`, ...resp };
  OVERLAYS[id]?.(respSchema);
  write(`schemas/ops/${id}.response.json`, respSchema);
  if (bodyRaw) write(`schemas/ops/${id}.request.json`, { $schema: "https://json-schema.org/draft/2020-12/schema", $id: `ops/${id}.request.json`, title: `${method.toUpperCase()} ${path} request body`, "x-verification": `official OAS ${bundleVersion}; OAS declares no required body fields (unknown which are mandatory)`, ...convert(bodyRaw) });

  // pagination facts straight from the operation
  const pp = params.filter((p) => /^page_|^cursor/.test(p.name));
  const data = respRaw.properties?.data?.properties ?? {};
  const respPag = ["next_page_token", "total_count", "next_cursor", "has_more"].filter((k) => k in data);
  const pagination = pp.length || respPag.length ? { requestParams: pp.map((p) => ({ in: p.in, name: p.name, required: p.required, description: p.description })), responseFields: respPag } : null;

  // fixtures (synthetic, generated from the official OAS shape)
  const base = respSchema;
  const mk = (mode) => { const r = sample(base, respRaw, "", 0, mode); r.code = 0; r.message = "Success"; r.request_id = `TEST-${id}-${mode}`; return r; };
  const cases = [{ case: "success", response: mk("success"), expect: "valid" }];
  const hasList = JSON.stringify(respRaw).includes('"type":"array"');
  if (hasList) cases.push({ case: "empty", response: mk("empty"), expect: "valid" });
  if (pagination && respPag.includes("next_page_token")) {
    const first = mk("multi_first"); if (first.data && "total_count" in first.data) first.data.total_count = 2;
    cases.push({ case: "multi_page_first", request: { query: { page_size: "1" } }, response: first, expect: "valid" });
    const last = mk("multi_last"); if (last.data && "total_count" in last.data) last.data.total_count = 2;
    cases.push({ case: "multi_page_last", request: { query: { page_size: "1", page_token: "TEST_PAGE_TOKEN_2" } }, response: last, expect: "valid" });
  }
  const requiredQuery = params.filter((p) => p.required && p.in === "query").map((p) => p.name);
  const trigger = requiredQuery.length ? `omit required query parameter '${requiredQuery[0]}'` : bodyRaw ? "send a body that is not valid JSON or has a wrongly typed field" : "send a malformed path parameter";
  write(`fixtures/ops/${id}.json`, {
    operation: id,
    schema: `schemas/ops/${id}.response.json`,
    classification: "synthetic-from-official-oas",
    note: "Values are synthetic and generated from the official OAS response shape; they are not captured TikTok traffic. Error cases are TEST FAULTS: no readable official source documents their code/message values.",
    cases: [
      ...cases,
      ...(EXTRA_CASES[id] ?? []),
      { case: "invalid_input", classification: "test_fault_undocumented", trigger, requestMustFailValidation: requiredQuery.length > 0 },
      { case: "token_expired", classification: "test_fault_undocumented", trigger: "x-tts-access-token is past its expiry" },
      { case: "missing_scope", classification: "test_fault_undocumented", trigger: "app lacks the (unverified) scope of this operation" },
    ],
  });
  summaryRows.push({ id, method: method.toUpperCase(), path, sha, pagination, multipart, params, hasBody: !!bodyRaw, candidates: cands.map((c) => `${c.method} ${c.version}`) });
}
write("snapshots/oas-extract.json", { bundledWith: `@tts-open-toolkit/cli ${bundleVersion}`, accessDate, operations: summaryRows });
console.log(`wrote ${summaryRows.length} operations`);
