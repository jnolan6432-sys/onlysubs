alter table public.seasons
  add column timezone text not null default 'America/Los_Angeles';

update public.seasons
set timezone = timezone_name;

alter table public.profiles
  add column timezone text;

grant update (timezone) on public.profiles to authenticated;

alter table public.seasons
  alter column daytime_end_hour set default 22;

create or replace function public.sync_season_timezone_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.timezone is distinct from 'America/Los_Angeles' then
      new.timezone_name := new.timezone;
    else
      new.timezone := new.timezone_name;
    end if;
  elsif new.timezone is distinct from old.timezone then
    new.timezone_name := new.timezone;
  elsif new.timezone_name is distinct from old.timezone_name then
    new.timezone := new.timezone_name;
  end if;
  return new;
end;
$$;

create trigger sync_season_timezone_columns
  before insert or update of timezone, timezone_name on public.seasons
  for each row execute procedure public.sync_season_timezone_columns();

alter table public.sub_requests
  add column ping_not_before timestamptz not null default now();

create or replace function public.next_active_daytime_start(
  p_at timestamptz,
  p_start_hour integer,
  p_end_hour integer,
  p_timezone text
)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_local timestamp;
  v_start timestamp;
begin
  if p_start_hour not between 0 and 23
     or p_end_hour not between 1 and 24
     or p_start_hour >= p_end_hour
     or not exists (
       select 1 from pg_timezone_names where name = p_timezone
     ) then
    raise exception 'Invalid daytime window or timezone';
  end if;

  v_local := p_at at time zone p_timezone;
  if extract(hour from v_local)::integer >= p_start_hour
     and extract(hour from v_local)::integer < p_end_hour then
    return p_at;
  end if;

  v_start := date_trunc('day', v_local) + make_interval(hours => p_start_hour);
  if v_local >= date_trunc('day', v_local) + make_interval(hours => p_end_hour) then
    v_start := v_start + interval '1 day';
  end if;
  return v_start at time zone p_timezone;
end;
$$;

revoke all on function public.next_active_daytime_start(timestamptz, integer, integer, text)
  from public, anon, authenticated;

alter function public.advance_sub_request(uuid)
  rename to advance_sub_request_before_player_timezone;

revoke all on function public.advance_sub_request_before_player_timezone(uuid)
  from public, anon, authenticated;

create function public.advance_sub_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event jsonb;
  v_timezone text;
  v_start_hour integer;
  v_end_hour integer;
  v_timeout integer;
  v_dispatch_at timestamptz;
  v_expires_at timestamptz;
  v_candidate_id uuid;
begin
  v_event := public.advance_sub_request_before_player_timezone(p_request_id);
  if v_event is null or v_event->>'event' is distinct from 'ping' then
    return v_event;
  end if;

  v_candidate_id := (v_event->>'recipient_user_id')::uuid;
  select coalesce(profile.timezone, season.timezone),
         season.daytime_start_hour,
         season.daytime_end_hour,
         season.timeout_hours
    into v_timezone, v_start_hour, v_end_hour, v_timeout
    from public.sub_requests request
    join public.seasons season on season.id = request.season_id
    join public.profiles profile on profile.id = v_candidate_id
    where request.id = p_request_id;
  if not found then
    raise exception 'Could not load ping candidate timezone';
  end if;

  v_dispatch_at := public.next_active_daytime_start(
    now(), v_start_hour, v_end_hour, v_timezone
  );
  v_expires_at := public.add_active_daytime_hours(
    now(), v_timeout, v_start_hour, v_end_hour, v_timezone
  );

  update public.sub_requests
  set ping_not_before = v_dispatch_at,
      ping_expires_at = v_expires_at,
      ping_notification_claimed_at = case
        when v_dispatch_at > now() then null
        else ping_notification_claimed_at
      end
  where id = p_request_id
    and current_pinged_user_id = v_candidate_id;

  if v_dispatch_at > now() then
    return null;
  end if;

  return jsonb_set(v_event, '{expires_at}', to_jsonb(v_expires_at), true);
end;
$$;

revoke all on function public.advance_sub_request(uuid)
  from public, anon, authenticated;

