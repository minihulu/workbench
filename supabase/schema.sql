-- =============================================================================
--  workbench · Supabase PostgreSQL schema
--  Phase 1 (design only) — copy-paste runnable in Supabase SQL Editor.
--
--  Target : Supabase Postgres 15+ (schema `public`, Auth schema `auth`)
--  Model  : one JSON document per user (mirrors legacy SQLite `sync.payload`)
--  Runtime: server.py connects with the SERVICE_ROLE key (bypasses RLS).
--           RLS below is defense-in-depth against anon / authenticated access.
--  Idempotent: safe to re-run.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. profiles — username <-> auth.users mapping + legacy traceability
--    Replaces the legacy SQLite `users` table (minus salt/verifier/token,
--    which move to Supabase Auth / stateless JWT respectively).
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
    uid          uuid   primary key references auth.users (id) on delete cascade,
    username     text   not null,
    auth_email   text   not null,
    legacy_uid   text,
    token_epoch  bigint not null default 0,
    created_at   bigint not null default 0,
    constraint profiles_username_key    unique (username),
    constraint profiles_auth_email_key  unique (auth_email),
    constraint profiles_username_len    check (char_length(username) between 1 and 64),
    constraint profiles_token_epoch_pos check (token_epoch >= 0)
);

comment on table  public.profiles              is 'username -> auth.users mapping; legacy 32-hex uid kept for traceability';
comment on column public.profiles.uid          is 'Supabase auth.users.id (uuid) — primary identity everywhere';
comment on column public.profiles.username     is 'login name typed by the user (case-sensitive, matches legacy SQLite semantics)';
comment on column public.profiles.auth_email   is 'synthetic or real email used as the Supabase Auth identifier for this username';
comment on column public.profiles.legacy_uid   is 'old 32-hex uid from wb.db users.uid (NULL for accounts created after migration)';
comment on column public.profiles.token_epoch  is 'bumped on logout / refresh / admin reset-token; self-signed JWTs carrying an older epoch are rejected';
comment on column public.profiles.created_at   is 'unix seconds (bigint) — same contract as the frontend';

-- -----------------------------------------------------------------------------
-- 2. sync — the single JSON business document per user
--    payload top-level keys: times, ideas, notes, diary, cog_reads, cog_books,
--                            cog_thoughts, cog_reviews, directions, reviews, settings
-- -----------------------------------------------------------------------------
create table if not exists public.sync (
    uid             uuid   primary key references auth.users (id) on delete cascade,
    payload         jsonb  not null default '{}'::jsonb,
    payload_version integer not null default 0,
    updated_at      bigint not null default 0,
    constraint sync_payload_is_object   check (jsonb_typeof(payload) = 'object'),
    constraint sync_payload_version_pos check (payload_version >= 0),
    constraint sync_updated_at_pos      check (updated_at >= 0)
);

comment on table  public.sync                 is 'one row per user; all business data lives in payload (jsonb)';
comment on column public.sync.payload         is 'full JSON document — record arrays + settings object';
comment on column public.sync.payload_version is 'optimistic-lock counter; server.py does UPDATE ... WHERE uid=? AND payload_version=?';
comment on column public.sync.updated_at      is 'unix seconds (bigint) — returned verbatim to the frontend as "updated"';

-- -----------------------------------------------------------------------------
-- 3. invites — invite-code registration (0 rows today, kept for parity)
--    created_by : who generated the code (admin / owner)
--    used_by    : who consumed it  (mirrors legacy SQLite invites.used_by)
-- -----------------------------------------------------------------------------
create table if not exists public.invites (
    code       text   primary key,
    created_by uuid   references auth.users (id) on delete set null,
    created_at bigint not null default 0,
    used_by    uuid   references auth.users (id) on delete set null,
    used_at    bigint,
    constraint invites_code_len check (char_length(code) between 1 and 128)
);

comment on table  public.invites            is 'invite codes for registration; managed by service_role only';
comment on column public.invites.used_by    is 'auth.users.id that consumed the code (legacy column parity)';
comment on column public.invites.created_at is 'unix seconds (bigint)';
comment on column public.invites.used_at    is 'unix seconds (bigint), NULL while unused';

