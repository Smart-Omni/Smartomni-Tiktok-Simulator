import { randomInt } from 'crypto';

/** Upper-case letters and digits without the look-alikes 0/O and 1/I (32 symbols), so a code can be read out and typed without mistakes. */
export const PROMO_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 32^10 ≈ 1.1e15 codes; inside the OAS 6-12 letters/digits rule, so it always matches PROMO_CODE_PATTERN. */
export const GENERATED_CODE_LENGTH = 10;

/** `rand(max)` returns an integer in [0, max). Injectable so tests can force collisions. */
export type RandomInt = (max: number) => number;

export const cryptoRandomInt: RandomInt = (max) => randomInt(max);

export function generatePromoCode(rand: RandomInt = cryptoRandomInt): string {
  let code = '';
  for (let i = 0; i < GENERATED_CODE_LENGTH; i++) code += PROMO_CODE_ALPHABET[rand(PROMO_CODE_ALPHABET.length)];
  return code;
}
