-- The director can look up the current scorer key from any device (scorer access is not secret from the director).
alter table public.ms_events add column if not exists scorer_key text;

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
  insert into public.ms_events (id, admin_hash, scorer_hash, scorer_key, created_ip)
    values (v_id, public.ms_hash(v_admin), public.ms_hash(v_scorer), v_scorer, nullif(v_ip, ''));
  return json_build_object('id', v_id, 'admin_key', v_admin, 'scorer_key', v_scorer);
end $$;

create or replace function public.ms_new_scorer_key(p_event text, p_key text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare v_scorer text;
begin
  if public.ms_role(p_event, p_key) <> 'admin' then raise exception 'not allowed' using errcode = '42501'; end if;
  v_scorer := public.ms_key();
  update public.ms_events set scorer_hash = public.ms_hash(v_scorer), scorer_key = v_scorer where id = p_event;
  return v_scorer;
end $$;

create or replace function public.ms_scorer_key(p_event text, p_key text) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if public.ms_role(p_event, p_key) <> 'admin' then raise exception 'not allowed' using errcode = '42501'; end if;
  return (select scorer_key from public.ms_events where id = p_event);
end $$;
grant execute on function public.ms_scorer_key(text, text) to anon, authenticated;
