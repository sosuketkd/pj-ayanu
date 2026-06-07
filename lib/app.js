import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { sql } from './db.js';
import {
  hashPassword, verifyPassword, makeToken, readToken, COOKIE_MAX_AGE,
} from './auth.js';
import { sendInviteEmail } from './email.js';

// Base URL used to build invite links in emails (falls back to the request origin).
function baseUrl(c) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  try { return new URL(c.req.url).origin; } catch { return ''; }
}

export const app = new Hono().basePath('/api');

/* ---- helpers ---- */
const ROLE_RANK = { member: 1, admin: 2, owner: 3 };
function atLeast(role, min) { return !!role && ROLE_RANK[role] >= ROLE_RANK[min]; }
function validEmail(s) { return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

function setAuthCookie(c, token) {
  setCookie(c, 'token', token, {
    httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: COOKIE_MAX_AGE,
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

// Returns the caller's role in a workspace, or null if not a member.
async function membership(workspaceId, userId) {
  const r = await sql`select role from workspace_members where workspace_id=${workspaceId} and user_id=${userId}`;
  return r.length ? r[0].role : null;
}

/* ---- TEMP debug: remove after diagnosing prod DB connectivity ---- */
app.get('/_debug/db', async (c) => {
  const url = process.env.DATABASE_URL || '';
  const host = url.replace(/^[a-z]+:\/\/[^@]*@/i, '').split(/[/?]/)[0] || '(none)';
  let db = 'unknown';
  try {
    const r = await Promise.race([
      sql`select 1 as ok`,
      new Promise((_, rej) => setTimeout(() => rej(new Error('db-timeout-8s')), 8000)),
    ]);
    db = 'ok:' + JSON.stringify(r);
  } catch (e) { db = 'error:' + e.message; }
  return c.json({ hasDbUrl: !!process.env.DATABASE_URL, urlLen: url.length, host, db });
});

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
    insert into users (email, password_hash) values (${mail}, ${hash}) returning id, email`;
  setAuthCookie(c, await makeToken(rows[0]));
  return c.json({ email: rows[0].email });
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

app.post('/auth/logout', (c) => { deleteCookie(c, 'token', { path: '/' }); return c.json({ ok: true }); });
app.get('/auth/me', requireUser, (c) => c.json({ email: c.get('email') }));

/* ---- workspaces ---- */
// list my workspaces + pending email invites
app.get('/workspaces', requireUser, async (c) => {
  const uid = c.get('userId');
  const workspaces = await sql`
    select w.id, w.name, w.kind, m.role,
      (select count(*) from workspace_members mm where mm.workspace_id = w.id)::int as member_count
    from workspaces w
    join workspace_members m on m.workspace_id = w.id
    where m.user_id = ${uid}
    order by w.created_at`;
  const invites = await sql`
    select i.token, i.role, w.name as workspace_name
    from invitations i join workspaces w on w.id = i.workspace_id
    where lower(i.email) = lower(${c.get('email')}) and i.accepted_at is null
    order by i.created_at`;
  return c.json({ workspaces, invites });
});

// create a workspace (creator becomes owner)
app.post('/workspaces', requireUser, async (c) => {
  const { name, kind } = await c.req.json().catch(() => ({}));
  const nm = (name || '').trim() || '新しいワークスペース';
  const k = kind === 'team' ? 'team' : 'personal';
  const wr = await sql`
    insert into workspaces (name, kind, created_by) values (${nm}, ${k}, ${c.get('userId')})
    returning id, name, kind`;
  const w = wr[0];
  await sql`insert into workspace_members (workspace_id, user_id, role) values (${w.id}, ${c.get('userId')}, 'owner')`;
  await sql`insert into workspace_data (workspace_id, data) values (${w.id}, '{}'::jsonb)`;
  return c.json({ id: w.id, name: w.name, kind: w.kind, role: 'owner', member_count: 1 });
});

// workspace detail: members, my role, invite link + pending invites (admins only see invites/link)
app.get('/workspaces/:id', requireUser, async (c) => {
  const id = c.req.param('id');
  const role = await membership(id, c.get('userId'));
  if (!role) return c.json({ error: 'アクセス権がありません' }, 403);
  const wr = await sql`select id, name, kind, invite_token, invite_role from workspaces where id = ${id}`;
  if (!wr.length) return c.json({ error: '見つかりません' }, 404);
  const members = await sql`
    select u.id, u.email, m.role from workspace_members m join users u on u.id = m.user_id
    where m.workspace_id = ${id}
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.email`;
  const invites = atLeast(role, 'admin')
    ? await sql`select id, email, role from invitations where workspace_id = ${id} and accepted_at is null order by created_at`
    : [];
  const w = wr[0];
  return c.json({
    id: w.id, name: w.name, kind: w.kind, myRole: role,
    inviteToken: atLeast(role, 'admin') ? w.invite_token : null,
    inviteRole: w.invite_role, members, invites,
  });
});

app.patch('/workspaces/:id', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { name } = await c.req.json().catch(() => ({}));
  if (name && name.trim()) await sql`update workspaces set name = ${name.trim()} where id = ${id}`;
  return c.json({ ok: true });
});

app.delete('/workspaces/:id', requireUser, async (c) => {
  const id = c.req.param('id');
  if ((await membership(id, c.get('userId'))) !== 'owner') return c.json({ error: 'オーナーのみ削除できます' }, 403);
  await sql`delete from workspaces where id = ${id}`;
  return c.json({ ok: true });
});

/* ---- workspace content (tickets + AfterCheck) ---- */
app.get('/workspaces/:id/data', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!(await membership(id, c.get('userId')))) return c.json({ error: 'アクセス権がありません' }, 403);
  const r = await sql`select data from workspace_data where workspace_id = ${id}`;
  return c.json({ data: r.length ? r[0].data : {} });
});

app.put('/workspaces/:id/data', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!(await membership(id, c.get('userId')))) return c.json({ error: 'アクセス権がありません' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const data = body && body.data && typeof body.data === 'object' ? body.data : {};
  await sql`
    insert into workspace_data (workspace_id, data, updated_at)
    values (${id}, ${JSON.stringify(data)}::jsonb, now())
    on conflict (workspace_id) do update set data = excluded.data, updated_at = now()`;
  return c.json({ ok: true });
});

/* ---- members ---- */
app.patch('/workspaces/:id/members/:userId', requireUser, async (c) => {
  const id = c.req.param('id'), target = c.req.param('userId'), me = c.get('userId');
  const role = await membership(id, me);
  if (!atLeast(role, 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { role: newRole } = await c.req.json().catch(() => ({}));
  if (!['owner', 'admin', 'member'].includes(newRole)) return c.json({ error: '不正なロールです' }, 400);
  const targetRole = await membership(id, target);
  if (!targetRole) return c.json({ error: 'メンバーではありません' }, 404);
  if (targetRole === 'owner') return c.json({ error: 'オーナーのロールは変更できません' }, 403);
  if (newRole === 'owner' && role !== 'owner') return c.json({ error: 'オーナーのみ譲渡できます' }, 403);
  await sql`update workspace_members set role = ${newRole} where workspace_id = ${id} and user_id = ${target}`;
  if (newRole === 'owner') {
    await sql`update workspace_members set role = 'admin' where workspace_id = ${id} and user_id = ${me}`;
  }
  return c.json({ ok: true });
});

// remove a member (admin+) or leave the workspace yourself
app.delete('/workspaces/:id/members/:userId', requireUser, async (c) => {
  const id = c.req.param('id'), target = c.req.param('userId'), me = c.get('userId');
  const role = await membership(id, me);
  if (!role) return c.json({ error: 'アクセス権がありません' }, 403);
  const targetRole = await membership(id, target);
  if (!targetRole) return c.json({ error: 'メンバーではありません' }, 404);
  const isSelf = target === me;
  if (!isSelf && !atLeast(role, 'admin')) return c.json({ error: '権限がありません' }, 403);
  if (targetRole === 'owner') return c.json({ error: 'オーナーは退出/削除できません（先に譲渡してください）' }, 403);
  await sql`delete from workspace_members where workspace_id = ${id} and user_id = ${target}`;
  return c.json({ ok: true });
});

/* ---- email invitations ---- */
app.post('/workspaces/:id/invites', requireUser, async (c) => {
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

app.delete('/workspaces/:id/invites/:inviteId', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  await sql`delete from invitations where id = ${c.req.param('inviteId')} and workspace_id = ${id}`;
  return c.json({ ok: true });
});

// accept an email invite by token (must be the invited email)
app.post('/invites/:token/accept', requireUser, async (c) => {
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

app.post('/invites/:token/decline', requireUser, async (c) => {
  await sql`delete from invitations where token = ${c.req.param('token')} and lower(email) = lower(${c.get('email')})`;
  return c.json({ ok: true });
});

/* ---- invite link ---- */
app.post('/workspaces/:id/invite-link', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { role } = await c.req.json().catch(() => ({}));
  const r = ['admin', 'member'].includes(role) ? role : 'member';
  const token = crypto.randomUUID();
  await sql`update workspaces set invite_token = ${token}, invite_role = ${r} where id = ${id}`;
  return c.json({ token, role: r });
});

app.delete('/workspaces/:id/invite-link', requireUser, async (c) => {
  const id = c.req.param('id');
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  await sql`update workspaces set invite_token = null where id = ${id}`;
  return c.json({ ok: true });
});

// preview / join via invite link (any logged-in user)
app.get('/join/:token', requireUser, async (c) => {
  const r = await sql`select id, name from workspaces where invite_token = ${c.req.param('token')}`;
  if (!r.length) return c.json({ error: 'リンクが無効です' }, 404);
  return c.json({ id: r[0].id, name: r[0].name });
});

app.post('/join/:token', requireUser, async (c) => {
  const r = await sql`select id, invite_role from workspaces where invite_token = ${c.req.param('token')}`;
  if (!r.length) return c.json({ error: 'リンクが無効です' }, 404);
  await sql`
    insert into workspace_members (workspace_id, user_id, role) values (${r[0].id}, ${c.get('userId')}, ${r[0].invite_role})
    on conflict (workspace_id, user_id) do nothing`;
  return c.json({ ok: true, workspaceId: r[0].id });
});

export default app;
