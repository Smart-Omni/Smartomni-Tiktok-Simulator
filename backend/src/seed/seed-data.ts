import { createHash } from 'crypto';
import fashionCatalog from './fashion-catalog.json';

/** Deterministic UUID-shaped id derived from a stable name, so reset + reseed yields the same ids. */
export function detId(name: string): string {
  const h = createHash('sha1').update(`smartomni-tiktok-simulator:${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Numeric-looking marketplace id (TikTok ids are numeric strings), deterministic per name. */
export function numericId(prefix: string, name: string): string {
  const h = createHash('sha1').update(`smartomni-tiktok-simulator:${name}`).digest('hex');
  return prefix + (BigInt('0x' + h.slice(0, 12)) % 1_000_000_000_000_000n).toString().padStart(15, '0');
}

export interface SeedSku {
  /** Marketplace SKU id; defaults to `sim-sku-<shopKey>-<code>`. Set explicitly to reuse the same id in two shops. */
  externalId?: string;
  code: string;
  name: string;
  priceVnd: number;
  stock: [number, number]; // per warehouse (HN, HCM)
}
export interface SeedProduct {
  /** Marketplace product id; defaults to `sim-product-<code>`. */
  externalId?: string;
  status?: string;
  code: string;
  title: string;
  description: string;
  /** Listing fields (same meaning as the Create Product body). Written only when the product row is first created. */
  listing?: {
    categoryId?: string;
    brandId?: string;
    mainImages?: { uri: string }[];
    packageWeight?: { value: string; unit: string };
    productAttributes?: unknown[];
    isCodAllowed?: boolean;
    externalProductId?: string;
  };
  skus: SeedSku[];
}
export interface SeedBuyer {
  code: string;
  name: string;
  phone: string;
  addressLine: string;
  district: string;
  city: string;
}
export interface SeedShop {
  key: string;
  tiktokShopId: string;
  shopCipher: string;
  name: string;
  seller: { openId: string; name: string; email: string };
  warehouses: { code: string; name: string; city: string; isDefault: boolean }[];
  buyers: SeedBuyer[];
  products: SeedProduct[];
}

/** Password of every demo sign-in account. */
export const DEMO_PASSWORD = '123';

/** Gmail-style login of a demo account, from the person's name: "Đặng Minh Quân" -> dangminhquan.ttsim@gmail.com. */
export function demoLoginEmail(name: string): string {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd');
  return `${ascii.toLowerCase().replace(/[^a-z0-9]/g, '')}.ttsim@gmail.com`;
}

// All data below is fake. Ids look TikTok-like but are not real shop identifiers.
export const SEED_SHOPS: SeedShop[] = [
  {
    key: 'a',
    tiktokShopId: '7494000000000000001',
    shopCipher: 'GCP_SIM_SHOP_A_FAKE_CIPHER',
    name: 'Cửa hàng Mộc Lan',
    seller: { openId: 'sim-seller-open-id-a', name: 'Nguyễn Thị Lan', email: 'seller.a@simulator.local' },
    warehouses: [
      { code: 'WH-HN', name: 'Kho Hà Nội', city: 'Hà Nội', isDefault: true },
      { code: 'WH-HCM', name: 'Kho TP.HCM', city: 'Hồ Chí Minh', isDefault: false },
    ],
    buyers: [
      { code: 'a-1', name: 'Trần Văn An', phone: '0900000001', addressLine: '12 Lê Lợi', district: 'Quận 1', city: 'Hồ Chí Minh' },
      { code: 'a-2', name: 'Lê Thu Hà', phone: '0900000002', addressLine: '45 Trần Phú', district: 'Hà Đông', city: 'Hà Nội' },
      { code: 'a-3', name: 'Phạm Quốc Bảo', phone: '0900000003', addressLine: '8 Nguyễn Huệ', district: 'Hải Châu', city: 'Đà Nẵng' },
    ],
    products: [
      {
        code: 'a-tee',
        title: 'Áo thun cotton basic',
        description: 'Áo thun cotton 100%, nhiều size.',
        skus: [
          { code: 'TEE-WHT-M', name: 'Trắng / M', priceVnd: 129000, stock: [40, 25] },
          { code: 'TEE-WHT-L', name: 'Trắng / L', priceVnd: 129000, stock: [30, 20] },
          { code: 'TEE-BLK-M', name: 'Đen / M', priceVnd: 135000, stock: [35, 15] },
        ],
      },
      {
        code: 'a-bottle',
        title: 'Bình giữ nhiệt 500ml',
        description: 'Inox 304, giữ nhiệt 12 giờ.',
        skus: [{ code: 'BTL-500-SLV', name: 'Bạc 500ml', priceVnd: 259000, stock: [60, 40] }],
      },
      {
        code: 'a-bag',
        title: 'Túi tote canvas',
        description: 'Túi vải canvas in họa tiết.',
        skus: [
          { code: 'BAG-NAT', name: 'Màu tự nhiên', priceVnd: 99000, stock: [50, 50] },
          { code: 'BAG-NVY', name: 'Xanh navy', priceVnd: 105000, stock: [20, 10] },
        ],
      },
      // Same marketplace product/SKU ids exist in shop B with different data: mapping must be keyed by connection + id.
      {
        code: 'a-shared',
        externalId: 'sim-product-shared-1',
        title: 'Sổ tay bìa cứng (shop A)',
        description: 'Sản phẩm dùng chung ID với shop B để kiểm tra cô lập mapping.',
        skus: [{ code: 'SHARED-1', externalId: 'sim-sku-shared-1', name: 'A5', priceVnd: 50000, stock: [10, 10] }],
      },
      {
        code: 'a-hidden',
        status: 'SELLER_DEACTIVATED',
        title: 'Móc khóa gỗ (đang ẩn)',
        description: 'Seller đã ẩn sản phẩm.',
        skus: [{ code: 'KEY-WOOD', name: 'Gỗ sồi', priceVnd: 35000, stock: [5, 5] }],
      },
      {
        code: 'a-deleted',
        status: 'DELETED',
        title: 'Ốp lưng cũ (đã xóa)',
        description: 'Sản phẩm đã xóa mềm.',
        skus: [{ code: 'CASE-OLD', name: 'Đen', priceVnd: 79000, stock: [0, 0] }],
      },
    ],
  },
  {
    key: 'b',
    tiktokShopId: '7494000000000000002',
    shopCipher: 'GCP_SIM_SHOP_B_FAKE_CIPHER',
    name: 'Tiệm Gốm Bát Tràng',
    seller: { openId: 'sim-seller-open-id-b', name: 'Đặng Minh Quân', email: 'seller.b@simulator.local' },
    warehouses: [
      { code: 'WH-HN', name: 'Kho Bát Tràng', city: 'Hà Nội', isDefault: true },
      { code: 'WH-DN', name: 'Kho Đà Nẵng', city: 'Đà Nẵng', isDefault: false },
    ],
    buyers: [
      { code: 'b-1', name: 'Võ Thị Mai', phone: '0911000001', addressLine: '3 Hai Bà Trưng', district: 'Hoàn Kiếm', city: 'Hà Nội' },
      { code: 'b-2', name: 'Hoàng Đức Long', phone: '0911000002', addressLine: '77 Nguyễn Văn Linh', district: 'Thanh Khê', city: 'Đà Nẵng' },
    ],
    products: [
      {
        code: 'b-mug',
        title: 'Cốc sứ vẽ tay',
        description: 'Cốc gốm Bát Tràng vẽ tay, 300ml.',
        skus: [
          { code: 'MUG-BLU', name: 'Họa tiết xanh', priceVnd: 89000, stock: [70, 30] },
          { code: 'MUG-RED', name: 'Họa tiết đỏ', priceVnd: 89000, stock: [55, 25] },
        ],
      },
      {
        code: 'b-vase',
        title: 'Bình hoa men rạn',
        description: 'Bình hoa men rạn cao 25cm.',
        skus: [{ code: 'VASE-25', name: 'Cao 25cm', priceVnd: 349000, stock: [15, 8] }],
      },
      {
        code: 'b-set',
        title: 'Bộ ấm chén trà',
        description: 'Bộ ấm trà 1 ấm 6 chén.',
        skus: [{ code: 'TEA-SET-6', name: 'Bộ 6 chén', priceVnd: 599000, stock: [10, 5] }],
      },
      {
        code: 'b-shared',
        externalId: 'sim-product-shared-1',
        title: 'Đĩa sứ trắng (shop B)',
        description: 'Cùng product/SKU ID với shop A nhưng là hàng khác.',
        skus: [{ code: 'SHARED-1', externalId: 'sim-sku-shared-1', name: 'Ø20cm', priceVnd: 75000, stock: [12, 4] }],
      },
      {
        code: 'b-dup',
        title: 'Lọ cắm hoa mini (trùng seller SKU)',
        description: 'Hai biến thể dùng chung một seller SKU để kiểm tra xử lý ghép SKU trùng.',
        skus: [
          { code: 'DUP-1', externalId: 'sim-sku-b-dup-1', name: 'Xanh', priceVnd: 59000, stock: [9, 1] },
          { code: 'DUP-1', externalId: 'sim-sku-b-dup-2', name: 'Hồng', priceVnd: 61000, stock: [7, 2] },
        ],
      },
    ],
  },
];

// Fashion catalog: the three Shopee-simulator shops re-created as TikTok shops (same names). Products come from
// fashion-catalog.json; ids derive from the Shopee item id, so seeding is idempotent (upsert, never duplicates).
const FASHION_SHOPS = [
  { tiktokShopId: '7494000000000000003', cipher: 'GCP_SIM_SHOP_C_FAKE_CIPHER', seller: 'Phạm Gia Huy', warehouses: [['Kho Hà Nội', 'Hà Nội'], ['Kho TP.HCM', 'Hồ Chí Minh']],
    buyers: [
      ['Nguyễn Minh Khôi', '21 Lý Thường Kiệt', 'Quận 10', 'Hồ Chí Minh'],
      ['Trịnh Bảo Ngọc', '9 Hàng Bài', 'Hoàn Kiếm', 'Hà Nội'],
    ] },
  { tiktokShopId: '7494000000000000004', cipher: 'GCP_SIM_SHOP_D_FAKE_CIPHER', seller: 'Ngô Thanh Tùng', warehouses: [['Kho Hà Nội', 'Hà Nội'], ['Kho Đà Nẵng', 'Đà Nẵng']],
    buyers: [
      ['Phan Gia Huy', '45 Bạch Đằng', 'Hải Châu', 'Đà Nẵng'],
      ['Đỗ Thanh Hương', '18 Nguyễn Trãi', 'Ninh Kiều', 'Cần Thơ'],
    ] },
  { tiktokShopId: '7494000000000000005', cipher: 'GCP_SIM_SHOP_E_FAKE_CIPHER', seller: 'Bùi Ngọc Anh', warehouses: [['Kho TP.HCM', 'Hồ Chí Minh'], ['Kho Cần Thơ', 'Cần Thơ']],
    buyers: [
      ['Bùi Quang Vinh', '33 Lạch Tray', 'Ngô Quyền', 'Hải Phòng'],
      ['Lý Ngọc Trâm', '7 Lê Lợi', 'Phú Hội', 'Huế'],
    ] },
];

export const FASHION_SHOPS_SEED: SeedShop[] = fashionCatalog.shops.map((src, idx): SeedShop => {
  const f = FASHION_SHOPS[idx];
  const key = src.key;
  return {
    key,
    tiktokShopId: f.tiktokShopId,
    shopCipher: f.cipher,
    name: src.name,
    seller: { openId: `sim-seller-open-id-${key}`, name: f.seller, email: `seller.${key}@simulator.local` },
    warehouses: f.warehouses.map(([name, city], i) => ({ code: i === 0 ? 'WH-1' : 'WH-2', name, city, isDefault: i === 0 })),
    buyers: f.buyers.map(([name, addressLine, district, city], i): SeedBuyer => ({
      code: `${key}-${i + 1}`,
      name,
      phone: `09${idx}000000${i + 1}`,
      addressLine,
      district,
      city,
    })),
    products: src.products.map((p): SeedProduct => ({
      code: `fashion-${p.sourceItemId}`,
      externalId: numericId('7500', `fashion:${key}:${p.sourceItemId}`),
      title: p.title,
      description: p.description,
      listing: {
        categoryId: p.categoryId,
        brandId: p.brandId,
        mainImages: p.mainImages,
        packageWeight: p.packageWeight,
        productAttributes: p.productAttributes,
        isCodAllowed: p.isCodAllowed,
        externalProductId: p.externalProductId,
      },
      skus: p.skus.map((k): SeedSku => ({
        code: k.code,
        externalId: numericId('7510', `fashion-sku:${key}:${k.code}`),
        name: k.name,
        priceVnd: k.priceVnd,
        stock: [k.stock[0], k.stock[1]],
      })),
    })),
  };
});
SEED_SHOPS.push(...FASHION_SHOPS_SEED);

export const SEED_SCENARIOS = [
  { key: 'default', name: 'Default (no faults)', description: 'Baseline behaviour, no injected failures.', config: {} },
  {
    key: 'webhook-flaky-receiver',
    name: 'Flaky webhook receiver',
    description: 'Intended for Phase 05: first deliveries fail, forcing retry/backoff.',
    config: { webhook: { failFirstAttempts: 2 } },
  },
];
