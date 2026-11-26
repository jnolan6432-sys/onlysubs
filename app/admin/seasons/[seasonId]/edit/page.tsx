import { notFound } from "next/navigation";
import { SeasonBuilder } from "@/app/admin/ui/season-builder";
import { requireAdminPage } from "@/lib/admin";
import { loadSeasonData } from "@/lib/season-data";

export default async function EditSeasonPage({
  params,
}: {
  params: Promise<{ seasonId: string }>;
}) {
  const { supabase } = await requireAdminPage();
  const { seasonId } = await params;

  const data = await loadSeasonData(supabase, seasonId);
  if (!data) notFound();

  return (
    <main className="mx-auto max-w-4xl px-5 py-10 sm:py-14">
      <SeasonBuilder
        initialValue={{
          seasonId: data.season.id,
          name: data.season.name,
          rulesPdfUrl: data.season.rules_pdf_url,
          rulesPdfName: data.season.rules_pdf_name,
          timeoutHours: data.season.timeout_hours,
          daytimeStartHour: data.season.daytime_start_hour,
          daytimeEndHour: data.season.daytime_end_hour,
          timezone: data.season.timezone,
          gamePriceCents: data.season.game_price_cents,
          globalClaimHours: Number(data.season.global_claim_hours),
          genderMatchClaimHours: Number(data.season.gender_match_claim_hours),
          claimsAreFree: data.season.claims_are_free,
          sessions: data.sessions.map((session) => ({
            id: session.id,
            name: session.name,
            startTime: session.start_time.slice(0, 5),
            weekday: session.weekday,
            scheduleName: session.scheduleName,
            firstWeek: session.firstWeek,
            lastWeek: session.lastWeek,
            dates: session.dates,
            lockedDates: session.lockedDates,
            players: session.players,
          })),
          extraPlayers: data.extraPlayers,
        }}
      />
    </main>
  );
}
