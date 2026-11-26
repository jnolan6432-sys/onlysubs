create table public.season_schedules (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons (id) on delete cascade,
  name text not null,
  first_week date,
  last_week date,
  constraint season_schedules_name_season_unique unique (season_id, name),
  constraint season_schedules_range_valid
    check (first_week is null or last_week is null or last_week >= first_week)
);

create index season_schedules_season_id_idx
  on public.season_schedules (season_id);

alter table public.season_schedules enable row level security;

create policy "Season schedules are visible to season members and admins"
  on public.season_schedules for select to authenticated
  using (
    (select public.is_admin())
    or exists (
      select 1
      from public.season_pool_members m
      where m.season_id = season_schedules.season_id
        and m.user_id = auth.uid()
    )
  );

alter table public.sessions
  add column schedule_id uuid references public.season_schedules (id) on delete set null;
