/**
 * Leader tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload)).
 * Stateless; valid for 30 days; all die when the secret rotates (PIN change).
 */
import crypto from 'node:crypto';

export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const mac = (secret, data) => crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(data).digest();

export function signToken(secret, { now = Date.now(), ttlMs = TOKEN_TTL_MS } = {}) {
  const exp = now + ttlMs;
  const payload = b64url(JSON.stringify({ v: 1, iat: now, exp, n: crypto.randomBytes(6).toString('hex') }));
  return { token: `${payload}.${b64url(mac(secret, payload))}`, expiresAt: new Date(exp).toISOString() };
}

/** @returns {{ ok: true, exp: number } | { ok: false, reason: 'invalid'|'expired' }} */
export function verifyToken(secret, token, { now = Date.now() } = {}) {
  if (!secret || typeof token !== 'string' || token.length > 512) return { ok: false, reason: 'invalid' };
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return { ok: false, reason: 'invalid' };
  const expected = mac(secret, payload);
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'invalid' };
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (data?.v !== 1 || !Number.isFinite(data.exp)) return { ok: false, reason: 'invalid' };
  if (data.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, exp: data.exp };
}
