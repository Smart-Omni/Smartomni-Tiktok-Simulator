/*
 * Delete this folder when the backend provides these fields.
 * GET /demo/identities has no city; these mirror backend/src/seed/seed-data.ts (buyer address city,
 * seller default warehouse city), keyed by normalized name.
 */
import { normalizeTitle } from './enrich';

const cityByName: Record<string, string> = {
  // buyers
  'tran van an': 'Ho Chi Minh City',
  'le thu ha': 'Hanoi',
  'pham quoc bao': 'Da Nang',
  'vo thi mai': 'Hanoi',
  'hoang duc long': 'Da Nang',
  // sellers
  'nguyen thi lan': 'Hanoi',
  'dang minh quan': 'Hanoi',
};

/** City shown next to a demo identity on the sign-in page, or undefined when unknown. */
export const identityCity = (name: string): string | undefined => cityByName[normalizeTitle(name)];

/** Buyer preselected on the sign-in page (seed buyer of "Cửa hàng Mộc Lan"). */
export const defaultBuyerName = 'Trần Văn An';

/** Seed shop that sells the mock catalog items without a `seedShop`. */
export const defaultMockShop = 'Cửa hàng Mộc Lan';
