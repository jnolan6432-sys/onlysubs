alter table public.seasons
  add column financial_accounting_enabled_at timestamptz not null default now(),
  add column settlements_initialized_at timestamptz;

alter table public.games
  add column financials_evaluated_at timestamptz,
  add column accounting_game_price_cents integer,
  add column accounting_claims_are_free boolean;

update public.games g
set accounting_game_price_cents = s.game_price_cents,
    accounting_claims_are_free = s.claims_are_free
from public.seasons s
where s.id = g.season_id;

alter table public.games
  alter column accounting_game_price_cents set not null,
  alter column accounting_claims_are_free set not null;

create or replace function public.capture_game_financial_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select s.game_price_cents, s.claims_are_free
    into new.accounting_game_price_cents, new.accounting_claims_are_free
    from public.seasons s
    where s.id = new.season_id;
  if not found then
    raise exception 'Could not load season financial settings';
  end if;
  return new;
end;
$$;

revoke all on function public.capture_game_financial_settings()
  from public, anon, authenticated;
create trigger capture_game_financial_settings
  before insert on public.games
  for each row execute procedure public.capture_game_financial_settings();

create or replace function public.sync_future_game_financial_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.game_price_cents is not distinct from old.game_price_cents
     and new.claims_are_free is not distinct from old.claims_are_free then
    return new;
  end if;

  update public.games g
  set accounting_game_price_cents = new.game_price_cents,
      accounting_claims_are_free = new.claims_are_free
  where g.season_id = new.id
    and ((g.game_date + g.start_time) at time zone new.timezone) > now();
  return new;
end;
$$;

revoke all on function public.sync_future_game_financial_settings()
  from public, anon, authenticated;
create trigger sync_future_game_financial_settings
  after update of game_price_cents, claims_are_free on public.seasons
  for each row execute procedure public.sync_future_game_financial_settings();

create table public.game_regular_players (
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  primary key (game_id, user_id)
);

insert into public.game_regular_players (game_id, user_id)
select g.id, roster.user_id
from public.games g
join public.session_rosters roster on roster.session_id = g.session_id;

alter table public.game_regular_players enable row level security;
revoke all on public.game_regular_players from public, anon, authenticated;