-- -----------------------------------------------------------------------------
-- 4. Indexes
--    - profiles.username / profiles.auth_email : covered by UNIQUE constraints
--    - sync.uid / invites.code                 : covered by PRIMARY KEY
--    Extra indexes below are optional but cheap at this data volume.
-- -----------------------------------------------------------------------------
create index if not exists idx_sync_updated_at     on public.sync      (updated_at desc);
create index if not exists idx_profiles_legacy_uid on public.profiles  (legacy_uid) where legacy_uid is not null;
create index if not exists idx_invites_unused     on public.invites   (code)       where used_at is null;

-- NOTE: intentionally NO GIN index on sync.payload.
-- The document is only ever read/written whole by primary key (uid); a GIN
-- index would only add write amplification on every push.

-- -----------------------------------------------------------------------------
-- 5. Row Level Security
--    server.py uses the service_role key, which bypasses RLS entirely.
--    These policies exist so that a leaked anon key cannot read anything,
--    and so that a future direct-from-client access path is owner-scoped.
-- -----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.sync     enable row level security;
alter table public.invites  enable row level security;

-- Optional hardening: also apply RLS to the table owner (not needed for
-- service_role, which is BYPASSRLS). Uncomment only if you know why.
-- alter table public.profiles force row level security;
-- alter table public.sync     force row level security;
-- alter table public.invites  force row level security;

-- ---- sync : owner-only ----
drop policy if exists sync_select_own on public.sync;
create policy sync_select_own on public.sync
    for select to authenticated
    using (auth.uid() = uid);

drop policy if exists sync_insert_own on public.sync;
create policy sync_insert_own on public.sync
    for insert to authenticated
    with check (auth.uid() = uid);

drop policy if exists sync_update_own on public.sync;
create policy sync_update_own on public.sync
    for update to authenticated
    using (auth.uid() = uid)
    with check (auth.uid() = uid);

-- no DELETE policy on purpose: rows disappear only via auth.users cascade.

-- ---- profiles : owner read + limited owner update ----
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
    for select to authenticated
    using (auth.uid() = uid);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
    for update to authenticated
    using (auth.uid() = uid)
    with check (auth.uid() = uid);

-- no INSERT policy: profiles rows are provisioned by server.py (service_role)
-- during signup / migration only. Username uniqueness is enforced by the
-- UNIQUE constraint above, not by RLS.

-- ---- invites : service_role only ----
-- RLS is enabled with ZERO policies for anon/authenticated => deny-all.
-- service_role bypasses RLS and can therefore manage invites freely.

-- -----------------------------------------------------------------------------
-- 6. Grants — least privilege for the anon role
-- -----------------------------------------------------------------------------
revoke all on public.sync     from anon;
revoke all on public.profiles from anon;
revoke all on public.invites  from anon, authenticated;

grant select, insert, update on public.sync     to authenticated;
grant select, update          on public.profiles to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Realtime — RESERVED FOR PHASE 5, NOT ENABLED NOW
--    When Phase 5 lands, run the two statements below to publish `sync`
--    UPDATE events, then have server.py subscribe (postgres_changes) and
--    bridge them into the existing per-uid SSE subscriber fan-out.
--
--    alter publication supabase_realtime add table public.sync;
--    alter table public.sync replica identity full;  -- needed for `old_record`
--
--    Rollback:
--    alter publication supabase_realtime drop table public.sync;
--    alter table public.sync replica identity default;
-- -----------------------------------------------------------------------------

commit;

-- =============================================================================
-- 8. Verification (run after commit)
-- =============================================================================
-- select schemaname, tablename, policyname, cmd, roles
--   from pg_policies where schemaname = 'public' order by tablename, policyname;
--
-- select relname, relrowsecurity, relforcerowsecurity
--   from pg_class where relname in ('sync','profiles','invites');
--
-- -- must return 0 rows before Phase 5:
-- select * from pg_publication_tables
--  where pubname = 'supabase_realtime' and tablename = 'sync';
