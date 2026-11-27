import { createHash, scryptSync, timingSafeEqual } from 'crypto';

/**
 * Demo sign-in passwords, stored as `salt:scrypt`. The salt is derived from the login email so that re-seeding
 * writes the same value (the seed is idempotent); good enough for fake accounts, not for real ones.
 */
export function hashPassword(password: string, loginEmail: string): string {
  const salt = createHash('sha256').update(loginEmail).digest('hex').slice(0, 32);
  return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  const [salt, hex] = (stored ?? '').split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(password, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
