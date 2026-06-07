-- 綾整(Ayanu) database schema (PostgreSQL / Neon)
create extension if not exists pgcrypto;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

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
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists workspace_members_user_idx on workspace_members(user_id);

-- The actual content (tickets + AfterCheck) of a workspace, stored as JSON.
create table if not exists workspace_data (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  data         jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

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
