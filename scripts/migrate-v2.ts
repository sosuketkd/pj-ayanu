// Migrate v1 data (app_state JSON blob per user) into the v2 workspace tables.
// Idempotent: skips users that already have any workspace membership.
// Usage: DATABASE_URL=... node scripts/migrate-v2.js
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket as any; // Node 18+/24 native WebSocket

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const pool = new Pool({ connectionString: url });

try {
  const { rows: states } = await pool.query('select user_id, data from app_state');
  let migratedUsers = 0, migratedWs = 0;

  for (const st of states) {
    const { rows: mem } = await pool.query(
      'select 1 from workspace_members where user_id = $1 limit 1', [st.user_id]);
    if (mem.length) continue; // already migrated

    const workspaces = (st.data && st.data.workspaces) || {};
    const entries: any[] = Object.values(workspaces);
    if (!entries.length) continue;

    for (const w of entries) {
      const { rows: wr } = await pool.query(
        `insert into workspaces (name, kind, created_by) values ($1, 'personal', $2) returning id`,
        [w.name || 'マイワークスペース', st.user_id]);
      const wsId = wr[0].id;
      await pool.query(
        `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')`,
        [wsId, st.user_id]);
      await pool.query(
        `insert into workspace_data (workspace_id, data) values ($1, $2::jsonb)`,
        [wsId, JSON.stringify({ tickets: w.tickets || {}, ac: w.ac || [] })]);
      migratedWs++;
    }
    migratedUsers++;
    console.log(`migrated user ${st.user_id}: ${entries.length} workspace(s)`);
  }
  console.log(`Done. ${migratedUsers} user(s), ${migratedWs} workspace(s) migrated.`);
} finally {
  await pool.end();
}
