-- 綾整(Ayanu) database schema (PostgreSQL / Neon)
create extension if not exists pgcrypto;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique not null,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

-- Whole client "store" (workspaces + tickets + AfterCheck) saved per user as JSON.
create table if not exists app_state (
  user_id    uuid primary key references users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
