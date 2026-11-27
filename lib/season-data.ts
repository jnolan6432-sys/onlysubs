import type { SupabaseClient } from "@supabase/supabase-js";

export async function loadSeasonData(
  supabase: SupabaseClient,
  seasonId: string,
) {
  const { data: season, error: seasonError } = await supabase
    .from("seasons")
    .select(
      "id, name, rules_pdf_url, rules_pdf_name, timeout_hours, daytime_start_hour, daytime_end_hour, timezone, game_price_cents, global_claim_hours, gender_match_claim_hours, claims_are_free, created_at, is_published",
    )
    .eq("id", seasonId)
    .maybeSingle();
  if (seasonError) throw new Error(`Could not load season: ${seasonError.message}`);
  if (!season) return null;

  const { data: allSessions, error: sessionsError } = await supabase
    .from("sessions")
    .select("id, name, start_time, archived_at, schedule_id")
    .eq("season_id", seasonId)
    .is("archived_at", null)
    .order("name");
  if (sessionsError) throw new Error(`Could not load sessions: ${sessionsError.message}`);

  const sessions = allSessions ?? [];
  const scheduleIds = [...new Set(
    sessions.flatMap((session) =>
      session.schedule_id ? [session.schedule_id] : [],
    ),
  )];
  const { data: schedules, error: schedulesError } = scheduleIds.length
    ? await supabase
        .from("season_schedules")
        .select("id, name, first_week, last_week")
        .in("id", scheduleIds)
    : { data: [], error: null };
  if (schedulesError) {
    throw new Error(`Could not load season schedules: ${schedulesError.message}`);
  }
  const schedulesById = new Map(
    (schedules ?? []).map((schedule) => [schedule.id, schedule]),
  );
  const sessionIds = sessions.map((session) => session.id);
  const { data: games, error: gamesError } = sessionIds.length
    ? await supabase
        .from("games")
        .select("id, session_id, game_date, start_time, cancelled_at")
        .eq("season_id", seasonId)
        .in("session_id", sessionIds)
        .order("game_date")
    : { data: [], error: null };
  if (gamesError) throw new Error(`Could not load game dates: ${gamesError.message}`);

  const { data: rosters, error: rosterError } = sessionIds.length
    ? await supabase
        .from("session_rosters")
        .select("session_id, user_id")
        .in("session_id", sessionIds)
    : { data: [], error: null };
  if (rosterError) throw new Error(`Could not load session rosters: ${rosterError.message}`);

  const { data: poolMembers, error: poolError } = await supabase
    .from("season_pool_members")
    .select("user_id")
    .eq("season_id", seasonId);
  if (poolError) throw new Error(`Could not load season pool: ${poolError.message}`);

  const userIds = [...new Set([
    ...(rosters ?? []).map((roster) => roster.user_id),
    ...(poolMembers ?? []).map((member) => member.user_id),
  ])];
  const { data: profiles, error: profilesError } = userIds.length
    ? await supabase
        .from("profiles")
        .select("id, full_name, email, gender_match")
        .in("id", userIds)
    : { data: [], error: null };
  if (profilesError) throw new Error(`Could not load player profiles: ${profilesError.message}`);

  const gameIds = (games ?? []).map((game) => game.id);
  const [commitmentsResult, requestsResult] = gameIds.length
    ? await Promise.all([
        supabase.from("game_commitments").select("game_id").in("game_id", gameIds),
        supabase.from("sub_requests").select("game_id").in("game_id", gameIds),
      ])
    : [
        { data: [], error: null },
        { data: [], error: null },
      ];
  if (commitmentsResult.error) {
    throw new Error(`Could not load game commitments: ${commitmentsResult.error.message}`);
  }
  if (requestsResult.error) {
    throw new Error(`Could not load substitute requests: ${requestsResult.error.message}`);
  }

  const lockedGameIds = new Set([
    ...(commitmentsResult.data ?? []).map((commitment) => commitment.game_id),
    ...(requestsResult.data ?? []).map((request) => request.game_id),
  ]);
  const profilesById = new Map(
    (profiles ?? []).map((profile) => [profile.id, profile]),
  );
  const rostersBySession = new Map<string, typeof rosters>();
  for (const roster of rosters ?? []) {
    rostersBySession.set(roster.session_id, [
      ...(rostersBySession.get(roster.session_id) ?? []),
      roster,
    ]);
  }

  const rosterUserIds = new Set((rosters ?? []).map((roster) => roster.user_id));
  const extraPlayers = (poolMembers ?? [])
    .map((member) => profilesById.get(member.user_id))
    .filter(
      (profile): profile is NonNullable<typeof profile> =>
        Boolean(profile && !rosterUserIds.has(profile.id)),
    );

  return {
    season,
    playerCount: (poolMembers ?? []).length,
    sessions: sessions.map((session) => {
      const sessionGames = (games ?? []).filter(
        (game) => game.session_id === session.id,
      );
      const sessionRoster = rostersBySession.get(session.id) ?? [];
      return {
        ...session,
        games: sessionGames,
        dates: sessionGames
          .filter((game) => game.cancelled_at === null)
          .map((game) => game.game_date),
        weekday: sessionGames[0]
          ? new Date(`${sessionGames[0].game_date}T00:00:00Z`).getUTCDay()
          : 2,
        scheduleName:
          (session.schedule_id
            ? schedulesById.get(session.schedule_id)?.name
            : null) ?? "Main schedule",
        firstWeek:
          (session.schedule_id
            ? schedulesById.get(session.schedule_id)?.first_week
            : null) ?? "",
        lastWeek:
          (session.schedule_id
            ? schedulesById.get(session.schedule_id)?.last_week
            : null) ?? "",
        lockedDates: sessionGames
          .filter((game) => lockedGameIds.has(game.id))
          .map((game) => game.game_date),
        players: sessionRoster.map((roster) => {
          const profile = profilesById.get(roster.user_id);
          return {
            name: profile?.full_name ?? "",
            email: profile?.email ?? "",
            gender:
              profile?.gender_match === "MMP"
                ? ("MMP" as const)
                : ("FMP" as const),
          };
        }),
        playerCount: sessionRoster.length,
      };
    }),
    extraPlayers: extraPlayers.map((profile) => ({
      name: profile.full_name ?? "",
      email: profile.email ?? "",
      gender:
        profile.gender_match === "MMP"
          ? ("MMP" as const)
          : ("FMP" as const),
    })),
  };
}
