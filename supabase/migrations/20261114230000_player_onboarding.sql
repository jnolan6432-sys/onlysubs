alter table public.profiles
  add column sub_pool_preference text
    check (sub_pool_preference in ('sub_list', 'mark_dates_only'));

revoke update (gender_match, onboarded, onboarded_at)
  on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

create policy "Users can view their season pool memberships"
  on public.season_pool_members for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.season_pool_members to authenticated;

create or replace function public.complete_player_onboarding(
  p_gender_match text,
  p_sub_pool_preference text,
  p_season_id uuid,
  p_confirm_remove_others boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_other_membership_count integer := 0;
  v_game_count integer := 0;
  v_queue public.season_queue_state%rowtype;
begin
  if v_user_id is null then
    raise exception 'Sign in to complete onboarding';
  end if;
  if p_gender_match is null or p_gender_match not in ('FMP', 'MMP') then
    raise exception 'Choose FMP or MMP';
  end if;
  if p_sub_pool_preference is null
     or p_sub_pool_preference not in ('sub_list', 'mark_dates_only') then
    raise exception 'Choose a sub pool preference';
  end if;

  perform 1
  from public.profiles
  where id = v_user_id
    and not onboarded
  for update;
  if not found then
    raise exception 'Onboarding is already complete or your profile is unavailable';
  end if;

  if p_season_id is not null then
    perform 1
    from public.seasons
    where id = p_season_id
      and is_published;
    if not found then
      raise exception 'The selected season is no longer available';
    end if;

    select count(*)::integer
      into v_other_membership_count
      from public.season_pool_members
      where user_id = v_user_id
        and season_id <> p_season_id;

    if v_other_membership_count > 0 and not p_confirm_remove_others then
      raise exception 'Confirm that you want to leave your other seasons';
    end if;

    if v_other_membership_count > 0 then
      delete from public.season_pool_members
      where user_id = v_user_id
        and season_id <> p_season_id;
    end if;

    insert into public.season_pool_members (season_id, user_id)
    values (p_season_id, v_user_id)
    on conflict (season_id, user_id) do nothing;

    insert into public.player_season_stats (season_id, user_id)
    values (p_season_id, v_user_id)
    on conflict (season_id, user_id) do nothing;
  else
    if exists (
      select 1 from public.seasons where is_published
    ) then
      raise exception 'Choose a season to join';
    end if;
  end if;

  update public.profiles
  set gender_match = p_gender_match,
      sub_pool_preference = p_sub_pool_preference,
      onboarded = true,
      onboarded_at = now()
  where id = v_user_id;

  if not found then
    raise exception 'Your profile could not be found';
  end if;

  if p_season_id is not null then
    insert into public.season_queue_state (
      season_id, gender_match, ordered_user_ids, current_cursor_index
    )
    values (p_season_id, p_gender_match, '{}'::uuid[], 0)
    on conflict (season_id, gender_match) do nothing;

    select *
      into v_queue
      from public.season_queue_state
      where season_id = p_season_id
        and gender_match = p_gender_match
      for update;

    if not (v_user_id = any(v_queue.ordered_user_ids)) then
      update public.season_queue_state
      set ordered_user_ids = array_append(ordered_user_ids, v_user_id)
      where id = v_queue.id;
    end if;

    insert into public.game_commitments (game_id, user_id, status)
    select
      games.id,
      v_user_id,
      case
        when roster.session_id is not null then 'playing'
        when p_sub_pool_preference = 'sub_list' then 'available'
        else 'unavailable'
      end
    from public.games
    left join public.session_rosters roster
      on roster.session_id = games.session_id
      and roster.user_id = v_user_id
    where games.season_id = p_season_id
    on conflict (game_id, user_id) do update
      set status = excluded.status;

    get diagnostics v_game_count = row_count;
  end if;

  return jsonb_build_object(
    'season_id', p_season_id,
    'game_commitments_created', v_game_count,
    'removed_other_seasons', v_other_membership_count
  );
end;
$$;

revoke all on function public.complete_player_onboarding(text, text, uuid, boolean)
  from public, anon;
grant execute on function public.complete_player_onboarding(text, text, uuid, boolean)
  to authenticated;
