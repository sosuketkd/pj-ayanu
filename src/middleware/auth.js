// Authentication middleware + the login-cookie helper shared by auth routes.
import { getCookie, setCookie } from 'hono/cookie';
import { readToken, COOKIE_MAX_AGE } from '../lib/auth.js';

export function setAuthCookie(c, token) {
  setCookie(c, 'token', token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: COOKIE_MAX_AGE,
  });
}

// Gate that requires a valid login cookie; exposes userId/email on the context.
export async function requireUser(c, next) {
  const token = getCookie(c, 'token');
  const payload = token ? await readToken(token) : null;
  if (!payload) return c.json({ error: 'ログインが必要です' }, 401);
  c.set('userId', payload.sub);
  c.set('email', payload.email);
  await next();
}
