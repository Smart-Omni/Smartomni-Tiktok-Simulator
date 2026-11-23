/*
 * Delete this folder when the backend provides these fields.
 * Product categories for the Home "Categories" row: the /demo API has no categories, so products get one
 * through catalog.ts (mock catalog and seeded titles).
 */

export interface MockCategory {
  slug: string;
  name: string;
  /** Background of the round tile. */
  bg: string;
  /** Optional picture (e.g. /categories/shoes.png in frontend/public); an icon is shown while it is empty. */
  image?: string;
}

export const mockCategories: MockCategory[] = [
  { slug: 'mall', name: 'MALL', bg: '#eee' },
  { slug: 'womenswear', name: "Women's Clothing", bg: '#F4EFEA' },
  { slug: 'beauty', name: 'Beauty', bg: '#F7EEF0' },
  { slug: 'menswear', name: "Men's Clothing", bg: '#EFF0F2' },
  { slug: 'personal-care', name: 'Personal Care', bg: '#eee' },
  { slug: 'phones-electronics', name: 'Electronics', bg: '#EEF1F5' },
  { slug: 'baby', name: 'Baby', bg: '#eee' },
  { slug: 'groceries', name: 'Groceries', bg: '#eee' },
  { slug: 'shoes', name: 'Shoes', bg: '#F1F1F2' },
  { slug: 'sports-outdoor', name: 'Sports', bg: '#EAF3EE' },
  { slug: 'health', name: 'Health', bg: '#eee' },
  { slug: 'fashion-accessories', name: 'Accessories', bg: '#F5EFE6' },
  { slug: 'home-supplies', name: 'Household', bg: '#EAF2F8' },
  { slug: 'vehicle', name: 'Vehicle', bg: '#eee' },
  { slug: 'luggage-bags', name: 'Bags', bg: '#F1F0EE' },
  { slug: 'appliances', name: 'Appliances', bg: '#eee' },
  { slug: 'textiles', name: 'Textiles', bg: '#eee' },
  { slug: 'kid-wears', name: 'Kid Wears', bg: '#eee' },
  { slug: 'kitchenware', name: 'Kitchen', bg: '#F6F1E7' },
  { slug: 'toys', name: 'Toys', bg: '#eee' },
  { slug: 'pets-and-toys', name: 'Pets and Toys', bg: '#eee' },
];

export const categoryBySlug = (slug: string | null | undefined) => mockCategories.find((c) => c.slug === slug);
