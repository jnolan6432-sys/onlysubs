alter table public.seasons
  add column game_price_cents integer not null default 1200
    check (game_price_cents between 0 and 100000),
  add column global_claim_hours numeric not null default 2
    check (global_claim_hours > 0 and global_claim_hours <= 168),
  add column gender_match_claim_hours numeric not null default 1
    check (gender_match_claim_hours >= 0 and gender_match_claim_hours <= 168),
  add column claims_are_free boolean not null default true;

alter table public.sub_requests
  add column fill_method text
    check (fill_method is null or fill_method in ('ping', 'claim')),
  add column filled_by_user_id uuid references auth.users (id) on delete set null,
  add column fill_amount_cents integer not null default 0
    check (fill_amount_cents >= 0);

update public.sub_requests
set fill_method = 'ping'
where status = 'filled' and fill_method is null;

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
  v_game_price integer;
  v_global_claim numeric;
  v_gender_claim numeric;
  v_claims_free boolean;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;
  if not exists (
    select 1 from pg_timezone_names where name = p_timezone_name
  ) then
    raise exception 'Choose a valid IANA timezone';
  end if;

  v_game_price := coalesce((p_payload->>'game_price_cents')::integer, 1200);
  v_global_claim := coalesce((p_payload->>'global_claim_hours')::numeric, 2);
  v_gender_claim := coalesce((p_payload->>'gender_match_claim_hours')::numeric, 1);
  v_claims_free := coalesce((p_payload->>'claims_are_free')::boolean, true);
  if v_game_price not between 0 and 100000
     or v_global_claim <= 0 or v_global_claim > 168
     or v_gender_claim < 0 or v_gender_claim > 168 then
    raise exception 'Game price and claim window settings are invalid';
  end if;

  v_result := public.publish_season(p_payload);
  v_season_id := (v_result->>'season_id')::uuid;
  update public.seasons
  set timezone = p_timezone_name,
      timezone_name = p_timezone_name,
      game_price_cents = v_game_price,
      global_claim_hours = v_global_claim,
      gender_match_claim_hours = v_gender_claim,
      claims_are_free = v_claims_free
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

