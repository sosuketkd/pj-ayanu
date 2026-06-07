// Auth routes: signup / login / logout / me.
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { sql } from '../lib/db.js';
import { hashPassword, verifyPassword, makeToken } from '../lib/auth.js';
import { requireUser, setAuthCookie } from '../middleware/auth.js';
import { validEmail } from '../utils.js';

const router = new Hono();

router.post('/auth/signup', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const mail = (email || '').toLowerCase().trim();
  if (!validEmail(mail)) return c.json({ error: '正しいメールアドレスを入力してください' }, 400);
  if (!password || password.length < 6) return c.json({ error: 'パスワードは6文字以上にしてください' }, 400);

  const existing = await sql`select id from users where email = ${mail}`;
  if (existing.length) return c.json({ error: 'このメールは既に登録されています' }, 409);

  const hash = await hashPassword(password);
  const rows = await sql`
    insert into users (email, password_hash) values (${mail}, ${hash}) returning id, email`;
  setAuthCookie(c, await makeToken(rows[0]));
  return c.json({ email: rows[0].email });
});

router.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const mail = (email || '').toLowerCase().trim();
  const rows = await sql`select id, email, password_hash from users where email = ${mail}`;
  if (!rows.length || !(await verifyPassword(password || '', rows[0].password_hash))) {
    return c.json({ error: 'メールアドレスまたはパスワードが違います' }, 401);
  }
  setAuthCookie(c, await makeToken(rows[0]));
  return c.json({ email: rows[0].email });
});

router.post('/auth/logout', (c) => { deleteCookie(c, 'token', { path: '/' }); return c.json({ ok: true }); });
router.get('/auth/me', requireUser, (c) => c.json({ email: c.get('email') }));

export default router;
