// Shared helpers used across route modules.
import type { Context } from 'hono';
import { sql } from './lib/db.js';

export type Role = 'owner' | 'admin' | 'member';

// Role hierarchy for permission checks.
export const ROLE_RANK: Record<string, number> = { member: 1, admin: 2, owner: 3 };
export function atLeast(role: string | null | undefined, min: Role): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

export function validEmail(s: unknown): s is string {
  return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}

// Base URL used to build invite links in emails (falls back to the request origin).
export function baseUrl(c: Context): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  try { return new URL(c.req.url).origin; } catch { return ''; }
}

// Returns the caller's role in a workspace, or null if not a member.
export async function membership(workspaceId: string, userId: string): Promise<string | null> {
  const r = await sql`select role from workspace_members where workspace_id=${workspaceId} and user_id=${userId}`;
  return r.length ? (r[0].role as string) : null;
}

// The account that owns an email (across all users), or null. Case-insensitive.
export async function ownerOfEmail(email: string): Promise<string | null> {
  const r = await sql`select user_id from user_emails where lower(email) = ${email.toLowerCase()}`;
  return r.length ? (r[0].user_id as string) : null;
}

// True if the user owns this email and it is verified.
export async function ownsVerifiedEmail(userId: string, email: string): Promise<boolean> {
  const r = await sql`
    select 1 from user_emails where user_id = ${userId} and lower(email) = ${email.toLowerCase()} and verified`;
  return r.length > 0;
}
