alter table public.sessions
  add column archived_at timestamptz;

create unique index games_session_date_unique
  on public.games (session_id, game_date);

create table public.season_pool_members (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint season_pool_members_season_user_unique unique (season_id, user_id)
);

create index season_pool_members_user_id_idx
  on public.season_pool_members (user_id);

alter table public.season_pool_members enable row level security;

create policy "Admins can view season pool members"
  on public.season_pool_members for select to authenticated
  using ((select public.is_admin()));

grant select on public.season_pool_members to authenticated;

drop policy "Sessions are visible for published seasons" on public.sessions;
create policy "Active sessions are visible for published seasons"
  on public.sessions for select to authenticated
  using (
    archived_at is null
    and exists (
      select 1 from public.seasons
      where seasons.id = sessions.season_id
        and (seasons.is_published or (select public.is_admin()))
    )
  );

create or replace function public.publish_season(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_season_id uuid;
  v_season_input_id uuid;
  v_session jsonb;
  v_player jsonb;
  v_session_id uuid;
  v_dates date[];
  v_session_ids uuid[] := '{}';
  v_pool_user_ids uuid[];
  v_user_id uuid;
  v_gender text;
  v_old_queue uuid[];
  v_new_queue uuid[];
  v_old_cursor integer;
  v_new_cursor integer;
  v_queue_exists boolean;
  v_retained_games integer := 0;
  v_timeout integer;
  v_day_start integer;
  v_day_end integer;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;

  if jsonb_typeof(p_payload->'sessions') is distinct from 'array' then
    raise exception 'At least one session is required';
  end if;
  if jsonb_array_length(p_payload->'sessions') = 0 then
    raise exception 'At least one session is required';
  end if;

  v_season_input_id := nullif(p_payload->>'season_id', '')::uuid;
  v_timeout := (p_payload->>'timeout_hours')::integer;
  v_day_start := (p_payload->>'daytime_start_hour')::integer;
  v_day_end := (p_payload->>'daytime_end_hour')::integer;

  if v_timeout is null or v_timeout < 1 or v_timeout > 168
     or v_day_start is null
     or v_day_start not between 0 and 23
     or v_day_end is null
     or v_day_end not between 0 and 23
     or v_day_start >= v_day_end then
    raise exception 'Season settings are invalid';
  end if;
  if nullif(trim(p_payload->>'name'), '') is null then
    raise exception 'Season name is required';
  end if;

  if v_season_input_id is null then
    insert into public.seasons (
      name, created_by, is_published, timeout_hours,
      daytime_start_hour, daytime_end_hour
    )
    values (
      trim(p_payload->>'name'), auth.uid(), true, v_timeout,
      v_day_start, v_day_end
    )
    returning id into v_season_id;
  else
    update public.seasons
    set name = trim(p_payload->>'name'),
        is_published = true,
        timeout_hours = v_timeout,
        daytime_start_hour = v_day_start,
        daytime_end_hour = v_day_end
    where id = v_season_input_id
    returning id into v_season_id;

    if v_season_id is null then
      raise exception 'Season not found';
    end if;
  end if;

  for v_session in
    select session_entry.value
    from jsonb_array_elements(p_payload->'sessions') as session_entry(value)
  loop
    if jsonb_typeof(v_session->'dates') is distinct from 'array' then
      raise exception 'Each session must have at least one date';
    end if;
    if jsonb_array_length(v_session->'dates') = 0 then
      raise exception 'Each session must have at least one date';
    end if;

    select array_agg(value::date order by value::date)
      into v_dates
      from jsonb_array_elements_text(v_session->'dates') as date_entry(value);

    if v_session ? 'id' and nullif(v_session->>'id', '') is not null then
      v_session_id := (v_session->>'id')::uuid;
      update public.sessions
      set name = trim(v_session->>'name'),
          start_time = (v_session->>'start_time')::time,
          archived_at = null
      where id = v_session_id
        and season_id = v_season_id;

      if not found then
        raise exception 'Session does not belong to this season';
      end if;
    else
      insert into public.sessions (season_id, name, start_time)
      values (v_season_id, trim(v_session->>'name'), (v_session->>'start_time')::time)
      returning id into v_session_id;
    end if;

    v_session_ids := array_append(v_session_ids, v_session_id);

    select v_retained_games + count(*)::integer
      into v_retained_games
      from public.games g
      where g.session_id = v_session_id
        and not (g.game_date = any(v_dates))
        and (
          exists (select 1 from public.game_commitments c where c.game_id = g.id)
          or exists (select 1 from public.sub_requests r where r.game_id = g.id)
        );

    insert into public.games (session_id, season_id, game_date, start_time)
    select v_session_id, v_season_id, game_date, (v_session->>'start_time')::time
    from unnest(v_dates) as dates(game_date)
    on conflict (session_id, game_date)
    do update set start_time = excluded.start_time;

    delete from public.games g
    where g.session_id = v_session_id
      and not (g.game_date = any(v_dates))
      and not exists (
        select 1 from public.game_commitments c where c.game_id = g.id
      )
      and not exists (
        select 1 from public.sub_requests r where r.game_id = g.id
      );

    for v_player in
      select player_entry.value
      from jsonb_array_elements(coalesce(v_session->'players', '[]'::jsonb))
        as player_entry(value)
    loop
      v_user_id := (v_player->>'user_id')::uuid;
      insert into public.profiles (id, email, full_name)
      select u.id, u.email, nullif(trim(v_player->>'name'), '')
      from auth.users u
      where u.id = v_user_id
      on conflict (id) do update
        set full_name = coalesce(excluded.full_name, public.profiles.full_name);

      insert into public.session_rosters (session_id, user_id)
      values (v_session_id, v_user_id)
      on conflict (session_id, user_id) do nothing;
    end loop;

    delete from public.session_rosters
    where session_id = v_session_id
      and user_id <> all(
        coalesce(
          array(
            select (roster_player.player->>'user_id')::uuid
            from jsonb_array_elements(coalesce(v_session->'players', '[]'::jsonb))
              as roster_player(player)
          ),
          '{}'::uuid[]
        )
      );
  end loop;

  update public.sessions
  set archived_at = now()
  where season_id = v_season_id
    and archived_at is null
    and not (id = any(v_session_ids));

  select coalesce(array_agg(pool.user_id), '{}'::uuid[])
    into v_pool_user_ids
    from (
      select distinct (player_entry.player->>'user_id')::uuid as user_id
      from jsonb_array_elements(p_payload->'sessions')
        as session_entry(session)
      cross join lateral jsonb_array_elements(
        coalesce(session_entry.session->'players', '[]'::jsonb)
      ) as player_entry(player)
      union
      select distinct (player_entry.player->>'user_id')::uuid
      from jsonb_array_elements(
        coalesce(p_payload->'extra_players', '[]'::jsonb)
      ) as player_entry(player)
    ) pool;

  insert into public.profiles (id, email, full_name)
  select u.id, u.email, nullif(trim(extra_player.player->>'name'), '')
  from jsonb_array_elements(
    coalesce(p_payload->'extra_players', '[]'::jsonb)
  ) as extra_player(player)
  join auth.users u on u.id = (extra_player.player->>'user_id')::uuid
  on conflict (id) do update
    set full_name = coalesce(excluded.full_name, public.profiles.full_name);

  insert into public.season_pool_members (season_id, user_id)
  select v_season_id, pool.user_id
  from unnest(v_pool_user_ids) as pool(user_id)
  on conflict (season_id, user_id) do nothing;

  delete from public.season_pool_members
  where season_id = v_season_id
    and not (user_id = any(v_pool_user_ids));

  insert into public.player_season_stats (season_id, user_id)
  select v_season_id, pool.user_id
  from unnest(v_pool_user_ids) as pool(user_id)
  on conflict (season_id, user_id) do nothing;

  foreach v_gender in array array['FMP', 'MMP']
  loop
    select ordered_user_ids, current_cursor_index
      into v_old_queue, v_old_cursor
      from public.season_queue_state
      where season_id = v_season_id
        and gender_match = v_gender;
    v_queue_exists := found;

    select coalesce(array_agg(m.user_id order by m.created_at, m.user_id), '{}'::uuid[])
      into v_new_queue
      from public.season_pool_members m
      join public.profiles p on p.id = m.user_id
      where m.season_id = v_season_id
        and p.gender_match = v_gender;

    if v_queue_exists then
      select coalesce(array_agg(q.user_id order by q.ordinality), '{}'::uuid[])
        into v_new_queue
        from unnest(v_old_queue) with ordinality q(user_id, ordinality)
        join public.season_pool_members m
          on m.season_id = v_season_id and m.user_id = q.user_id
        join public.profiles p
          on p.id = q.user_id and p.gender_match = v_gender;

      select count(*)::integer
        into v_new_cursor
        from unnest(v_old_queue) with ordinality q(user_id, ordinality)
        join public.season_pool_members m
          on m.season_id = v_season_id and m.user_id = q.user_id
        join public.profiles p
          on p.id = q.user_id and p.gender_match = v_gender
        where q.ordinality <= v_old_cursor;

      for v_user_id in
        select m.user_id
        from public.season_pool_members m
        join public.profiles p on p.id = m.user_id
        where m.season_id = v_season_id
          and p.gender_match = v_gender
          and not (m.user_id = any(v_new_queue))
        order by m.created_at, m.user_id
      loop
        v_new_queue := array_append(v_new_queue, v_user_id);
      end loop;

      update public.season_queue_state
      set ordered_user_ids = v_new_queue,
          current_cursor_index = least(v_new_cursor, cardinality(v_new_queue))
      where season_id = v_season_id
        and gender_match = v_gender;
    else
      insert into public.season_queue_state (
        season_id, gender_match, ordered_user_ids, current_cursor_index
      )
      values (v_season_id, v_gender, v_new_queue, 0);
    end if;
  end loop;

  return jsonb_build_object(
    'season_id', v_season_id,
    'retained_games', v_retained_games
  );
end;
$$;

revoke all on function public.publish_season(jsonb) from public, anon;
grant execute on function public.publish_season(jsonb) to authenticated;

create or replace function public.sync_season_queue_gender()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_queue record;
  v_updated_queue uuid[];
  v_updated_cursor integer;
begin
  if new.gender_match is not distinct from old.gender_match then
    return new;
  end if;

  for v_queue in
    select q.season_id, q.gender_match, q.ordered_user_ids, q.current_cursor_index
    from public.season_queue_state q
    join public.season_pool_members m on m.season_id = q.season_id
    where m.user_id = new.id
  loop
    if v_queue.gender_match = new.gender_match then
      if not (new.id = any(v_queue.ordered_user_ids)) then
        update public.season_queue_state
        set ordered_user_ids = array_append(ordered_user_ids, new.id)
        where season_id = v_queue.season_id
          and gender_match = v_queue.gender_match;
      end if;
    else
      select coalesce(array_agg(q.user_id order by q.ordinality), '{}'::uuid[])
        into v_updated_queue
        from unnest(v_queue.ordered_user_ids) with ordinality q(user_id, ordinality)
        where q.user_id <> new.id;

      select count(*)::integer
        into v_updated_cursor
        from unnest(v_queue.ordered_user_ids) with ordinality q(user_id, ordinality)
        where q.user_id <> new.id
          and q.ordinality <= v_queue.current_cursor_index;

      update public.season_queue_state
      set ordered_user_ids = v_updated_queue,
          current_cursor_index = least(
            v_updated_cursor,
            cardinality(v_updated_queue)
          )
      where season_id = v_queue.season_id
        and gender_match = v_queue.gender_match;
    end if;
  end loop;

  return new;
end;
$$;

revoke all on function public.sync_season_queue_gender() from public, anon, authenticated;

create trigger sync_season_queue_gender
  after update of gender_match on public.profiles
  for each row execute procedure public.sync_season_queue_gender();
