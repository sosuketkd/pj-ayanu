// Invitation routes: email invites, invite links, and joining via either.
import { Hono } from 'hono';
import { sql } from '../lib/db.js';
import { requireUser } from '../middleware/auth.js';
import { sendInviteEmail } from '../lib/email.js';
import { atLeast, membership, validEmail, baseUrl, ownerOfEmail } from '../utils.js';
import type { AppEnv } from '../types.js';

const router = new Hono<AppEnv>();

/* ---- email invitations ---- */
router.post('/workspaces/:id/invites', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { email, role } = await c.req.json().catch(() => ({}));
  const mail = (email || '').toLowerCase().trim();
  if (!validEmail(mail)) return c.json({ error: '正しいメールアドレスを入力してください' }, 400);
  const r = ['admin', 'member'].includes(role) ? role : 'member';
  const already = await sql`
    select 1 from workspace_members m join user_emails ue on ue.user_id = m.user_id
    where m.workspace_id = ${id} and lower(ue.email) = ${mail}`;
  if (already.length) return c.json({ error: '既にメンバーです' }, 409);
  const token = crypto.randomUUID();
  await sql`
    insert into invitations (workspace_id, email, role, token, invited_by)
    values (${id}, ${mail}, ${r}, ${token}, ${c.get('userId')})`;

  // send the invitation email (best-effort: don't fail the request if it can't send).
  // Respect the invitee's preference if they already have an account.
  const wr = await sql`select name from workspaces where id = ${id}`;
  const pref = await sql`
    select u.notifications from users u join user_emails ue on ue.user_id = u.id
    where lower(ue.email) = ${mail}`;
  const wantsEmail = !pref.length || pref[0].notifications?.emailInvites !== false;
  const acceptUrl = `${baseUrl(c)}/?invite=${token}`;
  let emailSent = false;
  if (wantsEmail) {
    try {
      const res = await sendInviteEmail({
        to: mail, workspaceName: wr[0]?.name || 'ワークスペース',
        acceptUrl, role: r, inviter: c.get('email'),
      });
      emailSent = !!res.sent;
    } catch (e) { console.error(e); }
  }

  return c.json({ ok: true, token, email: mail, role: r, emailSent });
});

router.delete('/workspaces/:id/invites/:inviteId', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  await sql`delete from invitations where id = ${c.req.param('inviteId')!} and workspace_id = ${id}`;
  return c.json({ ok: true });
});

// accept an email invite by token. Holding the token = proof the invitee received
// the email at inv.email, so we bind that address to their account (verified) and
// use it as their contact email for this workspace.
router.post('/invites/:token/accept', requireUser, async (c) => {
  const uid = c.get('userId');
  const r = await sql`select id, workspace_id, role, email, accepted_at from invitations where token = ${c.req.param('token')!}`;
  if (!r.length) return c.json({ error: '招待が見つかりません' }, 404);
  const inv = r[0];
  if (inv.accepted_at) return c.json({ error: 'この招待は既に使用済みです' }, 409);

  const invEmail = inv.email.toLowerCase();
  const owner = await ownerOfEmail(invEmail);
  if (owner && owner !== uid) {
    return c.json({ error: 'この招待先メールは別のアカウントで使用されています' }, 409);
  }
  if (!owner) {
    await sql`
      insert into user_emails (user_id, email, verified) values (${uid}, ${invEmail}, true)
      on conflict (user_id, email) do update set verified = true`;
  }
  await sql`
    insert into workspace_members (workspace_id, user_id, role, contact_email)
    values (${inv.workspace_id}, ${uid}, ${inv.role}, ${invEmail})
    on conflict (workspace_id, user_id) do nothing`;
  await sql`update invitations set accepted_at = now() where id = ${inv.id}`;
  return c.json({ ok: true, workspaceId: inv.workspace_id });
});

router.post('/invites/:token/decline', requireUser, async (c) => {
  await sql`delete from invitations where token = ${c.req.param('token')!}`;
  return c.json({ ok: true });
});

/* ---- invite link ---- */
router.post('/workspaces/:id/invite-link', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { role } = await c.req.json().catch(() => ({}));
  const r = ['admin', 'member'].includes(role) ? role : 'member';
  const token = crypto.randomUUID();
  await sql`update workspaces set invite_token = ${token}, invite_role = ${r} where id = ${id}`;
  return c.json({ token, role: r });
});

router.delete('/workspaces/:id/invite-link', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  await sql`update workspaces set invite_token = null where id = ${id}`;
  return c.json({ ok: true });
});

// preview / join via invite link (any logged-in user)
router.get('/join/:token', requireUser, async (c) => {
  const r = await sql`select id, name from workspaces where invite_token = ${c.req.param('token')!}`;
  if (!r.length) return c.json({ error: 'リンクが無効です' }, 404);
  return c.json({ id: r[0].id, name: r[0].name });
});

router.post('/join/:token', requireUser, async (c) => {
  const r = await sql`select id, invite_role from workspaces where invite_token = ${c.req.param('token')!}`;
  if (!r.length) return c.json({ error: 'リンクが無効です' }, 404);
  await sql`
    insert into workspace_members (workspace_id, user_id, role) values (${r[0].id}, ${c.get('userId')}, ${r[0].invite_role})
    on conflict (workspace_id, user_id) do nothing`;
  return c.json({ ok: true, workspaceId: r[0].id });
});

export default router;