create or replace function public.snapshot_game_regular_players()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.game_regular_players (game_id, user_id)
  select new.id, roster.user_id
  from public.session_rosters roster
  where roster.session_id = new.session_id
  on conflict (game_id, user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.snapshot_game_regular_players()
  from public, anon, authenticated;
create trigger snapshot_game_regular_players
  after insert on public.games
  for each row execute procedure public.snapshot_game_regular_players();

create or replace function public.sync_future_game_regular_players()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.game_regular_players (game_id, user_id)
    select g.id, new.user_id
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.session_id = new.session_id
      and ((g.game_date + g.start_time) at time zone s.timezone) > now()
    on conflict (game_id, user_id) do nothing;
    return new;
  end if;

  delete from public.game_regular_players regular
  using public.games g, public.seasons s
  where regular.game_id = g.id
    and g.season_id = s.id
    and regular.user_id = old.user_id
    and g.session_id = old.session_id
    and ((g.game_date + g.start_time) at time zone s.timezone) > now();
  return old;
end;
$$;

revoke all on function public.sync_future_game_regular_players()
  from public, anon, authenticated;
create trigger sync_future_game_regular_players
  after insert or delete on public.session_rosters
  for each row execute procedure public.sync_future_game_regular_players();

alter table public.sub_requests
  add column original_regular_user_id uuid references auth.users (id) on delete restrict;

with request_counts as (
  select game_id, count(*) as request_count
  from public.sub_requests
  where status = 'filled' and filled_by_user_id is null
  group by game_id
),
substitute_counts as (
  select g.id as game_id, count(*) as substitute_count,
         min(c.user_id::text)::uuid as only_substitute_id
  from public.games g
  join public.game_commitments c
    on c.game_id = g.id and c.status = 'playing'
  where not exists (
    select 1
    from public.session_rosters roster
    where roster.session_id = g.session_id
      and roster.user_id = c.user_id
  )
  group by g.id
)
update public.sub_requests r
set filled_by_user_id = substitutes.only_substitute_id
from request_counts requests
join substitute_counts substitutes on substitutes.game_id = requests.game_id
where r.game_id = requests.game_id
  and r.status = 'filled'
  and r.filled_by_user_id is null
  and requests.request_count = 1
  and substitutes.substitute_count = 1;

with recursive request_origins as (
  select r.id as request_id, r.game_id, r.requester_id as original_user_id,
         r.created_at
  from public.sub_requests r
  where not exists (
    select 1
    from public.sub_requests previous
    where previous.game_id = r.game_id
      and previous.status = 'filled'
      and previous.filled_by_user_id = r.requester_id
      and previous.created_at < r.created_at
  )
  union all
  select next_request.id, next_request.game_id, origins.original_user_id,
         next_request.created_at
  from request_origins origins
  join public.sub_requests previous
    on previous.id = origins.request_id
    and previous.status = 'filled'
    and previous.filled_by_user_id is not null
  join public.sub_requests next_request
    on next_request.game_id = previous.game_id
    and next_request.requester_id = previous.filled_by_user_id
    and next_request.created_at > previous.created_at
    and not exists (
      select 1
      from public.sub_requests newer_previous
      where newer_previous.game_id = next_request.game_id
        and newer_previous.status = 'filled'
        and newer_previous.filled_by_user_id = next_request.requester_id
        and newer_previous.created_at > previous.created_at
        and newer_previous.created_at < next_request.created_at
    )
)
update public.sub_requests r
set original_regular_user_id = origins.original_user_id
from request_origins origins
where r.id = origins.request_id
  and r.original_regular_user_id is null;

update public.sub_requests
set original_regular_user_id = requester_id
where original_regular_user_id is null;

alter table public.sub_requests
  alter column original_regular_user_id set not null;

create or replace function public.set_sub_request_origin_regular()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.original_regular_user_id is null then
    select r.original_regular_user_id
      into new.original_regular_user_id
      from public.sub_requests r
      where r.game_id = new.game_id
        and r.status = 'filled'
        and r.filled_by_user_id = new.requester_id
        and r.created_at < now()
      order by r.created_at desc, r.id desc
      limit 1;
    new.original_regular_user_id :=
      coalesce(new.original_regular_user_id, new.requester_id);
  end if;
  return new;
end;
$$;

revoke all on function public.set_sub_request_origin_regular()
  from public, anon, authenticated;
create trigger set_sub_request_origin_regular
  before insert on public.sub_requests
  for each row execute procedure public.set_sub_request_origin_regular();

create table public.season_exchange_ledger (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  game_date date not null,
  original_regular_user_id uuid not null references auth.users (id) on delete restrict,
  substitute_user_id uuid not null references auth.users (id) on delete restrict,
  fill_method text not null check (fill_method in ('ping', 'claim')),
  was_free_claim boolean not null default false,
  amount_cents integer not null check (amount_cents >= 0),
  evaluated_at timestamptz not null default now(),
  constraint season_exchange_ledger_game_regular_unique
    unique (game_id, original_regular_user_id),
  constraint season_exchange_ledger_different_players
    check (original_regular_user_id <> substitute_user_id)
);

create index season_exchange_ledger_season_date_idx
  on public.season_exchange_ledger (season_id, game_date);

create table public.season_settlement_payments (
  season_id uuid not null references public.seasons (id) on delete cascade,
  debtor_id uuid not null references auth.users (id) on delete restrict,
  creditor_id uuid not null references auth.users (id) on delete restrict,
  amount_cents integer not null check (amount_cents > 0),
  is_paid boolean not null default false,
  paid_at timestamptz,
  primary key (season_id, debtor_id, creditor_id),
  constraint season_settlement_payments_different_players
    check (debtor_id <> creditor_id),
  constraint season_settlement_payments_paid_at_consistent
    check ((is_paid and paid_at is not null) or (not is_paid and paid_at is null))
);

create index season_settlement_payments_debtor_idx
  on public.season_settlement_payments (season_id, debtor_id);
create index season_settlement_payments_creditor_idx
  on public.season_settlement_payments (season_id, creditor_id);

alter table public.season_exchange_ledger enable row level security;
alter table public.season_settlement_payments enable row level security;

create or replace function public.is_season_member(p_season_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.season_pool_members membership
    where membership.season_id = p_season_id
      and membership.user_id = auth.uid()
  );
$$;

revoke all on function public.is_season_member(uuid) from public, anon;
grant execute on function public.is_season_member(uuid) to authenticated;

create policy "Season members can view exchange ledger"
  on public.season_exchange_ledger for select to authenticated
  using (public.is_season_member(season_id) or public.is_admin());
create policy "Season members can view settlement payments"
  on public.season_settlement_payments for select to authenticated
  using (public.is_season_member(season_id) or public.is_admin());

revoke all on public.season_exchange_ledger,
  public.season_settlement_payments from anon, authenticated;
grant select on public.season_exchange_ledger,
  public.season_settlement_payments to authenticated;
grant select on public.season_exchange_ledger,
  public.season_settlement_payments to service_role;

create or replace function public.evaluate_game_exchange(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game public.games%rowtype;
  v_season public.seasons%rowtype;
  v_regular record;
  v_substitute_id uuid;
  v_fill_method text;
  v_amount integer;
  v_was_free_claim boolean;
  v_missing_regular_count integer;
  v_unrostered_player_count integer;
begin
  select g.*
    into v_game
    from public.games g
    where g.id = p_game_id
    for update;
  if not found or v_game.financials_evaluated_at is not null then
    return;
  end if;

  select s.*
    into v_season
    from public.seasons s
    where s.id = v_game.season_id;
  if not found then
    raise exception 'Could not load the game season';
  end if;
  if ((v_game.game_date + v_game.start_time) at time zone v_season.timezone) > now() then
    return;
  end if;

  if (v_game.game_date + v_game.start_time) at time zone v_season.timezone
       >= v_season.financial_accounting_enabled_at
     and v_game.cancelled_at is null then
    for v_regular in
      select roster.user_id
      from public.game_regular_players roster
      where roster.game_id = v_game.id
        and not exists (
          select 1
          from public.game_commitments regular_commitment
          where regular_commitment.game_id = v_game.id
            and regular_commitment.user_id = roster.user_id
            and regular_commitment.status = 'playing'
        )
    loop
      v_substitute_id := null;
      v_fill_method := null;

      select request.filled_by_user_id, request.fill_method
        into v_substitute_id, v_fill_method
        from public.sub_requests request
        join public.game_commitments commitment
          on commitment.game_id = request.game_id
          and commitment.user_id = request.filled_by_user_id
          and commitment.status = 'playing'
        where request.game_id = v_game.id
          and request.original_regular_user_id = v_regular.user_id
          and request.status = 'filled'
          and request.filled_by_user_id <> v_regular.user_id
        order by request.created_at desc, request.id desc
        limit 1;

      if v_substitute_id is null then
        select count(*)::integer
          into v_missing_regular_count
          from public.game_regular_players roster
          where roster.game_id = v_game.id
            and not exists (
              select 1
              from public.game_commitments regular_commitment
              where regular_commitment.game_id = v_game.id
                and regular_commitment.user_id = roster.user_id
                and regular_commitment.status = 'playing'
            );
        select count(*)::integer
          into v_unrostered_player_count
          from public.game_commitments commitment
          where commitment.game_id = v_game.id
            and commitment.status = 'playing'
            and not exists (
              select 1
                from public.game_regular_players roster
                where roster.game_id = v_game.id
                and roster.user_id = commitment.user_id
            );

        if v_missing_regular_count = 1 and v_unrostered_player_count = 1 then
          select commitment.user_id
            into v_substitute_id
            from public.game_commitments commitment
            where commitment.game_id = v_game.id
              and commitment.status = 'playing'
              and not exists (
                select 1
                from public.game_regular_players roster
                where roster.game_id = v_game.id
                  and roster.user_id = commitment.user_id
              )
            limit 1;
          select request.fill_method
            into v_fill_method
            from public.sub_requests request
            where request.game_id = v_game.id
              and request.original_regular_user_id = v_regular.user_id
              and request.status = 'filled'
            order by request.created_at desc, request.id desc
            limit 1;
        end if;
      end if;

      if v_substitute_id is not null then
        v_fill_method := coalesce(v_fill_method, 'ping');
        v_was_free_claim :=
          v_fill_method = 'claim' and v_game.accounting_claims_are_free;
        v_amount := case
          when v_was_free_claim then 0
          else v_game.accounting_game_price_cents
        end;
        insert into public.season_exchange_ledger (
          season_id, game_id, game_date, original_regular_user_id,
          substitute_user_id, fill_method, was_free_claim, amount_cents
        )
        values (
          v_game.season_id, v_game.id, v_game.game_date, v_regular.user_id,
          v_substitute_id, v_fill_method, v_was_free_claim, v_amount
        )
        on conflict (game_id, original_regular_user_id) do nothing;
      end if;
    end loop;
  end if;

  update public.games
  set financials_evaluated_at = now()
  where id = v_game.id;
end;
$$;

revoke all on function public.evaluate_game_exchange(uuid)
  from public, anon, authenticated;

create or replace function public.evaluate_started_game_exchanges()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id uuid;
  v_processed integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role is required';
  end if;

  for v_game_id in
    select g.id
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.financials_evaluated_at is null
      and ((g.game_date + g.start_time) at time zone s.timezone) <= now()
    order by g.game_date, g.start_time, g.id
  loop
    perform public.evaluate_game_exchange(v_game_id);
    v_processed := v_processed + 1;
  end loop;
  return v_processed;
end;
$$;

revoke all on function public.evaluate_started_game_exchanges()
  from public, anon, authenticated;
grant execute on function public.evaluate_started_game_exchanges()
  to service_role;

create or replace function public.evaluate_season_game_financials(p_season_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_game_id uuid;
  v_processed integer := 0;
begin
  if auth.role() <> 'service_role'
     and not public.is_season_member(p_season_id) then
    raise exception 'Service role is required';
  end if;

  for v_game_id in
    select g.id
    from public.games g
    where g.season_id = p_season_id
      and g.financials_evaluated_at is null
      and ((g.game_date + g.start_time) at time zone (
        select s.timezone from public.seasons s where s.id = p_season_id
      )) <= now()
    order by g.game_date, g.start_time, g.id
  loop
    perform public.evaluate_game_exchange(v_game_id);
    v_processed := v_processed + 1;
  end loop;
  return v_processed;
end;
$$;

revoke all on function public.evaluate_season_game_financials(uuid)
  from public, anon, authenticated;
grant execute on function public.evaluate_season_game_financials(uuid)
  to service_role;

create or replace function public.initialize_season_settlement_payments(p_season_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_season public.seasons%rowtype;
  v_final_starts_at timestamptz;
  v_debtor_ids uuid[];
  v_debtor_amounts bigint[];
  v_creditor_ids uuid[];
  v_creditor_amounts bigint[];
  v_debtor_index integer := 1;
  v_creditor_index integer := 1;
  v_amount bigint;
  v_inserted integer := 0;
begin
  if auth.role() <> 'service_role'
     and not public.is_season_member(p_season_id) then
    raise exception 'Service role is required';
  end if;

  if exists (
    select 1
    from public.seasons s
    where s.id = p_season_id
      and s.settlements_initialized_at is not null
  ) then
    return 0;
  end if;

  select s.*
    into v_season
    from public.seasons s
    where s.id = p_season_id
    for update;
  if not found then
    raise exception 'Season not found';
  end if;
  if v_season.settlements_initialized_at is not null then
    return 0;
  end if;

  select max((g.game_date + g.start_time) at time zone v_season.timezone)
    into v_final_starts_at
    from public.games g
    where g.season_id = p_season_id
      and g.cancelled_at is null;
  if v_final_starts_at is null or now() < v_final_starts_at then
    return 0;
  end if;

  perform public.evaluate_season_game_financials(p_season_id);
  if exists (
    select 1 from public.season_settlement_payments p
    where p.season_id = p_season_id
  ) then
    return 0;
  end if;

  select coalesce(array_agg(b.user_id order by b.balance, b.user_id), '{}'::uuid[]),
         coalesce(array_agg((-b.balance)::bigint order by b.balance, b.user_id), '{}'::bigint[])
    into v_debtor_ids, v_debtor_amounts
    from (
      select entry.user_id, sum(entry.amount)::bigint as balance
      from (
        select ledger.original_regular_user_id as user_id,
               ledger.amount_cents::bigint as amount
        from public.season_exchange_ledger ledger
        where ledger.season_id = p_season_id
        union all
        select ledger.substitute_user_id,
               -ledger.amount_cents::bigint
        from public.season_exchange_ledger ledger
        where ledger.season_id = p_season_id
      ) entry
      group by entry.user_id
      having sum(entry.amount) < 0
    ) b;

  select coalesce(array_agg(b.user_id order by b.balance desc, b.user_id), '{}'::uuid[]),
         coalesce(array_agg(b.balance::bigint order by b.balance desc, b.user_id), '{}'::bigint[])
    into v_creditor_ids, v_creditor_amounts
    from (
      select entry.user_id, sum(entry.amount)::bigint as balance
      from (
        select ledger.original_regular_user_id as user_id,
               ledger.amount_cents::bigint as amount
        from public.season_exchange_ledger ledger
        where ledger.season_id = p_season_id
        union all
        select ledger.substitute_user_id,
               -ledger.amount_cents::bigint
        from public.season_exchange_ledger ledger
        where ledger.season_id = p_season_id
      ) entry
      group by entry.user_id
      having sum(entry.amount) > 0
    ) b;

  while v_debtor_index <= cardinality(v_debtor_ids)
        and v_creditor_index <= cardinality(v_creditor_ids) loop
    v_amount := least(
      v_debtor_amounts[v_debtor_index],
      v_creditor_amounts[v_creditor_index]
    );
    if v_amount > 2147483647 then
      raise exception 'A settlement amount exceeds the supported cents range';
    end if;
    insert into public.season_settlement_payments (
      season_id, debtor_id, creditor_id, amount_cents
    )
    values (
      p_season_id,
      v_debtor_ids[v_debtor_index],
      v_creditor_ids[v_creditor_index],
      v_amount::integer
    )
    on conflict (season_id, debtor_id, creditor_id) do nothing;
    v_inserted := v_inserted + 1;

    v_debtor_amounts[v_debtor_index] :=
      v_debtor_amounts[v_debtor_index] - v_amount;
    v_creditor_amounts[v_creditor_index] :=
      v_creditor_amounts[v_creditor_index] - v_amount;
    if v_debtor_amounts[v_debtor_index] = 0 then
      v_debtor_index := v_debtor_index + 1;
    end if;
    if v_creditor_amounts[v_creditor_index] = 0 then
      v_creditor_index := v_creditor_index + 1;
    end if;
  end loop;
  update public.seasons
  set settlements_initialized_at = now()
  where id = p_season_id;
  return v_inserted;
end;
$$;

revoke all on function public.initialize_season_settlement_payments(uuid)
  from public, anon, authenticated;
grant execute on function public.initialize_season_settlement_payments(uuid)
  to service_role;

create or replace function public.confirm_season_settlement_payments(p_season_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_final_starts_at timestamptz;
  v_updated integer;
begin
  if auth.uid() is null or not public.is_season_member(p_season_id) then
    raise exception 'Season membership is required';
  end if;

  select max((g.game_date + g.start_time) at time zone s.timezone)
    into v_final_starts_at
    from public.games g
    join public.seasons s on s.id = g.season_id
    where g.season_id = p_season_id
      and g.cancelled_at is null;
  if v_final_starts_at is null or now() < v_final_starts_at then
    raise exception 'Payments cannot be confirmed before the final game starts';
  end if;

  perform public.initialize_season_settlement_payments(p_season_id);
  update public.season_settlement_payments
  set is_paid = true,
      paid_at = now()
  where season_id = p_season_id
    and debtor_id = auth.uid()
    and not is_paid;
  get diagnostics v_updated = row_count;
  if not exists (
    select 1
    from public.season_settlement_payments p
    where p.season_id = p_season_id
      and p.debtor_id = auth.uid()
  ) then
    raise exception 'You have no payments to confirm for this season';
  end if;
  return v_updated;
end;
$$;

revoke all on function public.confirm_season_settlement_payments(uuid)
  from public, anon;
grant execute on function public.confirm_season_settlement_payments(uuid)
  to authenticated;

alter function public.run_sub_queue_worker(integer)
  rename to run_sub_queue_worker_before_financial_evaluation;
revoke all on function public.run_sub_queue_worker_before_financial_evaluation(integer)
  from public, anon, authenticated, service_role;

create function public.run_sub_queue_worker(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service role is required';
  end if;
  perform public.evaluate_started_game_exchanges();
  v_result := public.run_sub_queue_worker_before_financial_evaluation(p_limit);
  return v_result;
end;
$$;

revoke all on function public.run_sub_queue_worker(integer)
  from public, anon, authenticated;
grant execute on function public.run_sub_queue_worker(integer)
  to service_role;
