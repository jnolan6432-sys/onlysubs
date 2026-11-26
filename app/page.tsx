import { createClient } from "@/lib/supabase/server";
import { AuthForm } from "./ui/auth-form";
import { NotificationsButton } from "./ui/notifications-button";
import { SignOutButton } from "./ui/sign-out-button";
import { CalendarDashboard } from "./ui/calendar-dashboard";
import { createServiceClient } from "@/lib/admin";
import { wallClockToDate } from "@/lib/timezone-format";
import type {
  SeasonLedgerRecord,
  SeasonSettlementPayment,
} from "@/lib/season-settlements";
import { calculateSeasonSettlements } from "@/lib/season-settlements";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ authError?: string }>;
}) {
  const { authError } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile, error: profileError } = user
    ? await supabase
        .from("profiles")
      .select("is_admin, gender_match")
        .eq("id", user.id)
        .maybeSingle()
    : { data: null, error: null };
  if (profileError) throw new Error(`Could not load your profile: ${profileError.message}`);

  let calendar: React.ComponentProps<typeof CalendarDashboard>["seasons"] = [];
  let pendingPings: React.ComponentProps<typeof CalendarDashboard>["pendingPings"] = [];

  if (user) {
    const { data: pendingRequests, error: requestsError } = await supabase
      .from("sub_requests")
      .select("id, game_id, ping_expires_at")
      .eq("current_pinged_user_id", user.id)
      .in("status", ["searching_primary", "searching_fallback"]);
    if (requestsError) {
      throw new Error(`Could not load your pending substitute pings: ${requestsError.message}`);
    }

    const pendingGameIds = [...new Set(
      (pendingRequests ?? []).map((request) => request.game_id),
    )];
    if (pendingGameIds.length) {
      const { data: pendingGames, error: pendingGamesError } = await supabase
        .from("games")
        .select("id, game_date, start_time, season_id")
        .in("id", pendingGameIds);
      if (pendingGamesError) {
        throw new Error(`Could not load pinged games: ${pendingGamesError.message}`);
      }

      const pendingSeasonIds = [...new Set(
        (pendingGames ?? []).map((game) => game.season_id),
      )];
      const { data: pendingSeasons, error: pendingSeasonsError } = pendingSeasonIds.length
        ? await supabase
            .from("seasons")
            .select("id, name, timezone, global_claim_hours, gender_match_claim_hours")
            .in("id", pendingSeasonIds)
        : { data: [], error: null };
      if (pendingSeasonsError) {
        throw new Error(`Could not load pinged seasons: ${pendingSeasonsError.message}`);
      }

      const pendingGamesById = new Map(
        (pendingGames ?? []).map((game) => [game.id, game]),
      );
      const pendingSeasonNames = new Map(
        (pendingSeasons ?? []).map((season) => [
          season.id,
          {
            name: season.name,
            timezone: season.timezone,
            globalClaimHours: Number(season.global_claim_hours),
            genderMatchClaimHours: Number(season.gender_match_claim_hours),
          },
        ]),
      );
      pendingPings = (pendingRequests ?? []).flatMap((request) => {
        const game = pendingGamesById.get(request.game_id);
        if (!game || !request.ping_expires_at) return [];
        return [{
          id: request.id,
          gameId: game.id,
          gameDate: game.game_date,
          startTime: game.start_time,
          seasonName:
            pendingSeasonNames.get(game.season_id)?.name ?? "Season",
          timezone:
            pendingSeasonNames.get(game.season_id)?.timezone ??
            "America/Los_Angeles",
          globalClaimHours:
            pendingSeasonNames.get(game.season_id)?.globalClaimHours ?? 2,
          genderMatchClaimHours:
            pendingSeasonNames.get(game.season_id)?.genderMatchClaimHours ?? 1,
          expiresAt: request.ping_expires_at,
        }];
      });
    }

    const { data: memberships, error: membershipsError } = await supabase
      .from("season_pool_members")
      .select("season_id")
      .eq("user_id", user.id);
    if (membershipsError) {
      throw new Error(`Could not load your seasons: ${membershipsError.message}`);
    }

    const seasonIds = (memberships ?? []).map((membership) => membership.season_id);
    if (seasonIds.length) {
      const { data: seasons, error: seasonsError } = await supabase
        .from("seasons")
        .select(
          "id, name, rules_pdf_url, rules_pdf_name, timezone, game_price_cents, global_claim_hours, gender_match_claim_hours, claims_are_free",
        )
        .in("id", seasonIds)
        .eq("is_published", true);
      if (seasonsError) {
        throw new Error(`Could not load your seasons: ${seasonsError.message}`);
      }

      const publishedSeasons = seasons ?? [];
      const publishedSeasonIds = publishedSeasons.map((season) => season.id);
      if (publishedSeasonIds.length) {
        const { data: games, error: gamesError } = await supabase
          .from("games")
          .select("id, season_id, session_id, game_date, start_time, cancelled_at")
          .in("season_id", publishedSeasonIds)
          .order("game_date")
          .order("start_time");
        if (gamesError) {
          throw new Error(`Could not load your calendar: ${gamesError.message}`);
        }

        const gameIds = (games ?? []).map((game) => game.id);
        const sessionIds = [...new Set((games ?? []).map((game) => game.session_id))];
        const [commitmentsResult, sessionsResult, slotsResult] = await Promise.all([
          gameIds.length
            ? supabase
                .from("game_commitments")
                .select("game_id, status")
                .eq("user_id", user.id)
                .in("game_id", gameIds)
            : Promise.resolve({ data: [], error: null }),
          sessionIds.length
            ? supabase
                .from("sessions")
                .select("id, season_id, name, start_time")
                .in("id", sessionIds)
            : Promise.resolve({ data: [], error: null }),
          gameIds.length
            ? supabase.rpc("get_calendar_slot_counts", { p_game_ids: gameIds })
            : Promise.resolve({ data: [], error: null }),
        ]);
        if (commitmentsResult.error) {
          throw new Error(
            `Could not load your commitments: ${commitmentsResult.error.message}`,
          );
        }
        if (sessionsResult.error) {
          throw new Error(`Could not load your sessions: ${sessionsResult.error.message}`);
        }
        if (slotsResult.error) {
          throw new Error(`Could not load substitute counts: ${slotsResult.error.message}`);
        }

        const sessionsBySeason = new Map(
          publishedSeasons.map((season) => [
            season.id,
            (sessionsResult.data ?? [])
              .filter((session) => session.season_id === season.id)
              .map((session) => ({
                id: session.id,
                name: session.name,
                startTime: session.start_time,
              })),
          ]),
        );
        const commitments = new Map(
          (commitmentsResult.data ?? []).map((commitment) => [
            commitment.game_id,
            commitment.status,
          ]),
        );
        const slotCounts = new Map<
          string,
          { fmp: number; mmp: number }
        >(
          (slotsResult.data ?? []).map(
            (row: {
              game_id: string;
              fmp_slots_to_fill: number | string;
              mmp_slots_to_fill: number | string;
            }) => [
              row.game_id,
              {
                fmp: Number(row.fmp_slots_to_fill),
                mmp: Number(row.mmp_slots_to_fill),
              },
            ] as const,
          ),
        );
        const finalStartsBySeason = new Map(
          publishedSeasons.map((season) => {
            const seasonGames = (games ?? []).filter(
              (game) => game.season_id === season.id && !game.cancelled_at,
            );
            const finalStartsAt = seasonGames.length
              ? Math.max(
                  ...seasonGames.map((game) =>
                    wallClockToDate(
                      game.game_date,
                      game.start_time,
                      season.timezone,
                    ).getTime(),
                  ),
                )
              : null;
            return [season.id, finalStartsAt] as const;
          }),
        );
        const serviceClient = createServiceClient();
        const financialsBySeason = new Map<
          string,
          {
            ledgerEntries: SeasonLedgerRecord[];
            settlementPayments: SeasonSettlementPayment[];
          }
        >();
        for (const season of publishedSeasons) {
          const { error: evaluationError } = await serviceClient.rpc(
            "evaluate_season_game_financials",
            { p_season_id: season.id },
          );
          if (evaluationError) {
            throw new Error(
              `Could not evaluate season exchanges: ${evaluationError.message}`,
            );
          }
          const { error: settlementError } = await serviceClient.rpc(
            "initialize_season_settlement_payments",
            { p_season_id: season.id },
          );
          if (settlementError) {
            throw new Error(
              `Could not initialize settlement payments: ${settlementError.message}`,
            );
          }

          const [ledgerResult, paymentsResult] = await Promise.all([
            serviceClient
              .from("season_exchange_ledger")
              .select(
                "id, game_date, original_regular_user_id, substitute_user_id, fill_method, was_free_claim, amount_cents",
              )
              .eq("season_id", season.id)
              .order("game_date"),
            serviceClient
              .from("season_settlement_payments")
              .select(
                "debtor_id, creditor_id, amount_cents, is_paid, paid_at",
              )
              .eq("season_id", season.id)
              .order("debtor_id")
              .order("creditor_id"),
          ]);
          if (ledgerResult.error) {
            throw new Error(
              `Could not load season exchanges: ${ledgerResult.error.message}`,
            );
          }
          if (paymentsResult.error) {
            throw new Error(
              `Could not load settlement payments: ${paymentsResult.error.message}`,
            );
          }

          const playerIds = [...new Set([
            ...(ledgerResult.data ?? []).flatMap((entry) => [
              entry.original_regular_user_id,
              entry.substitute_user_id,
            ]),
            ...(paymentsResult.data ?? []).flatMap((payment) => [
              payment.debtor_id,
              payment.creditor_id,
            ]),
          ])];
          const { data: financialProfiles, error: financialProfilesError } =
            playerIds.length
              ? await serviceClient
                  .from("profiles")
                  .select("id, full_name")
                  .in("id", playerIds)
              : { data: [], error: null };
          if (financialProfilesError) {
            throw new Error(
              `Could not load exchange player names: ${financialProfilesError.message}`,
            );
          }
          const namesById = new Map(
            (financialProfiles ?? []).map((player) => [
              player.id,
              player.full_name || "Player",
            ]),
          );
          const ledgerEntries: SeasonLedgerRecord[] = (ledgerResult.data ?? []).map(
            (entry) => ({
              id: entry.id,
              gameDate: entry.game_date,
              originalRegularPlayerId: entry.original_regular_user_id,
              substitutePlayerId: entry.substitute_user_id,
              originalRegularPlayerName:
                namesById.get(entry.original_regular_user_id) ?? "Player",
              substitutePlayerName:
                namesById.get(entry.substitute_user_id) ?? "Player",
              fillMethod: entry.fill_method,
              wasFreeClaim: entry.was_free_claim,
              amountCents: entry.amount_cents,
            }),
          );
          const storedPayments: SeasonSettlementPayment[] =
            (paymentsResult.data ?? []).map((payment) => ({
              debtorId: payment.debtor_id,
              creditorId: payment.creditor_id,
              debtorName: namesById.get(payment.debtor_id) ?? "Player",
              creditorName: namesById.get(payment.creditor_id) ?? "Player",
              amountCents: payment.amount_cents,
              isPaid: payment.is_paid,
              paidAt: payment.paid_at,
            }));
          const payments =
            storedPayments.length > 0
              ? storedPayments
              : calculateSeasonSettlements(ledgerEntries).map((payment) => ({
                  ...payment,
                  debtorName: namesById.get(payment.debtorId) ?? "Player",
                  creditorName: namesById.get(payment.creditorId) ?? "Player",
                  isPaid: false,
                  paidAt: null,
                }));
          financialsBySeason.set(season.id, {
            ledgerEntries: ledgerEntries.filter(
              (entry) =>
                entry.originalRegularPlayerId === user.id ||
                entry.substitutePlayerId === user.id,
            ),
            settlementPayments: payments.filter(
              (payment) =>
                payment.debtorId === user.id || payment.creditorId === user.id,
            ),
          });
        }
        calendar = publishedSeasons.map((season) => ({
          id: season.id,
          name: season.name,
          rulesPdfUrl: season.rules_pdf_url,
          rulesPdfName: season.rules_pdf_name,
          timezone: season.timezone,
          gamePriceCents: season.game_price_cents,
          globalClaimHours: Number(season.global_claim_hours),
          genderMatchClaimHours: Number(season.gender_match_claim_hours),
          claimsAreFree: season.claims_are_free,
          playerGender: profile?.gender_match ?? null,
          ledgerEntries:
            financialsBySeason.get(season.id)?.ledgerEntries ?? [],
          settlementPayments:
            financialsBySeason.get(season.id)?.settlementPayments ?? [],
          finalGameStartsAt: finalStartsBySeason.get(season.id) ?? null,
          sessions: sessionsBySeason.get(season.id) ?? [],
          games: (games ?? [])
            .filter((game) => game.season_id === season.id)
            .map((game) => ({
              id: game.id,
              gameDate: game.game_date,
              startTime: game.start_time,
              sessionId: game.session_id,
              status:
                commitments.get(game.id) === "playing"
                  ? "playing"
                  : commitments.get(game.id) === "available"
                    ? "available"
                    : "unavailable",
              cancelled: game.cancelled_at !== null,
              fmpSlotsToFill: slotCounts.get(game.id)?.fmp ?? 0,
              mmpSlotsToFill: slotCounts.get(game.id)?.mmp ?? 0,
              timezone: season.timezone,
            })),
        }));
      }
    }
  }

  return (
    <main
      className={
        user
          ? "mx-auto h-dvh max-w-5xl overflow-hidden px-5 py-3"
          : "flex min-h-screen items-center justify-center px-5 py-12"
      }
    >
      <section
        className={
          user
            ? "flex h-full w-full flex-col overflow-hidden rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-7"
            : "w-full max-w-lg rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200 sm:p-10"
        }
      >
        <p className="shrink-0 text-sm font-semibold uppercase tracking-[0.18em] text-teal-700">
          OnlySubs
        </p>
        {authError && (
          <p aria-live="polite" className="mt-4 text-sm text-red-700">
            That sign-in link is invalid or expired. Request a new one.
          </p>
        )}
        {user ? (
          <div className="mt-5 flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">
                  Your calendar
                </h1>
                <p className="mt-2 break-all text-sm text-slate-600">{user.email}</p>
              </div>
              <div className="flex flex-wrap gap-3">
              <NotificationsButton />
              <SignOutButton />
              </div>
            </div>
            {calendar.length === 0 ? (
              <p className="mt-8 rounded-lg bg-slate-50 p-5 text-slate-600">
                You haven&apos;t been added to a season yet. Your game calendar
                will appear here when you join one.
              </p>
            ) : (
              <CalendarDashboard
                seasons={calendar}
                pendingPings={pendingPings}
                serverNow={new Date().toISOString()}
                userId={user.id}
              />
            )}
          </div>
        ) : (
          <div className="mt-5">
            <h1 className="text-3xl font-semibold tracking-tight">
              Find a sub for your next game.
            </h1>
            <p className="mt-3 text-slate-600">
              Sign in with a secure link sent to your email.
            </p>
            <AuthForm />
          </div>
        )}
      </section>
    </main>
  );
}
