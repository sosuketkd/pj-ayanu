// Invitation routes: email invites, invite links, and joining via either.
import { Hono } from 'hono';
import { sql } from '../lib/db.js';
import { requireUser } from '../middleware/auth.js';
import { sendInviteEmail } from '../lib/email.js';
import { atLeast, membership, validEmail, baseUrl } from '../utils.js';

const router = new Hono();

/* ---- email invitations ---- */
router.post('/workspaces/:id/invites', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { email, role } = await c.req.json().catch(() => ({}));
  const mail = (email || '').toLowerCase().trim();
  if (!validEmail(mail)) return c.json({ error: '正しいメールアドレスを入力してください' }, 400);
  const r = ['admin', 'member'].includes(role) ? role : 'member';
  const already = await sql`
    select 1 from workspace_members m join users u on u.id = m.user_id
    where m.workspace_id = ${id} and lower(u.email) = ${mail}`;
  if (already.length) return c.json({ error: '既にメンバーです' }, 409);
  const token = crypto.randomUUID();
  await sql`
    insert into invitations (workspace_id, email, role, token, invited_by)
    values (${id}, ${mail}, ${r}, ${token}, ${c.get('userId')})`;

  // send the invitation email (best-effort: don't fail the request if it can't send)
  const wr = await sql`select name from workspaces where id = ${id}`;
  const acceptUrl = `${baseUrl(c)}/?invite=${token}`;
  let emailSent = false;
  try {
    const res = await sendInviteEmail({
      to: mail, workspaceName: wr[0]?.name || 'ワークスペース',
      acceptUrl, role: r, inviter: c.get('email'),
    });
    emailSent = !!res.sent;
  } catch (e) { console.error(e); }

  return c.json({ ok: true, token, email: mail, role: r, emailSent });
});

router.delete('/workspaces/:id/invites/:inviteId', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  await sql`delete from invitations where id = ${c.req.param('inviteId')} and workspace_id = ${id}`;
  return c.json({ ok: true });
});

// accept an email invite by token (must be the invited email)
router.post('/invites/:token/accept', requireUser, async (c) => {
  const r = await sql`select id, workspace_id, role, email, accepted_at from invitations where token = ${c.req.param('token')}`;
  if (!r.length) return c.json({ error: '招待が見つかりません' }, 404);
  const inv = r[0];
  if (inv.accepted_at) return c.json({ error: 'この招待は既に使用済みです' }, 409);
  if (inv.email.toLowerCase() !== c.get('email').toLowerCase()) {
    return c.json({ error: 'この招待は別のメール宛てです' }, 403);
  }
  await sql`
    insert into workspace_members (workspace_id, user_id, role) values (${inv.workspace_id}, ${c.get('userId')}, ${inv.role})
    on conflict (workspace_id, user_id) do nothing`;
  await sql`update invitations set accepted_at = now() where id = ${inv.id}`;
  return c.json({ ok: true, workspaceId: inv.workspace_id });
});

router.post('/invites/:token/decline', requireUser, async (c) => {
  await sql`delete from invitations where token = ${c.req.param('token')} and lower(email) = lower(${c.get('email')})`;
  return c.json({ ok: true });
});

/* ---- invite link ---- */
router.post('/workspaces/:id/invite-link', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { role } = await c.req.json().catch(() => ({}));
  const r = ['admin', 'member'].includes(role) ? role : 'member';
  const token = crypto.randomUUID();
  await sql`update workspaces set invite_token = ${token}, invite_role = ${r} where id = ${id}`;
  return c.json({ token, role: r });
});

router.delete('/workspaces/:id/invite-link', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  await sql`update workspaces set invite_token = null where id = ${id}`;
  return c.json({ ok: true });
});

// preview / join via invite link (any logged-in user)
router.get('/join/:token', requireUser, async (c) => {
  const r = await sql`select id, name from workspaces where invite_token = ${c.req.param('token')}`;
  if (!r.length) return c.json({ error: 'リンクが無効です' }, 404);
  return c.json({ id: r[0].id, name: r[0].name });
});

router.post('/join/:token', requireUser, async (c) => {
  const r = await sql`select id, invite_role from workspaces where invite_token = ${c.req.param('token')}`;
  if (!r.length) return c.json({ error: 'リンクが無効です' }, 404);
  await sql`
    insert into workspace_members (workspace_id, user_id, role) values (${r[0].id}, ${c.get('userId')}, ${r[0].invite_role})
    on conflict (workspace_id, user_id) do nothing`;
  return c.json({ ok: true, workspaceId: r[0].id });
});

export default router;
