// Workspace routes: list / create / detail / rename / delete + content (tickets + AfterCheck).
import { Hono } from 'hono';
import { sql } from '../lib/db.js';
import { requireUser } from '../middleware/auth.js';
import { atLeast, membership } from '../utils.js';
import type { AppEnv } from '../types.js';

const router = new Hono<AppEnv>();

// list my workspaces + pending email invites
router.get('/workspaces', requireUser, async (c) => {
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
    where lower(i.email) in (select lower(email) from user_emails where user_id = ${uid})
      and i.accepted_at is null
    order by i.created_at`;
  return c.json({ workspaces, invites });
});

// create a workspace (creator becomes owner)
router.post('/workspaces', requireUser, async (c) => {
  const { name, kind } = await c.req.json().catch(() => ({}));
  const nm = (name || '').trim() || '新しいワークスペース';
  const k = kind === 'team' ? 'team' : 'personal';
  const wr = await sql`
    insert into workspaces (name, kind, created_by) values (${nm}, ${k}, ${c.get('userId')})
    returning id, name, kind`;
  const w = wr[0];
  await sql`insert into workspace_members (workspace_id, user_id, role) values (${w.id}, ${c.get('userId')}, 'owner')`;
  await sql`insert into member_data (workspace_id, user_id, data) values (${w.id}, ${c.get('userId')}, '{}'::jsonb)`;
  return c.json({ id: w.id, name: w.name, kind: w.kind, role: 'owner', member_count: 1 });
});

// workspace detail: members, my role, invite link + pending invites (admins only see invites/link)
router.get('/workspaces/:id', requireUser, async (c) => {
  const id = c.req.param('id')!;
  const role = await membership(id, c.get('userId'));
  if (!role) return c.json({ error: 'アクセス権がありません' }, 403);
  const wr = await sql`select id, name, kind, invite_token, invite_role from workspaces where id = ${id}`;
  if (!wr.length) return c.json({ error: '見つかりません' }, 404);
  // `email` is the address that represents the member in THIS workspace
  // (their per-workspace contact email, falling back to their primary).
  const members = await sql`
    select u.id, coalesce(m.contact_email, u.email) as email, m.role
    from workspace_members m join users u on u.id = m.user_id
    where m.workspace_id = ${id}
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, email`;
  const invites = atLeast(role, 'admin')
    ? await sql`select id, email, role from invitations where workspace_id = ${id} and accepted_at is null order by created_at`
    : [];
  // the caller's verified emails + which one they use here (for the contact picker)
  const myEmails = (await sql`
    select email from user_emails where user_id = ${c.get('userId')} and verified
    order by is_primary desc, created_at`).map((r) => r.email);
  const mine = await sql`select contact_email from workspace_members where workspace_id = ${id} and user_id = ${c.get('userId')}`;
  const w = wr[0];
  return c.json({
    id: w.id, name: w.name, kind: w.kind, myRole: role,
    inviteToken: atLeast(role, 'admin') ? w.invite_token : null,
    inviteRole: w.invite_role, members, invites,
    myEmails, myContactEmail: mine.length ? mine[0].contact_email : null,
  });
});

router.patch('/workspaces/:id', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const { name } = await c.req.json().catch(() => ({}));
  if (name && name.trim()) await sql`update workspaces set name = ${name.trim()} where id = ${id}`;
  return c.json({ ok: true });
});

router.delete('/workspaces/:id', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if ((await membership(id, c.get('userId'))) !== 'owner') return c.json({ error: 'オーナーのみ削除できます' }, 403);
  await sql`delete from workspaces where id = ${id}`;
  return c.json({ ok: true });
});

// the caller's OWN content (tickets + AfterCheck) in this workspace
router.get('/workspaces/:id/data', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!(await membership(id, c.get('userId')))) return c.json({ error: 'アクセス権がありません' }, 403);
  const r = await sql`select data from member_data where workspace_id = ${id} and user_id = ${c.get('userId')}`;
  return c.json({ data: r.length ? r[0].data : {} });
});

router.put('/workspaces/:id/data', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!(await membership(id, c.get('userId')))) return c.json({ error: 'アクセス権がありません' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const data = body && body.data && typeof body.data === 'object' ? body.data : {};
  await sql`
    insert into member_data (workspace_id, user_id, data, updated_at)
    values (${id}, ${c.get('userId')}, ${JSON.stringify(data)}::jsonb, now())
    on conflict (workspace_id, user_id) do update set data = excluded.data, updated_at = now()`;
  return c.json({ ok: true });
});

// admin oversight: every member's TD in this workspace (read-only dashboard source)
router.get('/workspaces/:id/overview', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!atLeast(await membership(id, c.get('userId')), 'admin')) return c.json({ error: '権限がありません' }, 403);
  const members = await sql`
    select u.id, coalesce(m.contact_email, u.email) as email, u.username, m.role,
      coalesce(d.data, '{}'::jsonb) as data, d.updated_at
    from workspace_members m
    join users u on u.id = m.user_id
    left join member_data d on d.workspace_id = m.workspace_id and d.user_id = m.user_id
    where m.workspace_id = ${id}
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, email`;
  return c.json({ members });
});

// aggregate: the caller's own TD across every workspace they belong to (read-only)
router.get('/aggregate', requireUser, async (c) => {
  const uid = c.get('userId');
  const workspaces = await sql`
    select w.id, w.name, w.kind, coalesce(d.data, '{}'::jsonb) as data
    from workspaces w
    join workspace_members m on m.workspace_id = w.id and m.user_id = ${uid}
    left join member_data d on d.workspace_id = w.id and d.user_id = ${uid}
    order by w.kind, w.created_at`;
  return c.json({ workspaces });
});

export default router;
