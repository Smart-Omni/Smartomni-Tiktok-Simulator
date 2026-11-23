/** Formatting for the Tiptop Shop UI (the legacy pages keep `vnd()` from ./api). */

const vndNumber = new Intl.NumberFormat('vi-VN');
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** "₫129.000", as on the design boards. */
export const shopPrice = (n: number): string => `₫${vndNumber.format(n)}`;

/** 2400 -> "2.4K". */
export const compactCount = (n: number): string => compact.format(n);
