import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/admin";
import { loadSeasonData } from "@/lib/season-data";
import { AdminNoGamesBoard } from "@/app/admin/ui/admin-no-games-board";

export default async function SeasonOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ seasonId: string }>;
  searchParams: Promise<{ retainedGames?: string }>;
}) {
  const { supabase } = await requireAdminPage();
  const { seasonId } = await params;
  const { retainedGames } = await searchParams;

  const data = await loadSeasonData(supabase, seasonId);
  if (!data) notFound();

  return (
    <main className="mx-auto h-dvh max-w-5xl overflow-hidden px-5 py-3">
      {Number(retainedGames) > 0 && (
        <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {retainedGames} removed date{retainedGames === "1" ? "" : "s"} still
          have commitments or substitute requests.
        </p>
      )}
      <AdminNoGamesBoard
        seasonId={seasonId}
        seasonName={data.season.name}
        sessions={data.sessions.map((session) => ({
          id: session.id,
          name: session.name,
          startTime: session.start_time.slice(0, 5),
          games: session.games,
        }))}
        timezone={data.season.timezone}
      />
    </main>
  );
}
