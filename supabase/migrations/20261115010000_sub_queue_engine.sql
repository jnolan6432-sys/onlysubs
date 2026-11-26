alter table public.seasons
  add column timezone_name text not null default 'America/Los_Angeles';

alter table public.sub_requests
  add column primary_candidates_seen uuid[] not null default '{}',
  add column fallback_candidates_seen uuid[] not null default '{}',
  add column ping_notification_sent_at timestamptz,
  add column ping_notification_claimed_at timestamptz,
  add column admin_alert_sent_at timestamptz,
  add column admin_alert_claimed_at timestamptz,
  add column admin_push_sent_at timestamptz,
  add column admin_email_sent_at timestamptz;

create or replace function public.prevent_pending_ping_availability_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'available'
     and new.status = 'unavailable'
     and exists (
       select 1
       from public.sub_requests r
       where r.game_id = new.game_id
         and r.current_pinged_user_id = new.user_id
         and r.status in ('searching_primary', 'searching_fallback')
     ) then
    raise exception 'Respond to your pending sub ping before changing availability';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_pending_ping_availability_change()
  from public, anon, authenticated;

create trigger prevent_pending_ping_availability_change
  before update of status on public.game_commitments
  for each row execute procedure public.prevent_pending_ping_availability_change();

create or replace function public.set_season_timezone(
  p_season_id uuid,
  p_timezone_name text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;
  if not exists (
    select 1 from pg_timezone_names where name = p_timezone_name
  ) then
    raise exception 'Choose a valid IANA timezone';
  end if;

  update public.seasons
  set timezone_name = p_timezone_name
  where id = p_season_id;
  if not found then
    raise exception 'Season not found';
  end if;
end;
$$;

revoke all on function public.set_season_timezone(uuid, text) from public, anon;
grant execute on function public.set_season_timezone(uuid, text) to authenticated;

create or replace function public.publish_season_with_timezone(
  p_payload jsonb,
  p_timezone_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_season_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;
  if not exists (
    select 1 from pg_timezone_names where name = p_timezone_name
  ) then
    raise exception 'Choose a valid IANA timezone';
  end if;

  v_result := public.publish_season(p_payload);
  v_season_id := (v_result->>'season_id')::uuid;
  update public.seasons
  set timezone_name = p_timezone_name
  where id = v_season_id;
  if not found then
    raise exception 'Season not found';
  end if;
  return v_result;
end;
$$;

revoke all on function public.publish_season_with_timezone(jsonb, text)
  from public, anon;
grant execute on function public.publish_season_with_timezone(jsonb, text)
  to authenticated;

create or replace function public.add_active_daytime_hours(
  p_started_at timestamptz,
  p_hours integer,
  p_start_hour integer,
  p_end_hour integer,
  p_timezone_name text
)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_cursor timestamptz := p_started_at;
  v_remaining interval := make_interval(hours => p_hours);
  v_local timestamp;
  v_boundary_local timestamp;
  v_boundary timestamptz;
  v_step interval;
begin
  if p_hours <= 0 then
    return p_started_at;
  end if;
  if p_start_hour not between 0 and 23
     or p_end_hour not between 1 and 24
     or p_start_hour >= p_end_hour
     or not exists (
       select 1 from pg_timezone_names where name = p_timezone_name
     ) then
    raise exception 'Invalid daytime window or timezone';
  end if;

  while v_remaining > interval '0 seconds' loop
    v_local := v_cursor at time zone p_timezone_name;
    if extract(hour from v_local)::integer >= p_start_hour
       and extract(hour from v_local)::integer < p_end_hour then
      v_boundary_local :=
        date_trunc('day', v_local) + make_interval(hours => p_end_hour);
      v_boundary := v_boundary_local at time zone p_timezone_name;
      if v_boundary <= v_cursor then
        v_boundary_local :=
          date_trunc('day', v_local) + interval '1 day'
          + make_interval(hours => p_start_hour);
        v_boundary := v_boundary_local at time zone p_timezone_name;
      end if;
      v_step := least(v_remaining, v_boundary - v_cursor);
      v_cursor := v_cursor + v_step;
      v_remaining := v_remaining - v_step;
    else
      if v_local < date_trunc('day', v_local) + make_interval(hours => p_start_hour) then
        v_boundary_local :=
          date_trunc('day', v_local) + make_interval(hours => p_start_hour);
      else
        v_boundary_local :=
          date_trunc('day', v_local) + interval '1 day'
          + make_interval(hours => p_start_hour);
      end if;
      v_cursor := v_boundary_local at time zone p_timezone_name;
    end if;
  end loop;

  return v_cursor;
end;
$$;

revoke all on function public.add_active_daytime_hours(timestamptz, integer, integer, integer, text)
  from public, anon, authenticated;

create or replace function public.advance_sub_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.sub_requests%rowtype;
  v_season public.seasons%rowtype;
  v_game public.games%rowtype;
  v_queue public.season_queue_state%rowtype;
  v_target_gender text;
  v_seen uuid[];
  v_candidate_id uuid;
  v_queue_length integer;
  v_cursor integer;
  v_reordered_ids uuid[];
  v_candidate_available boolean;
  v_commitment_status text;
  v_candidate_has_same_day_ping boolean;
  v_event jsonb;
begin
  select r.*
    into v_request
    from public.sub_requests r
    where r.id = p_request_id
    for update;
  if not found
     or v_request.status not in ('searching_primary', 'searching_fallback')
     or v_request.current_pinged_user_id is not null then
    return null;
  end if;

  select g.* into v_game
  from public.games g
  where g.id = v_request.game_id;
  if not found or v_game.cancelled_at is not null then
    update public.sub_requests
    set status = 'cancelled'
    where id = p_request_id;
    return jsonb_build_object(
      'event', 'cancelled',
      'request_id', p_request_id,
      'requester_id', v_request.requester_id
    );
  end if;

  select s.* into v_season
  from public.seasons s
  where s.id = v_request.season_id;
  if not found then
    update public.sub_requests set status = 'cancelled' where id = p_request_id;
    return null;
  end if;

  loop
    v_target_gender := case
      when v_request.status = 'searching_primary' then v_request.needed_gender
      when v_request.needed_gender = 'FMP' then 'MMP'
      else 'FMP'
    end;
    v_seen := case
      when v_request.status = 'searching_primary'
        then v_request.primary_candidates_seen
      else v_request.fallback_candidates_seen
    end;

    insert into public.season_queue_state (season_id, gender_match)
    values (v_request.season_id, v_target_gender)
    on conflict (season_id, gender_match) do nothing;

    select q.*
      into v_queue
      from public.season_queue_state q
      where q.season_id = v_request.season_id
        and q.gender_match = v_target_gender
      for update;

    v_queue_length := cardinality(v_queue.ordered_user_ids);
    if v_queue_length = 0 or not exists (
      select 1
      from unnest(v_queue.ordered_user_ids) as listed(user_id)
      where not (listed.user_id = any(v_seen))
    ) then
      if v_request.status = 'searching_primary' then
        update public.sub_requests
        set status = 'searching_fallback'
        where id = p_request_id
        returning * into v_request;
        continue;
      end if;

      update public.sub_requests
      set status = 'exhausted',
          current_pinged_user_id = null,
          ping_expires_at = null,
          ping_notification_claimed_at = null,
          admin_alert_claimed_at = now(),
          admin_push_sent_at = null,
          admin_email_sent_at = null
      where id = p_request_id
      returning * into v_request;
      return jsonb_build_object(
        'event', 'exhausted',
        'push_needed', true,
        'email_needed', true,
        'request_id', p_request_id,
        'recipient_user_id', v_season.created_by,
        'requester_id', v_request.requester_id,
        'game_date', v_game.game_date,
        'start_time', v_game.start_time,
        'season_name', v_season.name
      );
    end if;

    v_cursor := v_queue.current_cursor_index;
    if v_cursor >= v_queue_length then
      select coalesce(
        array_agg(
          listed.user_id
          order by
            case
              when coalesce(stats.pings_received, 0) = 0 then 0::numeric
              else stats.pings_answered_in_time::numeric
                / stats.pings_received::numeric
            end desc,
            profile.onboarded_at asc nulls last,
            listed.user_id
        ),
        '{}'::uuid[]
      )
        into v_reordered_ids
        from unnest(v_queue.ordered_user_ids) as listed(user_id)
        join public.season_pool_members membership
          on membership.season_id = v_request.season_id
          and membership.user_id = listed.user_id
        join public.profiles profile on profile.id = listed.user_id
        left join public.player_season_stats stats
          on stats.season_id = v_request.season_id
          and stats.user_id = listed.user_id;

      update public.season_queue_state
      set ordered_user_ids = v_reordered_ids,
          current_cursor_index = 0
      where id = v_queue.id
      returning * into v_queue;
      v_queue_length := cardinality(v_queue.ordered_user_ids);
      v_cursor := 0;

      if v_queue_length = 0 or not exists (
        select 1
        from unnest(v_queue.ordered_user_ids) as listed(user_id)
        where not (listed.user_id = any(v_seen))
      ) then
        if v_request.status = 'searching_primary' then
          update public.sub_requests
          set status = 'searching_fallback'
          where id = p_request_id
          returning * into v_request;
          continue;
        end if;

        update public.sub_requests
        set status = 'exhausted',
            current_pinged_user_id = null,
            ping_expires_at = null,
            ping_notification_claimed_at = null,
            admin_alert_claimed_at = now(),
            admin_push_sent_at = null,
            admin_email_sent_at = null
        where id = p_request_id
        returning * into v_request;
        return jsonb_build_object(
          'event', 'exhausted',
          'push_needed', true,
          'email_needed', true,
          'request_id', p_request_id,
          'recipient_user_id', v_season.created_by,
          'requester_id', v_request.requester_id,
          'game_date', v_game.game_date,
          'start_time', v_game.start_time,
          'season_name', v_season.name
        );
      end if;
    end if;

    v_candidate_id := v_queue.ordered_user_ids[v_cursor + 1];
    v_cursor := v_cursor + 1;
    update public.season_queue_state
    set current_cursor_index = v_cursor
    where id = v_queue.id;

    if v_cursor >= v_queue_length then
      select coalesce(
        array_agg(
          listed.user_id
          order by
            case
              when coalesce(stats.pings_received, 0) = 0 then 0::numeric
              else stats.pings_answered_in_time::numeric
                / stats.pings_received::numeric
            end desc,
            profile.onboarded_at asc nulls last,
            listed.user_id
        ),
        '{}'::uuid[]
      )
        into v_reordered_ids
        from unnest(v_queue.ordered_user_ids) as listed(user_id)
        join public.season_pool_members membership
          on membership.season_id = v_request.season_id
          and membership.user_id = listed.user_id
        join public.profiles profile on profile.id = listed.user_id
        left join public.player_season_stats stats
          on stats.season_id = v_request.season_id
          and stats.user_id = listed.user_id;

      update public.season_queue_state
      set ordered_user_ids = v_reordered_ids,
          current_cursor_index = 0
      where id = v_queue.id;
    end if;

    if v_candidate_id = any(v_seen) then
      continue;
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(v_candidate_id::text || ':' || v_game.game_date::text, 0)
    );

    select c.status
      into v_commitment_status
      from public.game_commitments c
      where c.game_id = v_game.id
        and c.user_id = v_candidate_id
      for update;
    v_candidate_available := found and v_commitment_status = 'available';

    select exists (
      select 1
      from public.sub_requests other_request
      join public.games other_game on other_game.id = other_request.game_id
      where other_request.id <> p_request_id
        and other_request.current_pinged_user_id = v_candidate_id
        and other_request.status in ('searching_primary', 'searching_fallback')
        and other_game.game_date = v_game.game_date
    )
      into v_candidate_has_same_day_ping;

    if not v_candidate_available or v_candidate_has_same_day_ping then
      if v_request.status = 'searching_primary' then
        update public.sub_requests
        set primary_candidates_seen = array_append(primary_candidates_seen, v_candidate_id)
        where id = p_request_id
        returning * into v_request;
      else
        update public.sub_requests
        set fallback_candidates_seen = array_append(fallback_candidates_seen, v_candidate_id)
        where id = p_request_id
        returning * into v_request;
      end if;
      continue;
    end if;

    if v_request.status = 'searching_primary' then
      update public.sub_requests
      set primary_candidates_seen = array_append(primary_candidates_seen, v_candidate_id)
      where id = p_request_id
      returning * into v_request;
    else
      update public.sub_requests
      set fallback_candidates_seen = array_append(fallback_candidates_seen, v_candidate_id)
      where id = p_request_id
      returning * into v_request;
    end if;

    insert into public.player_season_stats (season_id, user_id, pings_received)
    values (v_request.season_id, v_candidate_id, 1)
    on conflict (season_id, user_id)
    do update set pings_received = public.player_season_stats.pings_received + 1;

    update public.sub_requests
    set current_pinged_user_id = v_candidate_id,
        ping_expires_at = public.add_active_daytime_hours(
          now(),
          v_season.timeout_hours,
          v_season.daytime_start_hour,
          v_season.daytime_end_hour,
          v_season.timezone_name
        ),
        ping_notification_sent_at = null,
        ping_notification_claimed_at = now()
    where id = p_request_id
    returning * into v_request;

    return jsonb_build_object(
      'event', 'ping',
      'request_id', p_request_id,
      'recipient_user_id', v_candidate_id,
      'requester_id', v_request.requester_id,
      'game_id', v_game.id,
      'game_date', v_game.game_date,
      'start_time', v_game.start_time,
      'season_name', v_season.name,
      'expires_at', v_request.ping_expires_at
    );
  end loop;
end;
$$;

revoke all on function public.advance_sub_request(uuid) from public, anon, authenticated;

create or replace function public.process_own_sub_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.sub_requests%rowtype;
  v_event jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to process this substitute request';
  end if;

  select r.* into v_request
  from public.sub_requests r
  where r.id = p_request_id
    and r.requester_id = auth.uid();
  if not found then
    raise exception 'Substitute request not found';
  end if;

  v_event := public.advance_sub_request(p_request_id);
  return coalesce(v_event, '{}'::jsonb);
end;
$$;

revoke all on function public.process_own_sub_request(uuid) from public, anon;
revoke all on function public.process_own_sub_request(uuid) from authenticated;

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
        or r.ping_expires_at <= now()
        or (
          r.ping_notification_sent_at is null
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
        and ping_notification_sent_at is null
        and (
          ping_notification_claimed_at is null
          or ping_notification_claimed_at < now() - interval '2 minutes'
        )
    ) then
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

revoke all on function public.run_sub_queue_worker(integer) from public, anon, authenticated;
grant execute on function public.run_sub_queue_worker(integer) to service_role;

create or replace function public.mark_sub_queue_notification(
  p_request_id uuid,
  p_recipient_user_id uuid,
  p_event_type text,
  p_delivered boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role is required';
  end if;

  if p_event_type = 'ping' then
    update public.sub_requests
    set ping_notification_sent_at = case when p_delivered then now() else null end,
        ping_notification_claimed_at = null
    where id = p_request_id
      and current_pinged_user_id = p_recipient_user_id
      and status in ('searching_primary', 'searching_fallback');
  elsif p_event_type = 'exhausted_push' then
    update public.sub_requests
    set admin_push_sent_at = case when p_delivered then now() else admin_push_sent_at end,
        admin_alert_sent_at = case
          when (p_delivered or admin_push_sent_at is not null)
            and admin_email_sent_at is not null then now()
          else null
        end,
        admin_alert_claimed_at = case
          when p_delivered and admin_email_sent_at is not null then null
          else admin_alert_claimed_at
        end
    where id = p_request_id
      and status = 'exhausted';
  elsif p_event_type = 'exhausted_email' then
    update public.sub_requests
    set admin_email_sent_at = case when p_delivered then now() else admin_email_sent_at end,
        admin_alert_sent_at = case
          when (p_delivered or admin_email_sent_at is not null)
            and admin_push_sent_at is not null then now()
          else null
        end,
        admin_alert_claimed_at = case
          when p_delivered and admin_push_sent_at is not null then null
          else admin_alert_claimed_at
        end
    where id = p_request_id
      and status = 'exhausted';
  end if;
end;
$$;

revoke all on function public.mark_sub_queue_notification(uuid, uuid, text, boolean)
  from public, anon, authenticated;
grant execute on function public.mark_sub_queue_notification(uuid, uuid, text, boolean)
  to service_role;

create or replace function public.respond_to_sub_ping(
  p_request_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.sub_requests%rowtype;
  v_commitment public.game_commitments%rowtype;
  v_next_event jsonb;
  v_event jsonb;
  v_gender text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to respond to this substitute request';
  end if;
  if p_action not in ('accept', 'pass') then
    raise exception 'Choose accept or pass';
  end if;

  select r.* into v_request
  from public.sub_requests r
  where r.id = p_request_id
    and r.current_pinged_user_id = auth.uid()
    and r.status in ('searching_primary', 'searching_fallback')
  for update;
  if not found then
    raise exception 'This substitute request is no longer assigned to you';
  end if;

  if v_request.ping_expires_at <= now() then
    update public.sub_requests
    set current_pinged_user_id = null,
        ping_expires_at = null,
        ping_notification_claimed_at = null
    where id = p_request_id;
    v_next_event := public.advance_sub_request(p_request_id);
    return jsonb_build_object(
      'result', 'expired',
      'events', case
        when v_next_event is null then '[]'::jsonb
        else jsonb_build_array(v_next_event)
      end
    );
  end if;

  if p_action = 'accept' then
    select c.* into v_commitment
    from public.game_commitments c
    where c.game_id = v_request.game_id
      and c.user_id = auth.uid()
    for update;
    if not found or v_commitment.status <> 'available' then
      raise exception 'You are no longer available for this game';
    end if;

    update public.game_commitments
    set status = 'playing'
    where id = v_commitment.id;

    update public.sub_requests
    set status = 'filled',
        current_pinged_user_id = null,
        ping_expires_at = null,
        ping_notification_claimed_at = null
    where id = p_request_id
    returning * into v_request;

    insert into public.player_season_stats (
      season_id, user_id, pings_answered_in_time
    )
    values (v_request.season_id, auth.uid(), 1)
    on conflict (season_id, user_id)
    do update set pings_answered_in_time =
      public.player_season_stats.pings_answered_in_time + 1;

    v_event := jsonb_build_object(
      'event', 'filled',
      'request_id', p_request_id,
      'recipient_user_id', v_request.requester_id,
      'game_id', v_request.game_id
    );
    return jsonb_build_object('result', 'accepted', 'events', jsonb_build_array(v_event));
  end if;

  insert into public.player_season_stats (
    season_id, user_id, pings_answered_in_time
  )
  values (v_request.season_id, auth.uid(), 1)
  on conflict (season_id, user_id)
  do update set pings_answered_in_time =
    public.player_season_stats.pings_answered_in_time + 1;

  update public.sub_requests
  set current_pinged_user_id = null,
      ping_expires_at = null,
      ping_notification_claimed_at = null
  where id = p_request_id;
  v_next_event := public.advance_sub_request(p_request_id);

  return jsonb_build_object(
    'result', 'passed',
    'events', case
      when v_next_event is null then '[]'::jsonb
      else jsonb_build_array(v_next_event)
    end
  );
end;
$$;

revoke all on function public.respond_to_sub_ping(uuid, text) from public, anon;
grant execute on function public.respond_to_sub_ping(uuid, text) to authenticated;

