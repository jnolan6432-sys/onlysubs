create or replace function public.ensure_game_commitments_for_roster()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.game_commitments (game_id, user_id, status)
  select games.id, new.user_id, 'playing'
  from public.games
  where games.session_id = new.session_id
  on conflict (game_id, user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.ensure_game_commitments_for_roster()
  from public, anon, authenticated;

create trigger ensure_game_commitments_for_roster
  after insert on public.session_rosters
  for each row execute procedure public.ensure_game_commitments_for_roster();

create or replace function public.ensure_game_commitments_for_game()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.game_commitments (game_id, user_id, status)
  select new.id, rosters.user_id, 'playing'
  from public.session_rosters rosters
  where rosters.session_id = new.session_id
  on conflict (game_id, user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.ensure_game_commitments_for_game()
  from public, anon, authenticated;

create trigger ensure_game_commitments_for_game
  after insert on public.games
  for each row execute procedure public.ensure_game_commitments_for_game();

insert into public.game_commitments (game_id, user_id, status)
select games.id, rosters.user_id, 'playing'
from public.games
join public.session_rosters rosters
  on rosters.session_id = games.session_id
on conflict (game_id, user_id) do nothing;
