create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  gender_match text check (gender_match in ('FMP', 'MMP')),
  is_admin boolean not null default false,
  onboarded boolean not null default false,
  onboarded_at timestamptz
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users (id) on delete restrict,
  is_published boolean not null default false,
  timeout_hours integer not null default 2,
  daytime_start_hour integer not null default 8,
  daytime_end_hour integer not null default 21,
  created_at timestamptz not null default now(),
  constraint seasons_timeout_hours_nonnegative check (timeout_hours >= 0),
  constraint seasons_daytime_hours_valid check (
    daytime_start_hour between 0 and 23
    and daytime_end_hour between 0 and 23
  )
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id) on delete cascade,
  name text not null,
  start_time time not null,
  constraint sessions_id_season_id_unique unique (id, season_id)
);

create table public.games (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  season_id uuid not null references public.seasons (id) on delete cascade,
  game_date date not null,
  start_time time not null,
  constraint games_id_season_id_unique unique (id, season_id),
  constraint games_session_season_fk
    foreign key (session_id, season_id)
    references public.sessions (id, season_id)
    on delete cascade
);

create table public.session_rosters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  constraint session_rosters_session_user_unique unique (session_id, user_id)
);

create table public.game_commitments (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null check (status in ('playing', 'available', 'unavailable')),
  constraint game_commitments_game_user_unique unique (game_id, user_id)
);

create table public.season_queue_state (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id) on delete cascade,
  gender_match text not null check (gender_match in ('FMP', 'MMP')),
  ordered_user_ids uuid[] not null default '{}',
  current_cursor_index integer not null default 0 check (current_cursor_index >= 0),
  constraint season_queue_state_season_gender_unique unique (season_id, gender_match)
);

create table public.player_season_stats (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  pings_received integer not null default 0 check (pings_received >= 0),
  pings_answered_in_time integer not null default 0 check (pings_answered_in_time >= 0),
  constraint player_season_stats_season_user_unique unique (season_id, user_id)
);

create table public.sub_requests (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  requester_id uuid not null references auth.users (id) on delete cascade,
  needed_gender text not null check (needed_gender in ('FMP', 'MMP')),
  status text not null default 'searching_primary'
    check (status in ('searching_primary', 'searching_fallback', 'filled', 'exhausted', 'cancelled')),
  current_pinged_user_id uuid references auth.users (id) on delete set null,
  ping_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sub_requests_game_season_fk
    foreign key (game_id, season_id)
    references public.games (id, season_id)
    on delete cascade
);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  subscription_json jsonb not null
);

create index seasons_created_by_idx on public.seasons (created_by);
create index sessions_season_id_idx on public.sessions (season_id);
create index games_session_date_idx on public.games (session_id, game_date);
create index games_season_id_idx on public.games (season_id);
create index session_rosters_user_id_idx on public.session_rosters (user_id);
create index game_commitments_user_id_idx on public.game_commitments (user_id);
create index player_season_stats_user_id_idx on public.player_season_stats (user_id);
create index sub_requests_requester_id_idx on public.sub_requests (requester_id);
create index sub_requests_pinged_user_id_idx on public.sub_requests (current_pinged_user_id);
create index push_subscriptions_user_id_idx on public.push_subscriptions (user_id);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and is_admin
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.seasons enable row level security;
alter table public.sessions enable row level security;
alter table public.games enable row level security;
alter table public.session_rosters enable row level security;
alter table public.game_commitments enable row level security;
alter table public.season_queue_state enable row level security;
alter table public.player_season_stats enable row level security;
alter table public.sub_requests enable row level security;
alter table public.push_subscriptions enable row level security;

create policy "Profiles are visible to their owner and admins"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()))
  with check (id = (select auth.uid()) or (select public.is_admin()));

create policy "Published seasons are visible to users"
  on public.seasons for select to authenticated
  using (is_published or created_by = (select auth.uid()) or (select public.is_admin()));
create policy "Admins can create seasons"
  on public.seasons for insert to authenticated
  with check ((select public.is_admin()));
create policy "Admins can update seasons"
  on public.seasons for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "Admins can delete seasons"
  on public.seasons for delete to authenticated
  using ((select public.is_admin()));

