alter table public.profiles
  add column if not exists timezone text;

create or replace function public.ensure_season_commitments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.game_commitments (game_id, user_id, status)
  select g.id, new.user_id, 'unavailable'
  from public.games g
  where g.season_id = new.season_id
    and not exists (
      select 1
      from public.session_rosters r
      where r.session_id = g.session_id
        and r.user_id = new.user_id
    )
  on conflict (game_id, user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.ensure_season_commitments() from public, anon, authenticated;

drop trigger if exists ensure_season_commitments_on_pool_insert
  on public.season_pool_members;
create trigger ensure_season_commitments_on_pool_insert
  after insert on public.season_pool_members
  for each row execute procedure public.ensure_season_commitments();

create or replace function public.ensure_season_commitments_for_game()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.game_commitments (game_id, user_id, status)
  select new.id, m.user_id,
         case
           when exists (
             select 1
             from public.session_rosters r
             where r.session_id = new.session_id
               and r.user_id = m.user_id
           ) then 'playing'
           else 'unavailable'
         end
  from public.season_pool_members m
  where m.season_id = new.season_id
  on conflict (game_id, user_id) do update
  set status = excluded.status;

  update public.profiles p
  set onboarded = true,
      onboarded_at = coalesce(p.onboarded_at, now())
  from public.season_pool_members m
  where p.id = m.user_id;

  update public.profiles p
  set onboarded = true,
      onboarded_at = coalesce(p.onboarded_at, now())
  from public.season_pool_members m
  where p.id = m.user_id;

  return new;
end;
$$;

revoke all on function public.ensure_season_commitments_for_game()
  from public, anon, authenticated;

drop trigger if exists ensure_season_commitments_for_game
  on public.games;
create trigger ensure_season_commitments_for_game
  after insert on public.games
  for each row execute procedure public.ensure_season_commitments_for_game();

create or replace function public.ensure_game_commitments_for_roster()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.game_commitments (game_id, user_id, status)
  select g.id, new.user_id, 'playing'
  from public.games g
  where g.session_id = new.session_id
  on conflict (game_id, user_id) do update
  set status = 'playing';

  return new;
end;
$$;

revoke all on function public.ensure_game_commitments_for_roster()
  from public, anon, authenticated;

drop trigger if exists ensure_game_commitments_for_roster
  on public.session_rosters;
create trigger ensure_game_commitments_for_roster
  after insert on public.session_rosters
  for each row execute procedure public.ensure_game_commitments_for_roster();

insert into public.game_commitments (game_id, user_id, status)
select g.id, m.user_id,
       case
         when exists (
           select 1
           from public.session_rosters r
           where r.session_id = g.session_id
             and r.user_id = m.user_id
         ) then 'playing'
         else 'unavailable'
       end
from public.games g
join public.season_pool_members m
  on m.season_id = g.season_id
on conflict (game_id, user_id) do update
set status = excluded.status;
