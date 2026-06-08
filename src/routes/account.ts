// Account routes: read / update the signed-in user's profile and notification prefs.
import { Hono } from 'hono';
import { sql } from '../lib/db.js';
import { makeToken } from '../lib/auth.js';
import { requireUser, setAuthCookie } from '../middleware/auth.js';
import { validEmail, ownerOfEmail } from '../utils.js';
import type { AppEnv } from '../types.js';

const router = new Hono<AppEnv>();

// Public user ID: lowercase/uppercase letters, digits, underscore, 3–20 chars.
const HANDLE_RE = /^[a-zA-Z0-9_]{3,20}$/;

type Email = { email: string; verified: boolean; primary: boolean };
type Account = {
  email: string; username: string | null; handle: string | null;
  notifications: Record<string, any>; emails: Email[];
};

async function emailsOf(userId: string): Promise<Email[]> {
  const rows = await sql`
    select email, verified, is_primary from user_emails
    where user_id = ${userId} order by is_primary desc, created_at`;
  return rows.map((r) => ({ email: r.email, verified: !!r.verified, primary: !!r.is_primary }));
}

function shape(u: Record<string, any>, emails: Email[]): Account {
  return {
    email: u.email, username: u.username ?? null, handle: u.handle ?? null,
    notifications: u.notifications || {}, emails,
  };
}

router.get('/account', requireUser, async (c) => {
  const uid = c.get('userId');
  const rows = await sql`select email, username, handle, notifications from users where id = ${uid}`;
  if (!rows.length) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  return c.json(shape(rows[0], await emailsOf(uid)));
});

// Add a secondary email. Without email verification (SES) it stays unverified
// until confirmed; emails proven via an invite are verified at accept time.
router.post('/account/emails', requireUser, async (c) => {
  const uid = c.get('userId');
  const { email } = await c.req.json().catch(() => ({}));
  const mail = String(email || '').toLowerCase().trim();
  if (!validEmail(mail)) return c.json({ error: '正しいメールアドレスを入力してください' }, 400);
  const owner = await ownerOfEmail(mail);
  if (owner) {
    return c.json({ error: owner === uid ? 'このメールは登録済みです' : 'このメールは別のアカウントで使用されています' }, 409);
  }
  await sql`insert into user_emails (user_id, email, verified) values (${uid}, ${mail}, false)`;
  return c.json({ ok: true, emails: await emailsOf(uid) });
});

// Promote one of the account's verified emails to primary (mirrors users.email,
// re-issues the login cookie so the session email stays in sync).
router.post('/account/emails/primary', requireUser, async (c) => {
  const uid = c.get('userId');
  const { email } = await c.req.json().catch(() => ({}));
  const mail = String(email || '').toLowerCase().trim();
  const rows = await sql`select email, verified from user_emails where user_id = ${uid} and lower(email) = ${mail}`;
  if (!rows.length) return c.json({ error: 'このメールは登録されていません' }, 404);
  if (!rows[0].verified) return c.json({ error: '未確認のメールはプライマリにできません' }, 400);
  const canonical = rows[0].email;
  await sql`update user_emails set is_primary = (lower(email) = ${mail}) where user_id = ${uid}`;
  await sql`update users set email = ${canonical} where id = ${uid}`;
  setAuthCookie(c, await makeToken({ id: uid, email: canonical }));
  return c.json({ ok: true, email: canonical, emails: await emailsOf(uid) });
});

// Remove a (non-primary) email; any workspace using it as a contact falls back to primary.
router.delete('/account/emails', requireUser, async (c) => {
  const uid = c.get('userId');
  const { email } = await c.req.json().catch(() => ({}));
  const mail = String(email || '').toLowerCase().trim();
  const rows = await sql`select is_primary from user_emails where user_id = ${uid} and lower(email) = ${mail}`;
  if (!rows.length) return c.json({ error: 'このメールは登録されていません' }, 404);
  if (rows[0].is_primary) return c.json({ error: 'プライマリのメールは削除できません' }, 400);
  await sql`update workspace_members set contact_email = null where user_id = ${uid} and lower(contact_email) = ${mail}`;
  await sql`delete from user_emails where user_id = ${uid} and lower(email) = ${mail}`;
  return c.json({ ok: true, emails: await emailsOf(uid) });
});

router.patch('/account', requireUser, async (c) => {
  const uid = c.get('userId');
  const body = await c.req.json().catch(() => ({}));
  const rows = await sql`select email, username, handle, notifications from users where id = ${uid}`;
  if (!rows.length) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  const cur = rows[0];

  // email is managed via /account/emails (add / set-primary / remove)

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
  return c.json(shape(updated[0], await emailsOf(uid)));
});

export default router;
