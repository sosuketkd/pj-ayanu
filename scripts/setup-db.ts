// Initialize the database schema. Usage: DATABASE_URL=... npm run db:setup
import { Pool, neonConfig } from '@neondatabase/serverless';
import { readFile } from 'node:fs/promises';

// The http `neon()` client is tagged-template only (no raw `.query()`), so for
// running schema DDL we use the pg-compatible Pool over WebSocket.
neonConfig.webSocketConstructor = WebSocket as any; // Node 18+/24 native WebSocket

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }

const pool = new Pool({ connectionString: url });
const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8');
const statements = schema.split(';').map((s) => s.trim()).filter(Boolean);

try {
  for (const stmt of statements) {
    await pool.query(stmt);
    console.log('OK:', stmt.split('\n')[0].slice(0, 60));
  }
  console.log('Database setup complete.');
} finally {
  await pool.end();
}
