drop trigger if exists prevent_pending_ping_availability_change
  on public.game_commitments;
drop function if exists public.prevent_pending_ping_availability_change();
drop function if exists public.cancel_own_sub_request(uuid);

do $$
declare
  v_definition text;
  v_originator_skip text := $skip$
    if v_candidate_id = v_request.requester_id then
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
$skip$;
begin
  v_definition := pg_get_functiondef(
    'public.advance_sub_request_before_pause(uuid)'::regprocedure
  );
  if position(v_originator_skip in v_definition) > 0 then
    execute replace(v_definition, v_originator_skip, '');
  elsif position('v_candidate_id = v_request.requester_id' in v_definition) > 0 then
    raise exception 'Could not remove the sub-request originator exclusion.';
  end if;
end;
$$;

create or replace function public.update_game_commitment(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_game public.games%rowtype;
  v_commitment public.game_commitments%rowtype;
  v_gender text;
  v_new_status text;
  v_request_id uuid;
  v_reactivated_request_id uuid;
  v_queue_request_id uuid;
begin
  if v_user_id is null then
    raise exception 'Sign in to update your calendar';
  end if;

  select g.*
    into v_game
    from public.games g
    join public.season_pool_members m
      on m.season_id = g.season_id and m.user_id = v_user_id
    where g.id = p_game_id
    for update of g;
  if not found then
    raise exception 'Game not found in your season';
  end if;
  if v_game.cancelled_at is not null then
    raise exception 'This game has been cancelled';
  end if;

  select c.*
    into v_commitment
    from public.game_commitments c
    where c.game_id = p_game_id
      and c.user_id = v_user_id
    for update;
  if not found then
    raise exception 'Your commitment for this game was not found';
  end if;

  if v_commitment.status = 'playing' then
    select p.gender_match
      into v_gender
      from public.profiles p
      where p.id = v_user_id
        and p.onboarded;
    if v_gender is null then
      raise exception 'Complete your profile before requesting a substitute';
    end if;

    if exists (
      select 1
      from public.sub_requests r
      where r.game_id = p_game_id
        and r.requester_id = v_user_id
        and r.status in ('searching_primary', 'searching_fallback', 'paused')
    ) then
      raise exception 'You already have an open substitute request';
    end if;

    v_new_status := 'unavailable';
    update public.game_commitments
    set status = v_new_status
    where id = v_commitment.id;

    insert into public.sub_requests (
      season_id, game_id, requester_id, needed_gender, status
    )
    values (
      v_game.season_id, p_game_id, v_user_id, v_gender, 'searching_primary'
    )
    returning id into v_request_id;
  elsif v_commitment.status = 'available' then
    v_new_status := 'unavailable';
    update public.game_commitments
    set status = v_new_status
    where id = v_commitment.id;

    with released_pings as (
      update public.sub_requests
      set current_pinged_user_id = null,
          ping_expires_at = null,
          ping_notification_claimed_at = null
      where current_pinged_user_id = v_user_id
        and status in ('searching_primary', 'searching_fallback')
      returning id
    )
    select id
      into v_queue_request_id
      from released_pings
      order by id
      limit 1;
  elsif v_commitment.status = 'unavailable' then
    v_new_status := 'available';
    update public.game_commitments
    set status = v_new_status
    where id = v_commitment.id;

    select p.gender_match
      into v_gender
      from public.profiles p
      where p.id = v_user_id;

    if v_gender in ('FMP', 'MMP') then
      insert into public.season_queue_state (season_id, gender_match)
      values (v_game.season_id, v_gender)
      on conflict (season_id, gender_match) do nothing;

      update public.season_queue_state
      set ordered_user_ids = array_append(ordered_user_ids, v_user_id)
      where season_id = v_game.season_id
        and gender_match = v_gender
        and not (v_user_id = any(ordered_user_ids));

      select id
        into v_reactivated_request_id
        from public.sub_requests
        where game_id = p_game_id
          and status = 'paused'
        order by created_at, id
        limit 1;

      update public.sub_requests
      set primary_candidates_seen =
            array_remove(primary_candidates_seen, v_user_id),
          fallback_candidates_seen =
            array_remove(fallback_candidates_seen, v_user_id),
          status = case
            when status = 'paused' then 'searching_primary'
            else status
          end,
          admin_alert_claimed_at = case
            when status = 'paused' then null
            else admin_alert_claimed_at
          end,
          admin_alert_sent_at = case
            when status = 'paused' then null
            else admin_alert_sent_at
          end,
          admin_push_sent_at = case
            when status = 'paused' then null
            else admin_push_sent_at
          end,
          admin_email_sent_at = case
            when status = 'paused' then null
            else admin_email_sent_at
          end
      where game_id = p_game_id
        and status in ('searching_primary', 'searching_fallback', 'paused');

      select id
        into v_queue_request_id
        from public.sub_requests
        where game_id = p_game_id
          and status in ('searching_primary', 'searching_fallback')
        order by
          case when status = 'searching_primary' then 0 else 1 end,
          created_at,
          id
        limit 1;
    end if;
  else
    raise exception 'This commitment status cannot be changed';
  end if;

  return jsonb_build_object(
    'game_id', p_game_id,
    'status', v_new_status,
    'sub_request_id', v_request_id,
    'reactivated_request_id', v_reactivated_request_id,
    'queue_request_id', v_queue_request_id,
    'gender_match', v_gender
  );
end;
$$;

revoke all on function public.update_game_commitment(uuid)
  from public, anon;
grant execute on function public.update_game_commitment(uuid)
  to authenticated;
