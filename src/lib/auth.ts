import bcrypt from 'bcryptjs';
import { sign, verify } from 'hono/jwt';

const SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const ALG = 'HS256';
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export async function makeToken(user: { id: string; email: string }): Promise<string> {
  return sign(
    { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + THIRTY_DAYS },
    SECRET, ALG
  );
}
export async function readToken(token: string): Promise<Record<string, any> | null> {
  try { return await verify(token, SECRET, ALG); }
  catch { return null; }
}

export const COOKIE_MAX_AGE = THIRTY_DAYS;
