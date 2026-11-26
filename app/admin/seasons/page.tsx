import { requireAdminPage } from "@/lib/admin";
import { SeasonsList } from "@/app/admin/ui/seasons-list";

export default async function SeasonsPage() {
  const { supabase } = await requireAdminPage();
  const { data: seasons, error: seasonsError } = await supabase
    .from("seasons")
    .select("id, name, is_published, created_at")
    .order("created_at", { ascending: false });
  if (seasonsError) {
    throw new Error(`Could not load seasons: ${seasonsError.message}`);
  }

  const seasonIds = (seasons ?? []).map((season) => season.id);
  const { data: sessions, error: sessionsError } = seasonIds.length
    ? await supabase
        .from("sessions")
        .select("id, season_id")
        .in("season_id", seasonIds)
        .is("archived_at", null)
    : { data: [], error: null };
  if (sessionsError) {
    throw new Error(`Could not load season sessions: ${sessionsError.message}`);
  }

  const sessionIds = (sessions ?? []).map((session) => session.id);
  const [gamesResult, playersResult] = seasonIds.length
    ? await Promise.all([
        sessionIds.length
          ? supabase
              .from("games")
              .select("season_id, game_date")
              .in("session_id", sessionIds)
          : Promise.resolve({ data: [], error: null }),
        supabase
          .from("season_pool_members")
          .select("season_id, user_id")
          .in("season_id", seasonIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (gamesResult.error) {
    throw new Error(`Could not load season game dates: ${gamesResult.error.message}`);
  }
  if (playersResult.error) {
    throw new Error(`Could not load season players: ${playersResult.error.message}`);
  }

  const sessionCounts = new Map<string, number>();
  for (const session of sessions ?? []) {
    sessionCounts.set(
      session.season_id,
      (sessionCounts.get(session.season_id) ?? 0) + 1,
    );
  }
  const datesBySeason = new Map<string, Set<string>>();
  for (const game of gamesResult.data ?? []) {
    const dates = datesBySeason.get(game.season_id) ?? new Set<string>();
    dates.add(game.game_date);
    datesBySeason.set(game.season_id, dates);
  }
  const playerCounts = new Map<string, number>();
  for (const member of playersResult.data ?? []) {
    playerCounts.set(
      member.season_id,
      (playerCounts.get(member.season_id) ?? 0) + 1,
    );
  }

  const seasonItems = (seasons ?? []).map((season) => ({
    id: season.id,
    name: season.name,
    is_published: season.is_published,
    sessionCount: sessionCounts.get(season.id) ?? 0,
    gameDateCount: datesBySeason.get(season.id)?.size ?? 0,
    playerCount: playerCounts.get(season.id) ?? 0,
  }));

  return (
    <main className="mx-auto max-w-5xl px-5 py-10 sm:py-14">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-teal-700">
          Administration
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          Manage Seasons
        </h1>
      </div>

      <SeasonsList initialSeasons={seasonItems} />
    </main>
  );
}
