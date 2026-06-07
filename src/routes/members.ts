// Member routes: change a member's role / remove a member or leave the workspace.
import { Hono } from 'hono';
import { sql } from '../lib/db.js';
import { requireUser } from '../middleware/auth.js';
import { atLeast, membership } from '../utils.js';
import type { AppEnv } from '../types.js';

const router = new Hono<AppEnv>();

router.patch('/workspaces/:id/members/:userId', requireUser, async (c) => {
  const id = c.req.param('id')!, target = c.req.param('userId')!, me = c.get('userId');
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
router.delete('/workspaces/:id/members/:userId', requireUser, async (c) => {
  const id = c.req.param('id')!, target = c.req.param('userId')!, me = c.get('userId');
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

export default router;
