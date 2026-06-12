-- 綾整(Ayanu) database schema (PostgreSQL / Neon)
create extension if not exists pgcrypto;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text,                                   -- null for social-login-only accounts
  username      text,                                   -- display name (editable)
  handle        text unique,                            -- public user ID, set once then immutable
  notifications jsonb not null default '{}'::jsonb,     -- per-user notification preferences
  created_at    timestamptz not null default now()
);

-- Bring existing installs up to date (idempotent).
alter table users add column if not exists username text;
alter table users add column if not exists handle text unique;
alter table users add column if not exists notifications jsonb not null default '{}'::jsonb;
alter table users alter column password_hash drop not null;
-- TOTP two-factor: secret is held from setup; enabled flips true once a code is verified.
alter table users add column if not exists totp_secret text;
alter table users add column if not exists totp_enabled boolean not null default false;

-- Email addresses owned by a user (GitHub-style: one account, many emails).
-- users.email mirrors the current primary. Invite-accepted and OAuth emails are
-- auto-verified; self-added emails stay unverified until confirmed (SES, later).
create table if not exists user_emails (
  user_id    uuid references users(id) on delete cascade,
  email      text not null,
  verified   boolean not null default false,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, email)
);
-- An email belongs to at most one account (case-insensitive).
create unique index if not exists user_emails_email_uq on user_emails(lower(email));

-- Backfill each existing user's login email as their verified primary (idempotent).
insert into user_emails (user_id, email, verified, is_primary)
select id, email, true, true from users
on conflict (user_id, email) do nothing;

-- Social-login identities linked to a user (Google / GitHub). One user can have several.
create table if not exists oauth_accounts (
  provider         text not null,                         -- 'google' | 'github'
  provider_user_id text not null,                         -- stable id from the provider
  user_id          uuid references users(id) on delete cascade,
  created_at       timestamptz not null default now(),
  primary key (provider, provider_user_id)
);
create index if not exists oauth_accounts_user_idx on oauth_accounts(user_id);

-- v1 storage, kept only as a migration source (superseded by workspace_data below)
create table if not exists app_state (
  user_id    uuid primary key references users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- A workspace is a shareable container of TD pages (tickets) + AfterCheck.
create table if not exists workspaces (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  kind         text not null default 'team',        -- 'personal' | 'team'
  created_by   uuid references users(id) on delete set null,
  invite_token text unique,                          -- shareable invite link (null = disabled)
  invite_role  text not null default 'member',       -- role granted by the link
  created_at   timestamptz not null default now()
);

-- Membership + role of each user in a workspace.
create table if not exists workspace_members (
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id      uuid references users(id) on delete cascade,
  role         text not null default 'member',       -- 'owner' | 'admin' | 'member'
  contact_email text,                                 -- which of the user's emails represents them here (null = primary)
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on workspace_members(user_id);
-- Bring existing installs up to date (idempotent).
alter table workspace_members add column if not exists contact_email text;

-- v1.5 storage: one shared blob per workspace. Superseded by member_data below
-- (kept only as a migration source).
create table if not exists workspace_data (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

-- Per-member content (tickets + AfterCheck). Each member keeps their OWN TD in a
-- workspace, and team admins can read everyone's (oversight). Personal workspaces
-- just have the single owner row.
create table if not exists member_data (
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id      uuid references users(id) on delete cascade,
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- Migrate the old shared blob to the workspace owner (idempotent).
insert into member_data (workspace_id, user_id, data)
select wd.workspace_id, w.created_by, wd.data
from workspace_data wd join workspaces w on w.id = wd.workspace_id
where w.created_by is not null
on conflict (workspace_id, user_id) do nothing;

-- Pending email invitations (single-use, accepted by the matching logged-in user).
create table if not exists invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  email        text not null,
  role         text not null default 'member',
  token        text unique not null,
  invited_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz
);
create index if not exists invitations_email_idx on invitations(lower(email));
