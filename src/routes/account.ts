// Account routes: read / update the signed-in user's profile and notification prefs.
import { Hono } from 'hono';
import { sql } from '../lib/db.js';
import { makeToken } from '../lib/auth.js';
import { requireUser, setAuthCookie } from '../middleware/auth.js';
import { validEmail } from '../utils.js';
import type { AppEnv } from '../types.js';

const router = new Hono<AppEnv>();

// Public user ID: lowercase/uppercase letters, digits, underscore, 3–20 chars.
const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;

type Account = { email: string; username: string | null; handle: string | null; notifications: Record<string, any> };

function shape(u: Record<string, any>): Account {
  return { email: u.email, username: u.username ?? null, handle: u.handle ?? null, notifications: u.notifications || {} };
}

router.get('/account', requireUser, async (c) => {
  const rows = await sql`select email, username, handle, notifications from users where id = ${c.get('userId')}`;
  if (!rows.length) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  return c.json(shape(rows[0]));
});

router.patch('/account', requireUser, async (c) => {
  const uid = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const rows = await sql`select email, username, handle, notifications from users where id = ${uid}`;
  if (!rows.length) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  const cur = rows[0];

  // email (re-issue the login cookie so the session's email stays in sync)
  if (body.email !== undefined) {
    const mail = String(body.email || '').toLowerCase().trim();
    if (!validEmail(mail)) return c.json({ error: '正しいメールアドレスを入力してください' }, 400);
    if (mail !== cur.email) {
      const taken = await sql`select 1 from users where email = ${mail} and id <> ${uid}`;
      if (taken.length) return c.json({ error: 'このメールは既に使われています' }, 409);
      await sql`update users set email = ${mail} where id = ${uid}`;
      setAuthCookie(c, await makeToken({ id: uid, email: mail }));
    }
  }

  // username (display name; empty clears it)
  if (body.username !== undefined) {
    const name = String(body.username || '').trim();
    if (name.length > 50) return c.json({ error: 'ユーザーネームは50文字以内にしてください' }, 400);
    await sql`update users set username = ${name || null} where id = ${uid}`;
  }

  // handle / public user ID — set once, then immutable
  if (body.handle !== undefined && body.handle !== null && String(body.handle).trim().length) {
    const handle = String(body.handle).trim();
    if (cur.handle) {
      if (handle !== cur.handle) return c.json({ error: 'ユーザーIDは初期設定後は変更できません' }, 400);
    } else {
      if (!HANDLE_RE.test(handle)) {
        return c.json({ error: 'ユーザーIDは半角英数字とアンダースコア3〜20文字にしてください' }, 400);
      }
      const taken = await sql`select 1 from users where handle = ${handle} and id <> ${uid}`;
      if (taken.length) return c.json({ error: 'このユーザーIDは既に使われています' }, 409);
      await sql`update users set handle = ${handle} where id = ${uid}`;
    }
  }

  // notification preferences (stored as-is)
  if (body.notifications && typeof body.notifications === 'object') {
    await sql`update users set notifications = ${JSON.stringify(body.notifications)}::jsonb where id = ${uid}`;
  }

  const updated = await sql`select email, username, handle, notifications from users where id = ${uid}`;
  return c.json(shape(updated[0]));
});

export default router;
