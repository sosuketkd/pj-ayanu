// Account routes: read / update the signed-in user's profile and notification prefs,
// OAuth links, two-factor (TOTP) and account deletion.
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { sql } from '../lib/db.js';
import { makeToken } from '../lib/auth.js';
import { requireUser, setAuthCookie } from '../middleware/auth.js';
import { validEmail, ownerOfEmail } from '../utils.js';
import { OAUTH_PROVIDERS, isConfigured } from './oauth.js';
import { generateSecret, verifyTotp, otpauthURI } from '../lib/totp.js';
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

// Per-provider link state for the settings screen.
async function oauthState(userId: string): Promise<Record<string, { configured: boolean; linked: boolean }>> {
  const rows = await sql`select provider from oauth_accounts where user_id = ${userId}`;
  const linked = new Set(rows.map((r) => r.provider));
  const out: Record<string, { configured: boolean; linked: boolean }> = {};
  for (const p of OAUTH_PROVIDERS) out[p] = { configured: isConfigured(p), linked: linked.has(p) };
  return out;
}

// The complete account object returned by GET/PATCH and the 2FA/link mutations.
async function fullAccount(uid: string) {
  const rows = await sql`
    select email, username, handle, notifications, totp_enabled,
      (password_hash is not null) as has_password
    from users where id = ${uid}`;
  if (!rows.length) return null;
  const u = rows[0];
  return {
    ...shape(u, await emailsOf(uid)),
    hasPassword: !!u.has_password,
    twoFactor: { enabled: !!u.totp_enabled },
    oauth: await oauthState(uid),
  };
}

router.get('/account', requireUser, async (c) => {
  const acc = await fullAccount(c.get('userId'));
  if (!acc) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  return c.json(acc);
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

  return c.json(await fullAccount(uid));
});

// ---- OAuth link management (link is initiated via GET /api/auth/oauth/:provider?mode=link) ----

// Unlink a connected provider. Blocked if it would remove the only sign-in method.
router.delete('/account/oauth/:provider', requireUser, async (c) => {
  const uid = c.get('userId');
  const provider = c.req.param('provider')!;
  if (!OAUTH_PROVIDERS.includes(provider)) return c.json({ error: '未対応の連携です' }, 400);
  const linked = (await sql`select provider from oauth_accounts where user_id = ${uid}`).map((r) => r.provider);
  if (!linked.includes(provider)) return c.json({ error: '連携されていません' }, 404);
  const u = await sql`select (password_hash is not null) as has_pw from users where id = ${uid}`;
  const otherSignIn = u[0].has_pw || linked.some((p) => p !== provider);
  if (!otherSignIn) {
    return c.json({ error: 'ログイン手段が無くなるため解除できません。先にパスワードまたは別の連携を設定してください' }, 400);
  }
  await sql`delete from oauth_accounts where user_id = ${uid} and provider = ${provider}`;
  return c.json(await fullAccount(uid));
});

// ---- Two-factor (TOTP) — opt-in from settings (not enforced at login yet) ----

// Generate (or re-generate) a secret and return the otpauth URI; stays disabled until verified.
router.post('/account/2fa/setup', requireUser, async (c) => {
  const uid = c.get('userId');
  const rows = await sql`select email, totp_enabled from users where id = ${uid}`;
  if (!rows.length) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  if (rows[0].totp_enabled) return c.json({ error: '既に2段階認証が有効です' }, 400);
  const secret = generateSecret();
  await sql`update users set totp_secret = ${secret} where id = ${uid}`;
  return c.json({ secret, otpauth: otpauthURI({ secret, label: rows[0].email, issuer: 'Ayanu' }) });
});

// Confirm a code from the authenticator app to switch 2FA on.
router.post('/account/2fa/enable', requireUser, async (c) => {
  const uid = c.get('userId');
  const { code } = await c.req.json().catch(() => ({}));
  const rows = await sql`select totp_secret, totp_enabled from users where id = ${uid}`;
  if (!rows.length) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  if (rows[0].totp_enabled) return c.json({ error: '既に有効です' }, 400);
  if (!rows[0].totp_secret) return c.json({ error: 'セットアップが完了していません' }, 400);
  if (!verifyTotp(rows[0].totp_secret, String(code || ''))) return c.json({ error: '認証コードが正しくありません' }, 400);
  await sql`update users set totp_enabled = true where id = ${uid}`;
  return c.json(await fullAccount(uid));
});

// Turn 2FA off (requires a current code) and clear the stored secret.
router.post('/account/2fa/disable', requireUser, async (c) => {
  const uid = c.get('userId');
  const { code } = await c.req.json().catch(() => ({}));
  const rows = await sql`select totp_secret, totp_enabled from users where id = ${uid}`;
  if (!rows.length) return c.json({ error: 'ユーザーが見つかりません' }, 404);
  if (!rows[0].totp_enabled) return c.json({ error: '2段階認証は有効ではありません' }, 400);
  if (!verifyTotp(rows[0].totp_secret, String(code || ''))) return c.json({ error: '認証コードが正しくありません' }, 400);
  await sql`update users set totp_enabled = false, totp_secret = null where id = ${uid}`;
  return c.json(await fullAccount(uid));
});

// ---- Account deletion ----
// Blocked while the user owns a team workspace that still has other members.
router.delete('/account', requireUser, async (c) => {
  const uid = c.get('userId');
  const blocking = await sql`
    select w.name
    from workspaces w
    join workspace_members m on m.workspace_id = w.id and m.user_id = ${uid} and m.role = 'owner'
    where (select count(*) from workspace_members mm where mm.workspace_id = w.id) > 1`;
  if (blocking.length) {
    return c.json({
      error: '他のメンバーがいるワークスペースの所有者です。先に譲渡または削除してください',
      workspaces: blocking.map((w) => w.name),
    }, 409);
  }
  // Drop the workspaces this user solely owns (cascades members + member_data);
  // their remaining memberships and account rows cascade on user delete.
  await sql`delete from workspaces where id in (
    select w.id from workspaces w
    join workspace_members m on m.workspace_id = w.id and m.user_id = ${uid} and m.role = 'owner')`;
  await sql`delete from users where id = ${uid}`;
  deleteCookie(c, 'token', { path: '/' });
  return c.json({ ok: true });
});

export default router;
