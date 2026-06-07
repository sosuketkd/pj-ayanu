import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  console.warn('[ayanu] DATABASE_URL is not set — database calls will fail.');
}

// Neon serverless HTTP driver. Use as a tagged template: await sql`select ...`
export const sql = neon(process.env.DATABASE_URL);
