import { requireAdminPage } from "@/lib/admin";
import { loadSeasonData } from "@/lib/season-data";
import { MasterAdmin, type SeasonSummary } from "@/app/admin/ui/master-admin";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { supabase } = await requireAdminPage();
  const { season: requestedSeason } = await searchParams;
  const { data: seasonsData, error } = await supabase
    .from("seasons")
    .select("id, name, is_published")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not load seasons: ${error.message}`);

  const seasons: SeasonSummary[] = seasonsData ?? [];
  const selectedId = requestedSeason ?? seasons[0]?.id;
  let initialData = null;

  if (selectedId) {
    const data = await loadSeasonData(supabase, selectedId);
    if (data) {
      initialData = {
        season: data.season,
        sessions: data.sessions.map((session) => ({
          id: session.id,
          name: session.name,
          start_time: session.start_time,
          weekday: session.weekday,
          dates: session.dates,
          lockedDates: session.lockedDates,
          players: session.players,
          games: session.games,
        })),
        extraPlayers: data.extraPlayers,
      };
    }
  }

  return <MasterAdmin seasons={seasons} initialData={initialData} />;
}
