/*
 * Delete this folder when the backend provides these fields.
 * Mock merchandising data (prices before discount, ratings, sold counts, image tiles) and a
 * public catalog for guests, which the /demo API does not provide.
 */
import type { StorefrontProduct } from '@/lib/types';

/** Fields the Tiptop Shop design shows that the backend does not have yet. */
export interface MockProductFields {
  originalPriceVnd: number;
  /** 0 when there is no discount. */
  discountPct: number;
  rating: number;
  sold: number;
  trending: boolean;
  /** Background of the image tile when there is no real photo. */
  imageBg: string;
  /** Slug of a mock category (categories.ts); undefined when unknown. */
  category?: string;
}

export type EnrichedProduct = StorefrontProduct &
  MockProductFields & {
    shopName?: string;
    /** Mock catalog only: title of the matching seeded product, so a signed-in buyer can be sent to the real one. */
    seedTitle?: string;
    /** Mock catalog only: seed shop that sells `seedTitle` (the sign-in page preselects one of its buyers). */
    seedShop?: string;
  };

export const imageBackgrounds = ['#FDE2E4', '#E2ECE9', '#FFF1E6', '#DFE7FD', '#F0EFEB', '#E6F4F3', '#FAEDCB', '#E8E1F5'];

/** Price before discount, rounded up to 1,000 VND. */
export const originalPrice = (priceVnd: number, discountPct: number) =>
  discountPct > 0 ? Math.ceil(priceVnd / (1 - discountPct / 100) / 1000) * 1000 : priceVnd;

interface SeedEntry {
  id: string;
  title: string;
  description: string;
  shopName: string;
  skus: { name: string; priceVnd: number; stock: number }[];
  discountPct: number;
  rating: number;
  sold: number;
  trending?: boolean;
  category: string;
  seedTitle?: string;
  seedShop?: string;
}

const entries: SeedEntry[] = [
  { id: 'mock-1', seedTitle: 'Áo thun cotton basic', seedShop: 'Cửa hàng Mộc Lan', title: 'Oversized cotton tee', description: '100% cotton, relaxed fit, pre-washed.', shopName: 'Demo Shop VN', skus: [{ name: 'White / M', priceVnd: 129000, stock: 40 }, { name: 'White / L', priceVnd: 129000, stock: 0 }, { name: 'Black / M', priceVnd: 135000, stock: 12 }], discountPct: 35, rating: 4.8, sold: 2400, trending: true, category: 'womenswear' },
  { id: 'mock-2', seedTitle: 'Bình giữ nhiệt 500ml', seedShop: 'Cửa hàng Mộc Lan', title: 'Insulated water bottle 500ml', description: 'Keeps drinks cold for 24h and hot for 12h.', shopName: 'Demo Shop VN', skus: [{ name: 'Sage', priceVnd: 189000, stock: 25 }, { name: 'Sand', priceVnd: 189000, stock: 8 }], discountPct: 20, rating: 4.9, sold: 1300, category: 'sports-outdoor' },
  { id: 'mock-3', seedTitle: 'Túi tote canvas', seedShop: 'Cửa hàng Mộc Lan', title: 'Canvas tote bag', description: 'Heavy canvas with an inner pocket.', shopName: 'Demo Shop VN', skus: [{ name: 'Natural', priceVnd: 99000, stock: 60 }], discountPct: 15, rating: 4.7, sold: 870, category: 'luggage-bags' },
  { id: 'mock-4', seedTitle: 'Cốc sứ vẽ tay', seedShop: 'Tiệm Gốm Bát Tràng', title: 'Hand-painted ceramic mug', description: 'Each mug is painted by hand; colors vary slightly.', shopName: 'Demo Shop VN', skus: [{ name: 'Blue floral', priceVnd: 145000, stock: 14 }, { name: 'Red floral', priceVnd: 145000, stock: 0 }], discountPct: 25, rating: 4.8, sold: 640, trending: true, category: 'kitchenware' },
  { id: 'mock-5', seedTitle: 'Sổ tay bìa cứng (shop A)', seedShop: 'Cửa hàng Mộc Lan', title: 'Hardcover notebook A5', description: '160 dotted pages, lay-flat binding.', shopName: 'Demo Shop VN', skus: [{ name: 'Dotted', priceVnd: 69000, stock: 100 }, { name: 'Lined', priceVnd: 69000, stock: 80 }], discountPct: 0, rating: 4.6, sold: 3100, category: 'home-supplies' },
  { id: 'mock-6', seedTitle: 'Bình hoa men rạn', seedShop: 'Tiệm Gốm Bát Tràng', title: 'Crackle-glaze flower vase', description: 'Stoneware vase, 18 cm tall.', shopName: 'Demo Shop VN', skus: [{ name: 'Ivory', priceVnd: 259000, stock: 6 }], discountPct: 10, rating: 4.9, sold: 210, category: 'home-supplies' },
  { id: 'mock-7', seedTitle: 'Bộ ấm chén trà', seedShop: 'Tiệm Gốm Bát Tràng', title: 'Tea set for two', description: 'Teapot with two cups, porcelain.', shopName: 'Demo Shop VN', skus: [{ name: 'White', priceVnd: 349000, stock: 9 }, { name: 'Celadon', priceVnd: 369000, stock: 4 }], discountPct: 30, rating: 4.7, sold: 450, category: 'kitchenware' },
  { id: 'mock-8', title: 'Wooden keychain', description: 'Laser-engraved beech wood.', shopName: 'Demo Shop VN', skus: [{ name: 'Heart', priceVnd: 39000, stock: 200 }, { name: 'Star', priceVnd: 39000, stock: 150 }], discountPct: 0, rating: 4.5, sold: 5200, category: 'fashion-accessories' },
  { id: 'mock-9', title: 'Linen bucket hat', description: 'Breathable linen blend, one size.', shopName: 'Demo Shop VN', skus: [{ name: 'Beige', priceVnd: 159000, stock: 30 }, { name: 'Olive', priceVnd: 159000, stock: 0 }], discountPct: 20, rating: 4.8, sold: 980, trending: true, category: 'fashion-accessories' },
  { id: 'mock-10', title: 'Minimal phone case', description: 'Matte finish, raised camera edge.', shopName: 'Demo Shop VN', skus: [{ name: 'iPhone 15', priceVnd: 119000, stock: 45 }, { name: 'iPhone 15 Pro', priceVnd: 119000, stock: 20 }], discountPct: 40, rating: 4.6, sold: 4100, category: 'phones-electronics' },
];