create policy "Sessions are visible for published seasons"
  on public.sessions for select to authenticated
  using (
    exists (
      select 1 from public.seasons
      where seasons.id = sessions.season_id
        and (seasons.is_published or (select public.is_admin()))
    )
  );
create policy "Admins can create sessions"
  on public.sessions for insert to authenticated
  with check ((select public.is_admin()));
create policy "Admins can update sessions"
  on public.sessions for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "Admins can delete sessions"
  on public.sessions for delete to authenticated
  using ((select public.is_admin()));

create policy "Games are visible for published seasons"
  on public.games for select to authenticated
  using (
    exists (
      select 1 from public.seasons
      where seasons.id = games.season_id
        and (seasons.is_published or (select public.is_admin()))
    )
  );
create policy "Admins can create games"
  on public.games for insert to authenticated
  with check ((select public.is_admin()));
create policy "Admins can update games"
  on public.games for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
create policy "Admins can delete games"
  on public.games for delete to authenticated
  using ((select public.is_admin()));

create policy "Roster rows are visible to their owner, season participants, and admins"
  on public.session_rosters for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.is_admin())
    or exists (
      select 1 from public.sessions
      join public.seasons on seasons.id = sessions.season_id
      where sessions.id = session_rosters.session_id
        and seasons.is_published
    )
  );
create policy "Admins can add roster members"
  on public.session_rosters for insert to authenticated
  with check ((select public.is_admin()));
create policy "Admins can remove roster members"
  on public.session_rosters for delete to authenticated
  using ((select public.is_admin()));

create policy "Commitments are visible to their owner, season participants, and admins"
  on public.game_commitments for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select public.is_admin())
    or exists (
      select 1 from public.games
      join public.seasons on seasons.id = games.season_id
      where games.id = game_commitments.game_id
        and seasons.is_published
    )
  );
create policy "Users can set their own commitment for a published game"
  on public.game_commitments for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.games
      join public.seasons on seasons.id = games.season_id
      where games.id = game_commitments.game_id
        and seasons.is_published
    )
  );
create policy "Users can update their own commitment"
  on public.game_commitments for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "Users can delete their own commitment"
  on public.game_commitments for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy "Admins can manage season queue state"
  on public.season_queue_state for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "Players can view their own stats and admins can view all"
  on public.player_season_stats for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

create policy "Users can view their sub requests and pings"
  on public.sub_requests for select to authenticated
  using (
    requester_id = (select auth.uid())
    or current_pinged_user_id = (select auth.uid())
    or (select public.is_admin())
  );
create policy "Users can create their own sub requests"
  on public.sub_requests for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and status = 'searching_primary'
    and current_pinged_user_id is null
    and ping_expires_at is null
    and exists (
      select 1
      from public.games
      join public.seasons on seasons.id = games.season_id
      where games.id = sub_requests.game_id
        and games.season_id = sub_requests.season_id
        and seasons.is_published
    )
  );
create policy "Admins can update sub requests"
  on public.sub_requests for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy "Users can view their own push subscriptions"
  on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "Users can create their own push subscriptions"
  on public.push_subscriptions for insert to authenticated
  with check (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "Users can update their own push subscriptions"
  on public.push_subscriptions for update to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()))
  with check (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "Users can delete their own push subscriptions"
  on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

revoke all on public.profiles, public.seasons, public.sessions, public.games,
  public.session_rosters, public.game_commitments, public.season_queue_state,
  public.player_season_stats, public.sub_requests, public.push_subscriptions
  from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (full_name, gender_match, onboarded, onboarded_at)
  on public.profiles to authenticated;

grant select, insert, update, delete on public.seasons to authenticated;
grant select, insert, update, delete on public.sessions to authenticated;
grant select, insert, update, delete on public.games to authenticated;
grant select, insert, delete on public.session_rosters to authenticated;
grant select, insert, update, delete on public.game_commitments to authenticated;
grant select, insert, update, delete on public.season_queue_state to authenticated;
grant select on public.player_season_stats to authenticated;
grant select, insert, update on public.sub_requests to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
