// Minimal TOTP (RFC 6238 / HOTP RFC 4226) implementation — no external deps.
// SHA1, 6 digits, 30s step. Used for opt-in two-factor in account settings.
import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

// A fresh random base32 secret (default 20 bytes → 160 bits, standard for TOTP).
export function generateSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

// Verify a 6-digit token against the secret, allowing ±`window` 30s steps for clock drift.
export function verifyTotp(secret: string, token: string, window = 1): boolean {
  const t = (token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(t) || !secret) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(key, counter + w) === t) return true;
  }
  return false;
}

// otpauth:// URI for authenticator apps (Google Authenticator, Authy, 1Password…).
export function otpauthURI(opts: { secret: string; label: string; issuer: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.label}`);
  const params = new URLSearchParams({
    secret: opts.secret, issuer: opts.issuer, algorithm: 'SHA1', digits: '6', period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
