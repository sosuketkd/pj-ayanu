// Shared helpers used across route modules.
import { sql } from './lib/db.js';

// Role hierarchy for permission checks.
export const ROLE_RANK = { member: 1, admin: 2, owner: 3 };
export function atLeast(role, min) { return !!role && ROLE_RANK[role] >= ROLE_RANK[min]; }

export function validEmail(s) { return typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s); }

// Base URL used to build invite links in emails (falls back to the request origin).
export function baseUrl(c) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  try { return new URL(c.req.url).origin; } catch { return ''; }
}

// Returns the caller's role in a workspace, or null if not a member.
export async function membership(workspaceId, userId) {
  const r = await sql`select role from workspace_members where workspace_id=${workspaceId} and user_id=${userId}`;
  return r.length ? r[0].role : null;
}
