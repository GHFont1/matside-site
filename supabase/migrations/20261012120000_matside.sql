-- Matside tournaments. Every event's data is a set of JSON documents keyed by path
-- (event/main, entries/<id>, results/<id>, sheets/<id>, live/m<n>, locks/m<n>, calls/<id>, deductions/<id>).
-- Anyone can read; writes go through ms_put with the event's director or scorer key.
-- Deletes are stored as data = null so realtime subscribers see them.

create table if not exists public.ms_events (
  id text primary key,
  admin_hash text not null,
  scorer_hash text not null,
  created_at timestamptz not null default now(),
  created_ip text,
  last_write timestamptz not null default now()
);
alter table public.ms_events enable row level security;
revoke all on public.ms_events from anon, authenticated;

create table if not exists public.ms_docs (
  event_id text not null references public.ms_events(id) on delete cascade,
  path text not null,
  data jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (event_id, path)
);
create index if not exists ms_docs_event_updated on public.ms_docs (event_id, updated_at);
alter table public.ms_docs enable row level security;
revoke all on public.ms_docs from anon, authenticated;
grant select on public.ms_docs to anon, authenticated;
drop policy if exists ms_docs_read on public.ms_docs;
create policy ms_docs_read on public.ms_docs for select to anon, authenticated using (true);

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'ms_docs') then
    alter publication supabase_realtime add table public.ms_docs;
  end if;
end $$;

create or replace function public.ms_key() returns text language sql volatile as $$
  select translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/=', 'xyz')
$$;

create or replace function public.ms_hash(k text) returns text language sql immutable as $$
  select encode(extensions.digest(coalesce(k, ''), 'sha256'), 'hex')
$$;

create or replace function public.ms_client_ip() returns text language sql stable as $$
  select split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)
$$;

create or replace function public.ms_role(p_event text, p_key text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when e.id is null then 'none'
    when p_key is not null and e.admin_hash = public.ms_hash(p_key) then 'admin'
    when p_key is not null and e.scorer_hash = public.ms_hash(p_key) then 'scorer'
    else 'view' end
  from (select 1) one left join public.ms_events e on e.id = p_event
$$;

create or replace function public.ms_create_event() returns json
language plpgsql volatile security definer set search_path = public as $$
declare v_id text; v_admin text; v_scorer text; v_ip text := public.ms_client_ip();
begin
  if v_ip <> '' and (select count(*) from public.ms_events where created_ip = v_ip and created_at > now() - interval '1 day') >= 25 then
    raise exception 'Too many tournaments created from this network today' using errcode = 'P0001';
  end if;
  loop
    v_id := lower(substr(translate(encode(extensions.gen_random_bytes(8), 'base64'), '+/=', ''), 1, 8));
    exit when v_id ~ '^[a-z0-9]{8}$' and not exists (select 1 from public.ms_events where id = v_id);
  end loop;
  v_admin := public.ms_key(); v_scorer := public.ms_key();
  insert into public.ms_events (id, admin_hash, scorer_hash, created_ip)
    values (v_id, public.ms_hash(v_admin), public.ms_hash(v_scorer), nullif(v_ip, ''));
  return json_build_object('id', v_id, 'admin_key', v_admin, 'scorer_key', v_scorer);
end $$;

-- Director-only: issue a new scorer key (the old scorer link stops working).
create or replace function public.ms_new_scorer_key(p_event text, p_key text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_scorer text;
begin
  if public.ms_role(p_event, p_key) <> 'admin' then raise exception 'not allowed' using errcode = '42501'; end if;
  v_scorer := public.ms_key();
  update public.ms_events set scorer_hash = public.ms_hash(v_scorer) where id = p_event;
  return v_scorer;
end $$;

create or replace function public.ms_put(p_event text, p_key text, p_path text, p_data jsonb) returns timestamptz
language plpgsql volatile security definer set search_path = public as $$
declare v_role text := public.ms_role(p_event, p_key); v_at timestamptz := clock_timestamp();
begin
  if v_role not in ('admin', 'scorer') then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_path !~ '^(event/main|(entries|results|sheets|live|locks|calls|deductions)/[^/]{1,160})$' then
    raise exception 'bad path' using errcode = '22023';
  end if;
  if v_role = 'scorer' and split_part(p_path, '/', 1) not in ('results', 'sheets', 'live', 'locks', 'calls') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_data is not null and octet_length(p_data::text) > 1500000 then
    raise exception 'document too large' using errcode = '22023';
  end if;
  insert into public.ms_docs (event_id, path, data, updated_at) values (p_event, p_path, p_data, v_at)
    on conflict (event_id, path) do update set data = excluded.data, updated_at = excluded.updated_at;
  update public.ms_events set last_write = v_at where id = p_event and last_write < v_at - interval '1 minute';
  return v_at;
end $$;

create or replace function public.ms_health() returns json language sql stable security definer set search_path = public as $$
  select json_build_object('ok', true, 'events', (select count(*) from public.ms_events), 'at', now())
$$;

revoke all on function public.ms_key(), public.ms_hash(text), public.ms_client_ip() from public, anon, authenticated;
grant execute on function public.ms_role(text, text), public.ms_create_event(), public.ms_new_scorer_key(text, text),
  public.ms_put(text, text, text, jsonb), public.ms_health() to anon, authenticated;
