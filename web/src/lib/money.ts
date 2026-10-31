import { DEFAULT_CURRENCY } from './format';

/** Money is always an integer number of piasters (minor units). */
export function formatMoney(minor: number | null | undefined, currency = DEFAULT_CURRENCY): string {
  const value = Number.isFinite(minor) ? Number(minor) : 0;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${currency} ${whole.toLocaleString('en-US')}.${frac}`;
}

export function formatMoneyShort(minor: number | null | undefined, currency = DEFAULT_CURRENCY): string {
  const value = Number.isFinite(minor) ? Number(minor) : 0;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value) / 100;
  if (abs >= 1_000_000) return `${sign}${currency} ${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${sign}${currency} ${(abs / 1000).toFixed(1)}k`;
  return formatMoney(value, currency);
}

/**
 * Convert a user-typed decimal amount (e.g. "1,250.75") into integer piasters.
 * String-based so 0.1 + 0.2 style float errors cannot creep in.
 */
export function parseMoneyToMinor(input: string): number | null {
  const clean = input.trim().replace(/[\s,_]/g, '').replace(/^EGP/i, '');
  if (!clean) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return null;
  const [whole, fraction = ''] = clean.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

export function minorToInput(minor: number | null | undefined): string {
  if (minor == null || !Number.isFinite(minor)) return '';
  return (minor / 100).toFixed(2);
}

export function sumMinor(values: Array<number | null | undefined>): number {
  return values.reduce<number>((sum, v) => sum + (Number.isFinite(v) ? Number(v) : 0), 0);
}
