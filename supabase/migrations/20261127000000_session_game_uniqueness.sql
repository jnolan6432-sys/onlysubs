begin;

set local search_path = public, pg_temp;
lock table public.sessions, public.games in access exclusive mode;

do $$
declare
  protected_duplicate_count bigint;
  duplicate_count bigint;
begin
  select count(*)
  into protected_duplicate_count
  from public.games game
  where exists (
    select 1
    from public.games other_game
    where other_game.session_id = game.session_id
      and other_game.game_date = game.game_date
      and other_game.id <> game.id
  )
  and (
    exists (select 1 from public.game_commitments c where c.game_id = game.id)
    or exists (select 1 from public.sub_requests r where r.game_id = game.id)
    or exists (select 1 from public.season_exchange_ledger l where l.game_id = game.id)
  );

  raise notice 'Protected duplicate game rows found: %; none will be deleted.',
    protected_duplicate_count;

  with ranked_games as (
    select
      game.id,
      row_number() over (
        partition by game.session_id, game.game_date
        order by (
          exists (select 1 from public.game_commitments c where c.game_id = game.id)
          or exists (select 1 from public.sub_requests r where r.game_id = game.id)
          or exists (select 1 from public.season_exchange_ledger l where l.game_id = game.id)
        ) desc, game.id
      ) as row_number
    from public.games game
  )
  delete from public.games game
  using ranked_games ranked
  where game.id = ranked.id
    and ranked.row_number > 1
    and not exists (select 1 from public.game_commitments c where c.game_id = game.id)
    and not exists (select 1 from public.sub_requests r where r.game_id = game.id)
    and not exists (select 1 from public.season_exchange_ledger l where l.game_id = game.id);

  select count(*)
  into duplicate_count
  from (
    select game.session_id, game.game_date
    from public.games game
    group by game.session_id, game.game_date
    having count(*) > 1
  ) duplicates;

  if duplicate_count > 0 then
    raise exception
      'Cannot add games(session_id, game_date) uniqueness: % duplicate groups still contain protected game rows. Resolve those rows without deleting their commitments, requests, or ledger entries, then rerun this migration.',
      duplicate_count;
  end if;
end;
$$;

create temporary table duplicate_session_map on commit drop as
with session_signatures as (
  select
    session.id as session_id,
    session.season_id,
    session.name,
    session.start_time,
    session.archived_at,
    session.schedule_id,
    array(
      select game.game_date
      from public.games game
      where game.session_id = session.id
      order by game.game_date
    ) as game_dates
  from public.sessions session
),
ranked_sessions as (
  select
    session.id as session_id,
    session.season_id,
    row_number() over (
      partition by session.season_id, lower(trim(session.name)), session.start_time
      order by
        (session.archived_at is null) desc,
        (session.schedule_id is not null) desc,
        (select count(*) from public.games game
         where game.session_id = session.id and game.cancelled_at is null) desc,
        (select count(*) from public.games game
         where game.session_id = session.id) desc,
        session.id
    ) as session_rank,
    first_value(session.id) over (
      partition by session.season_id, lower(trim(session.name)), session.start_time
      order by
        (session.archived_at is null) desc,
        (session.schedule_id is not null) desc,
        (select count(*) from public.games game
         where game.session_id = session.id and game.cancelled_at is null) desc,
        (select count(*) from public.games game
         where game.session_id = session.id) desc,
        session.id
    ) as keeper_id
  from public.sessions session
),
exact_duplicates as (
  select session_id as duplicate_id, keeper_id
  from ranked_sessions
  where session_rank > 1
),
archived_schedule_matches as (
  select
    archived.session_id as duplicate_id,
    active.session_id as keeper_id,
    row_number() over (
      partition by archived.session_id
      order by
        (active.schedule_id is not null) desc,
        abs(extract(epoch from (active.start_time - archived.start_time))),
        active.session_id
    ) as match_rank
  from session_signatures archived
  join session_signatures active
    on active.season_id = archived.season_id
   and active.archived_at is null
   and archived.game_dates = active.game_dates
   and cardinality(archived.game_dates) > 0
  where archived.archived_at is not null
    and not exists (
      select 1 from exact_duplicates duplicate
      where duplicate.duplicate_id = archived.session_id
    )
    and not exists (
      select 1 from exact_duplicates duplicate
      where duplicate.duplicate_id = active.session_id
    )
)
select duplicate_id, keeper_id
from exact_duplicates
union all
select duplicate_id, keeper_id
from archived_schedule_matches
where match_rank = 1;

