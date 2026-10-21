import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { env } from '../../config/env.js';

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });

const KEY_LENGTH = 64;

/** scrypt from Node's standard crypto module; format: scrypt$logN$r$p$salt$hash */
export async function hashPassword(password: string, cost = env.PASSWORD_HASH_COST): Promise<string> {
  const salt = randomBytes(16);
  const N = 2 ** cost;
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { N, r: 8, p: 1, maxmem: 256 * N * 8 });
  return ['scrypt', cost, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, costText, rText, pText, saltText, hashText] = stored.split('$');
  if (scheme !== 'scrypt' || !costText || !rText || !pText || !saltText || !hashText) return false;
  const N = 2 ** Number(costText);
  const r = Number(rText);
  const p = Number(pText);
  const expected = Buffer.from(hashText, 'base64url');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltText, 'base64url'), expected.length, { N, r, p, maxmem: 256 * N * r });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A precomputed hash so unknown e-mails take as long as known ones. */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  return dummyHash;
}
