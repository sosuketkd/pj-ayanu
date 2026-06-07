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
    where lower(i.email) = lower(${c.get('email')}) and i.accepted_at is null
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
  await sql`insert into workspace_data (workspace_id, data) values (${w.id}, '{}'::jsonb)`;
  return c.json({ id: w.id, name: w.name, kind: w.kind, role: 'owner', member_count: 1 });
});

// workspace detail: members, my role, invite link + pending invites (admins only see invites/link)
router.get('/workspaces/:id', requireUser, async (c) => {
  const id = c.req.param('id')!;
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

// workspace content (tickets + AfterCheck), stored as a single JSON blob
router.get('/workspaces/:id/data', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!(await membership(id, c.get('userId')))) return c.json({ error: 'アクセス権がありません' }, 403);
  const r = await sql`select data from workspace_data where workspace_id = ${id}`;
  return c.json({ data: r.length ? r[0].data : {} });
});

router.put('/workspaces/:id/data', requireUser, async (c) => {
  const id = c.req.param('id')!;
  if (!(await membership(id, c.get('userId')))) return c.json({ error: 'アクセス権がありません' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const data = body && body.data && typeof body.data === 'object' ? body.data : {};
  await sql`
    insert into workspace_data (workspace_id, data, updated_at)
    values (${id}, ${JSON.stringify(data)}::jsonb, now())
    on conflict (workspace_id) do update set data = excluded.data, updated_at = now()`;
  return c.json({ ok: true });
});

export default router;