drop function public.get_calendar_slot_counts(uuid[]);
create function public.get_calendar_slot_counts(p_game_ids uuid[])
returns table (
  game_id uuid,
  fmp_slots_to_fill bigint,
  mmp_slots_to_fill bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    g.id,
    count(r.id) filter (where r.needed_gender = 'FMP'),
    count(r.id) filter (where r.needed_gender = 'MMP')
  from public.games g
  join public.season_pool_members own_membership
    on own_membership.season_id = g.season_id
    and own_membership.user_id = (select auth.uid())
  join public.seasons s on s.id = g.season_id
  left join public.sub_requests r
    on r.game_id = g.id
    and r.status in ('searching_primary', 'searching_fallback', 'paused')
    and ((g.game_date + g.start_time) at time zone s.timezone) > now()
  where g.id = any(coalesce(p_game_ids, '{}'::uuid[]))
  group by g.id
$$;

revoke all on function public.get_calendar_slot_counts(uuid[])
  from public, anon;
grant execute on function public.get_calendar_slot_counts(uuid[])
  to authenticated;

create or replace function public.prepare_game_claim_phase(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_claim_starts_at timestamptz;
begin
  select (g.game_date + g.start_time) at time zone s.timezone,
         (g.game_date + g.start_time) at time zone s.timezone
           - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
    into v_starts_at, v_claim_starts_at
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.id = p_game_id;
  if not found or now() < v_claim_starts_at then
    return;
  end if;

  update public.sub_requests
  set status = case when now() >= v_starts_at then 'cancelled' else 'paused' end,
      current_pinged_user_id = null,
      ping_expires_at = null,
      ping_not_before = now(),
      ping_notification_sent_at = null,
      ping_notification_claimed_at = null,
      admin_alert_claimed_at = null
  where game_id = p_game_id
    and status in ('searching_primary', 'searching_fallback', 'paused');
end;
$$;

revoke all on function public.prepare_game_claim_phase(uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_game_claim_phase(uuid)
  to service_role;

create or replace function public.guard_commitment_timing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_claim_starts_at timestamptz;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  select (g.game_date + g.start_time) at time zone s.timezone,
         (g.game_date + g.start_time) at time zone s.timezone
           - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
    into v_starts_at, v_claim_starts_at
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.id = new.game_id;
  if not found then
    raise exception 'Game not found';
  end if;
  if now() >= v_starts_at then
    raise exception 'Game commitments are closed because the game has started';
  end if;
  if now() >= v_claim_starts_at
     and current_setting('app.allow_claim_commitment', true) is distinct from 'on' then
    raise exception 'Availability changes are disabled during the claim window';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_commitment_timing()
  from public, anon, authenticated;
create trigger guard_commitment_timing
  before update of status on public.game_commitments
  for each row execute procedure public.guard_commitment_timing();

create or replace function public.guard_commitment_insert_timing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_claim_starts_at timestamptz;
begin
  if pg_trigger_depth() > 1 or auth.uid() is distinct from new.user_id then
    return new;
  end if;

  select (g.game_date + g.start_time) at time zone s.timezone,
         (g.game_date + g.start_time) at time zone s.timezone
           - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
    into v_starts_at, v_claim_starts_at
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.id = new.game_id;
  if not found or now() >= v_claim_starts_at or now() >= v_starts_at then
    raise exception 'Game commitments are closed for this game';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_commitment_insert_timing()
  from public, anon, authenticated;
create trigger guard_commitment_insert_timing
  before insert on public.game_commitments
  for each row execute procedure public.guard_commitment_insert_timing();

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
  if pg_trigger_depth() > 1 then
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
create trigger guard_commitment_delete_timing
  before delete on public.game_commitments
  for each row execute procedure public.guard_commitment_delete_timing();

create or replace function public.guard_sub_request_insert_timing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_claim_starts_at timestamptz;
begin
  select (g.game_date + g.start_time) at time zone s.timezone,
         (g.game_date + g.start_time) at time zone s.timezone
           - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
    into v_starts_at, v_claim_starts_at
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.id = new.game_id;
  if not found or now() >= v_claim_starts_at or now() >= v_starts_at then
    raise exception 'Sub requests are closed for this game';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_sub_request_insert_timing()
  from public, anon, authenticated;
create trigger guard_sub_request_insert_timing
  before insert on public.sub_requests
  for each row execute procedure public.guard_sub_request_insert_timing();

create or replace function public.mark_sub_request_fill_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'filled' and old.status in ('searching_primary', 'searching_fallback', 'paused')
     and new.fill_method is null then
    new.fill_method := 'ping';
    new.filled_by_user_id := old.current_pinged_user_id;
  end if;
  return new;
end;
$$;

revoke all on function public.mark_sub_request_fill_method()
  from public, anon, authenticated;
create trigger mark_sub_request_fill_method
  before update of status on public.sub_requests
  for each row execute procedure public.mark_sub_request_fill_method();

alter function public.update_game_commitment(uuid)
  rename to update_game_commitment_before_claim_phase;
revoke all on function public.update_game_commitment_before_claim_phase(uuid)
  from public, anon, authenticated;

create function public.update_game_commitment(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_starts_at timestamptz;
  v_claim_starts_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign in to update your calendar';
  end if;

  select (g.game_date + g.start_time) at time zone s.timezone,
         (g.game_date + g.start_time) at time zone s.timezone
           - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
    into v_starts_at, v_claim_starts_at
    from public.games g
    join public.seasons s on s.id = g.season_id
    join public.season_pool_members m
      on m.season_id = g.season_id and m.user_id = auth.uid()
    where g.id = p_game_id
    for update of g;
  if not found then
    raise exception 'Game not found in your season';
  end if;
  if now() >= v_starts_at then
    raise exception 'Game commitments are closed because the game has started';
  end if;
  if now() >= v_claim_starts_at then
    raise exception 'Use the claim button during the claim window';
  end if;

  return public.update_game_commitment_before_claim_phase(p_game_id);
end;
$$;

revoke all on function public.update_game_commitment(uuid) from public, anon;
grant execute on function public.update_game_commitment(uuid) to authenticated;

alter function public.respond_to_sub_ping(uuid, text)
  rename to respond_to_sub_ping_before_claim_phase;
revoke all on function public.respond_to_sub_ping_before_claim_phase(uuid, text)
  from public, anon, authenticated;

create function public.respond_to_sub_ping(
  p_request_id uuid,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id uuid;
  v_starts_at timestamptz;
  v_claim_starts_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Sign in to respond to this substitute request';
  end if;

  select g.id,
         (g.game_date + g.start_time) at time zone s.timezone,
         (g.game_date + g.start_time) at time zone s.timezone
           - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
    into v_game_id, v_starts_at, v_claim_starts_at
    from public.sub_requests r
    join public.games g on g.id = r.game_id
    join public.seasons s on s.id = r.season_id
    where r.id = p_request_id
      and r.current_pinged_user_id = auth.uid()
      and r.status in ('searching_primary', 'searching_fallback');
  if not found then
    return public.respond_to_sub_ping_before_claim_phase(p_request_id, p_action);
  end if;

  if now() >= v_starts_at then
    perform public.prepare_game_claim_phase(v_game_id);
    return jsonb_build_object('result', 'expired', 'events', '[]'::jsonb);
  end if;
  if now() >= v_claim_starts_at then
    perform public.prepare_game_claim_phase(v_game_id);
    return jsonb_build_object('result', 'claim_phase', 'events', '[]'::jsonb);
  end if;

  return public.respond_to_sub_ping_before_claim_phase(p_request_id, p_action);
end;
$$;

revoke all on function public.respond_to_sub_ping(uuid, text)
  from public, anon;
grant execute on function public.respond_to_sub_ping(uuid, text)
  to authenticated;

create or replace function public.claim_game_spot(p_game_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_game public.games%rowtype;
  v_season public.seasons%rowtype;
  v_commitment public.game_commitments%rowtype;
  v_request public.sub_requests%rowtype;
  v_gender text;
  v_starts_at timestamptz;
  v_gender_claim_starts_at timestamptz;
  v_global_claim_starts_at timestamptz;
  v_claim_amount integer;
begin
  if v_user_id is null then
    raise exception 'Sign in to claim a spot';
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
  select s.*
    into v_season
    from public.seasons s
    where s.id = v_game.season_id;
  if not found then
    raise exception 'Season not found';
  end if;
  if v_game.cancelled_at is not null then
    raise exception 'This game has been cancelled';
  end if;

  v_starts_at := (v_game.game_date + v_game.start_time) at time zone v_season.timezone;
  v_global_claim_starts_at :=
    v_starts_at - v_season.global_claim_hours * interval '1 hour';
  v_gender_claim_starts_at :=
    v_global_claim_starts_at
      - v_season.gender_match_claim_hours * interval '1 hour';
  if now() >= v_starts_at then
    perform public.prepare_game_claim_phase(p_game_id);
    return jsonb_build_object('result', 'closed');
  end if;
  if now() < v_gender_claim_starts_at then
    raise exception 'The claim window has not opened';
  end if;

  perform public.prepare_game_claim_phase(p_game_id);

  select p.gender_match
    into v_gender
    from public.profiles p
    where p.id = v_user_id and p.onboarded;
  if v_gender is null then
    raise exception 'Complete your profile before claiming a spot';
  end if;

  select c.*
    into v_commitment
    from public.game_commitments c
    where c.game_id = p_game_id and c.user_id = v_user_id
    for update;
  if not found or v_commitment.status = 'playing' then
    raise exception 'You are already playing or do not have a commitment for this game';
  end if;
  if v_commitment.status not in ('available', 'unavailable') then
    raise exception 'Your commitment cannot claim this spot';
  end if;

  select r.*
    into v_request
    from public.sub_requests r
    where r.game_id = p_game_id
      and r.status = 'paused'
      and (
        now() >= v_global_claim_starts_at
        or r.needed_gender = v_gender
      )
    order by r.created_at, r.id
    limit 1
    for update;
  if not found then
    raise exception 'No eligible open spot remains for this game';
  end if;

  v_claim_amount := case
    when v_season.claims_are_free then 0
    else v_season.game_price_cents
  end;
  perform set_config('app.allow_claim_commitment', 'on', true);
  update public.game_commitments
  set status = 'playing'
  where id = v_commitment.id;
  perform set_config('app.allow_claim_commitment', 'off', true);

  update public.sub_requests
  set status = 'filled',
      fill_method = 'claim',
      filled_by_user_id = v_user_id,
      fill_amount_cents = v_claim_amount,
      current_pinged_user_id = null,
      ping_expires_at = null,
      ping_notification_sent_at = null,
      ping_notification_claimed_at = null
  where id = v_request.id;

  return jsonb_build_object(
    'game_id', p_game_id,
    'needed_gender', v_request.needed_gender,
    'fill_method', 'claim',
    'claims_are_free', v_season.claims_are_free,
    'game_price_cents', v_season.game_price_cents,
    'fill_amount_cents', v_claim_amount
  );
end;
$$;

revoke all on function public.claim_game_spot(uuid) from public, anon;
grant execute on function public.claim_game_spot(uuid) to authenticated;

alter function public.run_sub_queue_worker(integer)
  rename to run_sub_queue_worker_before_claim_phase;
revoke all on function public.run_sub_queue_worker_before_claim_phase(integer)
  from public, anon, authenticated, service_role;

create function public.run_sub_queue_worker(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role is required';
  end if;

  for v_game_id in
    select distinct g.id
    from public.games g
    join public.seasons s on s.id = g.season_id
    join public.sub_requests r on r.game_id = g.id
    where r.status in ('searching_primary', 'searching_fallback', 'paused')
      and now() >=
        ((g.game_date + g.start_time) at time zone s.timezone)
          - (s.global_claim_hours + s.gender_match_claim_hours) * interval '1 hour'
  loop
    perform public.prepare_game_claim_phase(v_game_id);
  end loop;

  return public.run_sub_queue_worker_before_claim_phase(p_limit);
end;
$$;

revoke all on function public.run_sub_queue_worker(integer)
  from public, anon, authenticated;
grant execute on function public.run_sub_queue_worker(integer)
  to service_role;
