alter table public.games
  add column cancelled_at timestamptz;

create index sub_requests_active_game_idx
  on public.sub_requests (game_id)
  where status in ('searching_primary', 'searching_fallback');

create unique index sub_requests_one_open_request_per_user_game
  on public.sub_requests (game_id, requester_id)
  where status in ('searching_primary', 'searching_fallback');

revoke insert, update, delete on public.game_commitments from authenticated;
grant select on public.game_commitments to authenticated;

create or replace function public.get_calendar_slot_counts(p_game_ids uuid[])
returns table (game_id uuid, slots_to_fill bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select g.id, count(r.id)
  from public.games g
  join public.season_pool_members own_membership
    on own_membership.season_id = g.season_id
    and own_membership.user_id = (select auth.uid())
  left join public.sub_requests r
    on r.game_id = g.id
    and r.status in ('searching_primary', 'searching_fallback')
  where g.id = any(coalesce(p_game_ids, '{}'::uuid[]))
  group by g.id;
$$;

revoke all on function public.get_calendar_slot_counts(uuid[]) from public, anon;
grant execute on function public.get_calendar_slot_counts(uuid[]) to authenticated;

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

  if v_commitment.status <> 'playing'
     and exists (
       select 1
       from public.sub_requests r
       where r.game_id = p_game_id
         and r.requester_id = v_user_id
         and r.status in ('searching_primary', 'searching_fallback')
     ) then
    raise exception 'Cancel your open substitute request before changing availability';
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
        and r.status in ('searching_primary', 'searching_fallback')
    ) then
      raise exception 'You already have an open substitute request for this game';
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
  elsif v_commitment.status = 'unavailable' then
    v_new_status := 'available';
    update public.game_commitments
    set status = v_new_status
    where id = v_commitment.id;
  else
    raise exception 'This commitment status cannot be changed';
  end if;

  return jsonb_build_object(
    'game_id', p_game_id,
    'status', v_new_status,
    'sub_request_id', v_request_id,
    'needed_gender', v_gender
  );
end;
$$;

revoke all on function public.update_game_commitment(uuid) from public, anon;
grant execute on function public.update_game_commitment(uuid) to authenticated;

create or replace function public.set_game_cancelled(
  p_game_id uuid,
  p_cancelled boolean
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

  update public.games
  set cancelled_at = case when p_cancelled then now() else null end
  where id = p_game_id;

  if not found then
    raise exception 'Game not found';
  end if;

  if p_cancelled then
    update public.sub_requests
    set status = 'cancelled',
        current_pinged_user_id = null,
        ping_expires_at = null
    where game_id = p_game_id
      and status in ('searching_primary', 'searching_fallback');
  end if;
end;
$$;

revoke all on function public.set_game_cancelled(uuid, boolean) from public, anon;
grant execute on function public.set_game_cancelled(uuid, boolean) to authenticated;