do $$
declare
  session_pair record;
  retained_session_count integer := 0;
  protected_session_game_count bigint;
begin
  select count(*)
  into protected_session_game_count
  from public.games game
  join duplicate_session_map duplicate_session
    on duplicate_session.duplicate_id = game.session_id
  where exists (select 1 from public.game_commitments c where c.game_id = game.id)
     or exists (select 1 from public.sub_requests r where r.game_id = game.id)
     or exists (select 1 from public.season_exchange_ledger l where l.game_id = game.id);

  raise notice 'Protected games found in duplicate sessions: %; game rows will be preserved.',
    protected_session_game_count;

  for session_pair in
    select duplicate_id, keeper_id
    from duplicate_session_map
    order by keeper_id, duplicate_id
  loop
    if exists (
      select 1
      from public.games duplicate_game
      join public.games keeper_game
        on keeper_game.session_id = session_pair.keeper_id
       and keeper_game.game_date = duplicate_game.game_date
      where duplicate_game.session_id = session_pair.duplicate_id
        and (
          exists (select 1 from public.game_commitments c where c.game_id = duplicate_game.id)
          or exists (select 1 from public.sub_requests r where r.game_id = duplicate_game.id)
          or exists (select 1 from public.season_exchange_ledger l where l.game_id = duplicate_game.id)
        )
        and (
          exists (select 1 from public.game_commitments c where c.game_id = keeper_game.id)
          or exists (select 1 from public.sub_requests r where r.game_id = keeper_game.id)
          or exists (select 1 from public.season_exchange_ledger l where l.game_id = keeper_game.id)
        )
    ) then
      update public.sessions
      set archived_at = coalesce(archived_at, now())
      where id = session_pair.duplicate_id;
      retained_session_count := retained_session_count + 1;
      raise notice
        'Retained duplicate session % as archived because both sessions have protected games on the same date; keeper is %.',
        session_pair.duplicate_id, session_pair.keeper_id;
      continue;
    end if;

    delete from public.games keeper_game
    where keeper_game.session_id = session_pair.keeper_id
      and exists (
        select 1
        from public.games duplicate_game
        where duplicate_game.session_id = session_pair.duplicate_id
          and duplicate_game.game_date = keeper_game.game_date
          and (
            exists (select 1 from public.game_commitments c where c.game_id = duplicate_game.id)
            or exists (select 1 from public.sub_requests r where r.game_id = duplicate_game.id)
            or exists (select 1 from public.season_exchange_ledger l where l.game_id = duplicate_game.id)
          )
      )
      and not exists (select 1 from public.game_commitments c where c.game_id = keeper_game.id)
      and not exists (select 1 from public.sub_requests r where r.game_id = keeper_game.id)
      and not exists (select 1 from public.season_exchange_ledger l where l.game_id = keeper_game.id);

    delete from public.games duplicate_game
    where duplicate_game.session_id = session_pair.duplicate_id
      and exists (
        select 1
        from public.games keeper_game
        where keeper_game.session_id = session_pair.keeper_id
          and keeper_game.game_date = duplicate_game.game_date
      )
      and not exists (select 1 from public.game_commitments c where c.game_id = duplicate_game.id)
      and not exists (select 1 from public.sub_requests r where r.game_id = duplicate_game.id)
      and not exists (select 1 from public.season_exchange_ledger l where l.game_id = duplicate_game.id);

    update public.games
    set session_id = session_pair.keeper_id
    where session_id = session_pair.duplicate_id;

    insert into public.session_rosters (session_id, user_id)
    select session_pair.keeper_id, roster.user_id
    from public.session_rosters roster
    where roster.session_id = session_pair.duplicate_id
    on conflict (session_id, user_id) do nothing;

    delete from public.sessions
    where id = session_pair.duplicate_id;
  end loop;

  raise notice 'Duplicate sessions retained because of protected game conflicts: %.',
    retained_session_count;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.games'::regclass
      and conname = 'games_session_date_unique'
  ) then
    if to_regclass('public.games_session_date_unique') is not null then
      alter table public.games
        add constraint games_session_date_unique
        unique using index games_session_date_unique;
    else
      alter table public.games
        add constraint games_session_date_unique
        unique (session_id, game_date);
    end if;
  end if;
end;
$$;

commit;
