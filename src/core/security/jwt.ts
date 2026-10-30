import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

const ISSUER = 'fleet-erp';
const AUDIENCE = 'fleet-erp-api';
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const sign = (input: string, secret: string) => createHmac('sha256', secret).update(input).digest('base64url');

export interface AccessClaims {
  sub: string;   // user id
  sid: string;   // session id
  tv: number;    // user token version
}
interface FullClaims extends AccessClaims { iss: string; aud: string; iat: number; exp: number; }

/** HS256 JSON Web Token built on Node's standard crypto module. */
export function signAccessToken(claims: AccessClaims, ttlSeconds = env.ACCESS_TOKEN_TTL_SECONDS, secret = env.JWT_SECRET): { token: string; expiresAt: Date } {
  const iat = Math.floor(Date.now() / 1000);
  const payload: FullClaims = { ...claims, iss: ISSUER, aud: AUDIENCE, iat, exp: iat + ttlSeconds };
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  return { token: `${body}.${sign(body, secret)}`, expiresAt: new Date(payload.exp * 1000) };
}

export function verifyAccessToken(token: string, secret = env.JWT_SECRET): AccessClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = Buffer.from(sign(`${header}.${payload}`, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const head = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { alg?: string };
    if (head.alg !== 'HS256') return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<FullClaims>;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.tv !== 'number') return null;
    return { sub: claims.sub, sid: claims.sid, tv: claims.tv };
  } catch {
    return null;
  }
}
