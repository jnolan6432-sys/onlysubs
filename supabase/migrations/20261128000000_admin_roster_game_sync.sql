begin;

create or replace function public.ensure_game_commitments_for_roster()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  previous_claim_override text;
begin
  previous_claim_override := current_setting('app.allow_claim_commitment', true);
  perform set_config('app.allow_claim_commitment', 'on', true);

  insert into public.game_commitments (game_id, user_id, status)
  select g.id, new.user_id, 'playing'
  from public.games g
  join public.seasons s on s.id = g.season_id
  where g.session_id = new.session_id
    and ((g.game_date + g.start_time) at time zone s.timezone) > now()
  on conflict (game_id, user_id) do update
    set status = 'playing'
    where not exists (
      select 1
      from public.sub_requests request
      where request.game_id = excluded.game_id
        and request.status = 'filled'
        and (request.original_regular_user_id = excluded.user_id
          or request.filled_by_user_id = excluded.user_id)
    )
    and not exists (
      select 1
      from public.season_exchange_ledger ledger
      where ledger.game_id = excluded.game_id
        and (ledger.original_regular_user_id = excluded.user_id
          or ledger.substitute_user_id = excluded.user_id)
    );

  perform set_config(
    'app.allow_claim_commitment',
    coalesce(previous_claim_override, ''),
    true
  );
  return new;
end;
$$;

revoke all on function public.ensure_game_commitments_for_roster()
  from public, anon, authenticated;

create or replace function public.guard_commitment_delete_timing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_claim_starts_at timestamptz;
begin
  if current_setting('app.allow_roster_commitment_cleanup', true) = 'on'
     or pg_trigger_depth() > 1 then
     return old;
  end if;

  select (g.game_date + g.start_time) at time zone s.timezone,
         (g.game_date + g.start_time) at time zone s.timezone
           - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
    into v_starts_at, v_claim_starts_at
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.id = old.game_id;
  if found and (now() >= v_claim_starts_at or now() >= v_starts_at) then
    raise exception 'Game commitments are closed for this game';
  end if;
  return old;
end;
$$;

revoke all on function public.guard_commitment_delete_timing()
  from public, anon, authenticated;

create or replace function public.sync_admin_session_game_roster(
  p_session_id uuid,
  p_previous_user_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_season_id uuid;
  v_removed_user_id uuid;
  v_game record;
  v_has_protected_record boolean;
  v_keep_regular_slot boolean;
  v_keep_commitment boolean;
  v_warnings jsonb := '[]'::jsonb;
  previous_claim_override text;
  previous_cleanup_override text;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;

  select session.season_id
    into v_season_id
    from public.sessions session
    where session.id = p_session_id
      and session.archived_at is null;
  if not found then
    raise exception 'Active session not found';
  end if;

  previous_claim_override := current_setting('app.allow_claim_commitment', true);
  previous_cleanup_override := current_setting('app.allow_roster_commitment_cleanup', true);
  perform set_config('app.allow_claim_commitment', 'on', true);
  perform set_config('app.allow_roster_commitment_cleanup', 'on', true);

  insert into public.game_regular_players (game_id, user_id)
  select game.id, roster.user_id
  from public.games game
  join public.seasons season on season.id = game.season_id
  join public.session_rosters roster on roster.session_id = game.session_id
  where game.session_id = p_session_id
    and ((game.game_date + game.start_time) at time zone season.timezone) > now()
  on conflict (game_id, user_id) do nothing;

  insert into public.game_commitments (game_id, user_id, status)
  select game.id, roster.user_id, 'playing'
  from public.games game
  join public.seasons season on season.id = game.season_id
  join public.session_rosters roster on roster.session_id = game.session_id
  where game.session_id = p_session_id
    and ((game.game_date + game.start_time) at time zone season.timezone) > now()
  on conflict (game_id, user_id) do nothing;

  for v_removed_user_id in
    select distinct previous.user_id
    from unnest(coalesce(p_previous_user_ids, '{}'::uuid[])) as previous(user_id)
    where not exists (
      select 1
      from public.session_rosters current_roster
      where current_roster.session_id = p_session_id
        and current_roster.user_id = previous.user_id
    )
  loop
    for v_game in
      select game.id, game.game_date
      from public.games game
      join public.seasons season on season.id = game.season_id
      where game.session_id = p_session_id
        and ((game.game_date + game.start_time) at time zone season.timezone) > now()
      order by game.game_date
    loop
      select
        exists (
          select 1 from public.sub_requests request
          where request.game_id = v_game.id
            and request.status = 'filled'
            and (request.original_regular_user_id = v_removed_user_id
              or request.filled_by_user_id = v_removed_user_id)
        )
        or exists (
          select 1 from public.season_exchange_ledger ledger
          where ledger.game_id = v_game.id
            and (ledger.original_regular_user_id = v_removed_user_id
              or ledger.substitute_user_id = v_removed_user_id)
        )
        into v_has_protected_record;

      select
        exists (
          select 1 from public.sub_requests request
          where request.game_id = v_game.id
            and request.status = 'filled'
            and request.original_regular_user_id = v_removed_user_id
        )
        or exists (
          select 1 from public.season_exchange_ledger ledger
          where ledger.game_id = v_game.id
            and ledger.original_regular_user_id = v_removed_user_id
        )
        into v_keep_regular_slot;

      select
        v_keep_regular_slot
        or exists (
          select 1 from public.sub_requests request
          where request.game_id = v_game.id
            and request.status = 'filled'
            and request.filled_by_user_id = v_removed_user_id
        )
        or exists (
          select 1 from public.season_exchange_ledger ledger
          where ledger.game_id = v_game.id
            and ledger.substitute_user_id = v_removed_user_id
        )
        into v_keep_commitment;

      if v_has_protected_record then
        v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
          'player_id', v_removed_user_id,
          'game_id', v_game.id,
          'game_date', to_char(v_game.game_date, 'YYYY-MM-DD')
        ));
      end if;

      update public.sub_requests request
      set status = 'cancelled',
          current_pinged_user_id = null,
          ping_expires_at = null,
          ping_notification_claimed_at = null,
          admin_alert_claimed_at = null
      where request.game_id = v_game.id
        and request.original_regular_user_id = v_removed_user_id
        and request.status in ('searching_primary', 'searching_fallback', 'paused');

      if v_keep_regular_slot then
        insert into public.game_regular_players (game_id, user_id)
        values (v_game.id, v_removed_user_id)
        on conflict (game_id, user_id) do nothing;
      else
        delete from public.game_regular_players
        where game_id = v_game.id
          and user_id = v_removed_user_id;
      end if;

      if not v_keep_commitment then
        delete from public.game_commitments
        where game_id = v_game.id
          and user_id = v_removed_user_id;
      end if;
    end loop;
  end loop;

  perform set_config(
    'app.allow_claim_commitment',
    coalesce(previous_claim_override, ''),
    true
  );
  perform set_config(
    'app.allow_roster_commitment_cleanup',
    coalesce(previous_cleanup_override, ''),
    true
  );

  return v_warnings;
end;
$$;

revoke all on function public.sync_admin_session_game_roster(uuid, uuid[])
  from public, anon;
grant execute on function public.sync_admin_session_game_roster(uuid, uuid[])
  to authenticated;

commit;
