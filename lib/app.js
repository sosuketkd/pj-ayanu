import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sql } from './db.js';
import {
  hashPassword, verifyPassword, makeToken, readToken, COOKIE_MAX_AGE,
} from './auth.js';

export const app = new Hono().basePath('/api');

/* ---- helpers ---- */
function setAuthCookie(c, token) {
  setCookie(c, 'token', token, {
    httpOnly: true,
    secure: true,          // sent over HTTPS (Vercel). On http://localhost browsers still accept it.
    sameSite: 'Lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  });
}

async function requireUser(c, next) {
  const token = getCookie(c, 'token');
  const payload = token ? await readToken(token) : null;
  if (!payload) return c.json({ error: 'ログインが必要です' }, 401);
  c.set('userId', payload.sub);
  c.set('email', payload.email);
  await next();
}

function validEmail(s) { return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

/* ---- auth ---- */
app.post('/auth/signup', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const mail = (email || '').toLowerCase().trim();
  if (!validEmail(mail)) return c.json({ error: '正しいメールアドレスを入力してください' }, 400);
  if (!password || password.length < 6) return c.json({ error: 'パスワードは6文字以上にしてください' }, 400);

  const existing = await sql`select id from users where email = ${mail}`;
  if (existing.length) return c.json({ error: 'このメールは既に登録されています' }, 409);

  const hash = await hashPassword(password);
  const rows = await sql`
    insert into users (email, password_hash) values (${mail}, ${hash})
    returning id, email`;
  const user = rows[0];
  await sql`
    insert into app_state (user_id, data) values (${user.id}, '{}'::jsonb)
    on conflict (user_id) do nothing`;

  setAuthCookie(c, await makeToken(user));
  return c.json({ email: user.email });
});

app.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const mail = (email || '').toLowerCase().trim();
  const rows = await sql`select id, email, password_hash from users where email = ${mail}`;
  if (!rows.length || !(await verifyPassword(password || '', rows[0].password_hash))) {
    return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401);
  }
  setAuthCookie(c, await makeToken(rows[0]));
  return c.json({ email: rows[0].email });
});

app.post('/auth/logout', (c) => {
  deleteCookie(c, 'token', { path: '/' });
  return c.json({ ok: true });
});

app.get('/auth/me', requireUser, (c) => c.json({ email: c.get('email') }));

/* ---- app state (whole store as JSON) ---- */
app.get('/state', requireUser, async (c) => {
  const rows = await sql`select data from app_state where user_id = ${c.get('userId')}`;
  return c.json({ data: rows.length ? rows[0].data : {} });
});

app.put('/state', requireUser, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const data = body && typeof body.data === 'object' && body.data ? body.data : {};
  await sql`
    insert into app_state (user_id, data, updated_at)
    values (${c.get('userId')}, ${JSON.stringify(data)}::jsonb, now())
    on conflict (user_id) do update set data = excluded.data, updated_at = now()`;
  return c.json({ ok: true });
});

export default app;
