import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  console.warn('[ayanu] DATABASE_URL is not set — database calls will fail.');
}

// Tagged-template query function: await sql`select ...` -> rows.
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, any>[]>;

let sqlImpl: Sql;

if (process.env.AYANU_PG_TEST) {
  // Test-only: back the tagged-template `sql` with node-postgres against a local
  // Postgres (the Neon HTTP driver can't talk to a vanilla Postgres). Production
  // always uses the Neon driver below.
  const { Pool } = await import('pg' as string); // optional dev dependency, untyped
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  sqlImpl = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += '$' + (i + 1) + strings[i + 1];
    const res = await pool.query(text, values);
    return res.rows;
  };
} else {
  // Neon serverless HTTP driver. Use as a tagged template: await sql`select ...`
  sqlImpl = neon(process.env.DATABASE_URL!) as unknown as Sql;
}

export const sql = sqlImpl;