/** Public catalog shown to guests (no session, so the storefront API cannot be called). */
export const mockCatalog: EnrichedProduct[] = entries.map((e, i) => {
  const prices = e.skus.map((s) => s.priceVnd);
  const minPriceVnd = Math.min(...prices);
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    imageUrl: '',
    minPriceVnd,
    maxPriceVnd: Math.max(...prices),
    skus: e.skus.map((s, j) => ({ id: `${e.id}-sku-${j + 1}`, name: s.name, attributeName: 'Variant', priceVnd: s.priceVnd, available: s.stock > 0, stock: s.stock })),
    shopName: e.shopName,
    originalPriceVnd: originalPrice(minPriceVnd, e.discountPct),
    discountPct: e.discountPct,
    rating: e.rating,
    sold: e.sold,
    trending: e.trending ?? false,
    imageBg: imageBackgrounds[i % imageBackgrounds.length],
    category: e.category,
    seedTitle: e.seedTitle,
    seedShop: e.seedShop,
  };
});

/** Mock fields for the products created by the backend seed (backend/src/seed/seed-data.ts), keyed by normalized title. */
export const seedProductMocks: Record<string, Omit<MockProductFields, 'originalPriceVnd'>> = {
  'ao thun cotton basic': { discountPct: 35, rating: 4.8, sold: 2400, trending: true, imageBg: '#FDE2E4', category: 'womenswear' },
  'ao thun co tron': { discountPct: 20, rating: 4.7, sold: 1100, trending: false, imageBg: '#DFE7FD', category: 'menswear' },
  'basic tee': { discountPct: 15, rating: 4.6, sold: 760, trending: false, imageBg: '#F0EFEB', category: 'menswear' },
  'binh giu nhiet 500ml': { discountPct: 20, rating: 4.9, sold: 1300, trending: false, imageBg: '#E2ECE9', category: 'sports-outdoor' },
  'binh hoa men ran': { discountPct: 10, rating: 4.9, sold: 210, trending: false, imageBg: '#FAEDCB', category: 'home-supplies' },
  'bo am chen tra': { discountPct: 30, rating: 4.7, sold: 450, trending: true, imageBg: '#E6F4F3', category: 'kitchenware' },
  'coc su ve tay': { discountPct: 25, rating: 4.8, sold: 640, trending: true, imageBg: '#FFF1E6', category: 'kitchenware' },
  'tui tote canvas': { discountPct: 15, rating: 4.7, sold: 870, trending: false, imageBg: '#E8E1F5', category: 'luggage-bags' },
};