create or replace function public.run_sub_queue_worker(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request record;
  v_events jsonb := '[]'::jsonb;
  v_event jsonb;
  v_processed integer := 0;
  v_timezone text;
  v_start_hour integer;
  v_end_hour integer;
  v_timeout integer;
  v_dispatch_at timestamptz;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role is required';
  end if;
  if p_limit < 1 or p_limit > 200 then
    raise exception 'Worker batch size must be between 1 and 200';
  end if;

  for v_request in
    select r.id
    from public.sub_requests r
    join public.games g on g.id = r.game_id
    where r.status in ('searching_primary', 'searching_fallback')
      and (
        r.current_pinged_user_id is null
        or (
          r.current_pinged_user_id is not null
          and r.ping_expires_at <= now()
        )
        or (
          r.current_pinged_user_id is not null
          and r.ping_not_before <= now()
          and r.ping_notification_sent_at is null
          and (
            r.ping_notification_claimed_at is null
            or r.ping_notification_claimed_at < now() - interval '2 minutes'
          )
        )
      )
    order by g.game_date asc, g.start_time asc, r.created_at asc
    limit p_limit
  loop
    v_processed := v_processed + 1;
    perform 1 from public.sub_requests where id = v_request.id for update;

    update public.sub_requests
    set current_pinged_user_id = null,
        ping_expires_at = null,
        ping_not_before = now(),
        ping_notification_sent_at = null,
        ping_notification_claimed_at = null
    where id = v_request.id
      and status in ('searching_primary', 'searching_fallback')
      and current_pinged_user_id is not null
      and ping_expires_at <= now();

    if exists (
      select 1 from public.sub_requests
      where id = v_request.id
        and current_pinged_user_id is not null
        and ping_not_before <= now()
        and ping_notification_sent_at is null
        and (
          ping_notification_claimed_at is null
          or ping_notification_claimed_at < now() - interval '2 minutes'
        )
    ) then
      select coalesce(profile.timezone, season.timezone),
             season.daytime_start_hour,
             season.daytime_end_hour,
             season.timeout_hours
        into v_timezone, v_start_hour, v_end_hour, v_timeout
        from public.sub_requests request
        join public.seasons season on season.id = request.season_id
        join public.profiles profile
          on profile.id = request.current_pinged_user_id
        where request.id = v_request.id;
      if not found then
        raise exception 'Could not load ping candidate timezone';
      end if;

      v_dispatch_at := public.next_active_daytime_start(
        now(), v_start_hour, v_end_hour, v_timezone
      );
      if v_dispatch_at > now() then
        update public.sub_requests
        set ping_not_before = v_dispatch_at,
            ping_expires_at = public.add_active_daytime_hours(
              now(), v_timeout, v_start_hour, v_end_hour, v_timezone
            ),
            ping_notification_claimed_at = null
        where id = v_request.id;
        v_event := null;
      else
        update public.sub_requests
        set ping_notification_claimed_at = now()
        where id = v_request.id;
        select jsonb_build_object(
          'event', 'ping',
          'request_id', r.id,
          'recipient_user_id', r.current_pinged_user_id,
          'requester_id', r.requester_id,
          'game_id', g.id,
          'game_date', g.game_date,
          'start_time', g.start_time,
          'season_name', s.name,
          'expires_at', r.ping_expires_at
        )
          into v_event
          from public.sub_requests r
          join public.games g on g.id = r.game_id
          join public.seasons s on s.id = r.season_id
          where r.id = v_request.id;
      end if;
    else
      v_event := public.advance_sub_request(v_request.id);
    end if;

    if v_event is not null and v_event <> '{}'::jsonb then
      v_events := v_events || jsonb_build_array(v_event);
    end if;
  end loop;

  for v_request in
    select r.id, r.requester_id, r.game_id, g.game_date, g.start_time,
      r.admin_push_sent_at, r.admin_email_sent_at,
      s.name as season_name, s.created_by
    from public.sub_requests r
    join public.games g on g.id = r.game_id
    join public.seasons s on s.id = r.season_id
    where r.status = 'exhausted'
      and r.admin_alert_sent_at is null
      and (
        r.admin_alert_claimed_at is null
        or r.admin_alert_claimed_at < now() - interval '2 minutes'
      )
    order by g.game_date asc, g.start_time asc, r.created_at asc
    limit p_limit
  loop
    update public.sub_requests
    set admin_alert_claimed_at = now()
    where id = v_request.id;
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'event', 'exhausted',
      'push_needed', v_request.admin_push_sent_at is null,
      'email_needed', v_request.admin_email_sent_at is null,
      'request_id', v_request.id,
      'recipient_user_id', v_request.created_by,
      'requester_id', v_request.requester_id,
      'game_id', v_request.game_id,
      'game_date', v_request.game_date,
      'start_time', v_request.start_time,
      'season_name', v_request.season_name
    ));
  end loop;

  return jsonb_build_object('processed', v_processed, 'events', v_events);
end;
$$;

revoke all on function public.run_sub_queue_worker(integer)
  from public, anon, authenticated;
grant execute on function public.run_sub_queue_worker(integer)
  to service_role;
