import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Hash a password with scrypt. Format:
 *   scrypt$N$r$p$<salt-b64>$<hash-b64>
 * scrypt is used instead of bcrypt/argon2 so the image needs no native build
 * toolchain; parameters are recorded so they can be raised later.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const expected = Buffer.from(parts[5] ?? '', 'base64');
    if (salt.length === 0 || expected.length !== KEYLEN) return false;
    const actual = await scrypt(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface PasswordCheck {
  ok: boolean;
  message?: string;
}

/** Deliberately pragmatic: length first, then variety. */
export function checkPasswordStrength(password: string): PasswordCheck {
  if (password.length < 10) {
    return { ok: false, message: 'Password must be at least 10 characters long.' };
  }
  if (password.length > 200) {
    return { ok: false, message: 'Password is too long.' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) =>
    r.test(password),
  ).length;
  if (classes < 3) {
    return {
      ok: false,
      message: 'Use at least three of: lowercase, uppercase, numbers, symbols.',
    };
  }
  return { ok: true };
}
