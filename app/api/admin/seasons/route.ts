import { NextRequest, NextResponse } from "next/server";
import { authorizeAdmin, errorResponse } from "@/lib/admin-api";
import { createServiceClient } from "@/lib/admin";

type PlayerInput = { name: string; email: string; gender: "FMP" | "MMP" };
type SessionInput = {
  id?: string;
  schedule_id?: string;
  name: string;
  start_time: string;
  weekday?: number;
  schedule_name?: string;
  first_week?: string | null;
  last_week?: string | null;
  dates: string[];
  players: PlayerInput[];
};
type BuilderInput = {
  season_id?: string;
  name: string;
  timeout_hours: number;
  daytime_start_hour: number;
  daytime_end_hour: number;
  timezone: string;
  game_price_cents: number;
  global_claim_hours: number;
  gender_match_claim_hours: number;
  claims_are_free: boolean;
  sessions: SessionInput[];
  extra_players: PlayerInput[];
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePlayer(value: unknown, label: string): PlayerInput {
  if (!isRecord(value)) throw new Error(`${label} must include a name and email.`);
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const email =
    typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  if (name.length > 120 || !emailPattern.test(email) || email.length > 320) {
    throw new Error(`${label} needs a valid email address.`);
  }
  const gender = value.gender;
  if (gender !== "FMP" && gender !== "MMP") {
    throw new Error(`${label} needs an FMP or MMP gender selection.`);
  }
  return { name, email, gender };
}

function parseBuilderInput(value: unknown): BuilderInput {
  if (!isRecord(value)) throw new Error("The season form is invalid.");

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 120) {
    throw new Error("Enter a season name (up to 120 characters).");
  }

  const timeout = value.timeout_hours;
  const dayStart = value.daytime_start_hour;
  const dayEnd = value.daytime_end_hour;
  const gamePriceCents = value.game_price_cents;
  const globalClaimHours = value.global_claim_hours;
  const genderMatchClaimHours = value.gender_match_claim_hours;
  const claimsAreFree = value.claims_are_free;
  if (
    !Number.isInteger(timeout) ||
    (timeout as number) < 1 ||
    (timeout as number) > 168 ||
    !Number.isInteger(dayStart) ||
    (dayStart as number) < 0 ||
    (dayStart as number) > 23 ||
    !Number.isInteger(dayEnd) ||
    (dayEnd as number) < 0 ||
    (dayEnd as number) > 23 ||
    (dayStart as number) >= (dayEnd as number)
  ) {
    throw new Error("Choose a valid timeout and daytime window.");
  }
  if (
    !Number.isInteger(gamePriceCents) ||
    (gamePriceCents as number) < 0 ||
    (gamePriceCents as number) > 100_000 ||
    typeof globalClaimHours !== "number" ||
    !Number.isFinite(globalClaimHours) ||
    globalClaimHours <= 0 ||
    globalClaimHours > 168 ||
    typeof genderMatchClaimHours !== "number" ||
    !Number.isFinite(genderMatchClaimHours) ||
    genderMatchClaimHours < 0 ||
    genderMatchClaimHours > 168 ||
    typeof claimsAreFree !== "boolean"
  ) {
    throw new Error("Choose valid game price and claim window settings.");
  }
  const timezone =
    typeof value.timezone === "string" ? value.timezone.trim() : "";
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error("Choose a valid IANA timezone.");
  }

  if (value.season_id !== undefined && !uuidPattern.test(String(value.season_id))) {
    throw new Error("The season being edited is invalid.");
  }
  if (!Array.isArray(value.sessions) || value.sessions.length === 0) {
    throw new Error("Add at least one session.");
  }

  const sessions = value.sessions.map((session, index): SessionInput => {
    if (!isRecord(session)) throw new Error(`Session ${index + 1} is invalid.`);
    const sessionName =
      typeof session.name === "string" ? session.name.trim() : "";
    const startTime =
      typeof session.start_time === "string" ? session.start_time : "";
    if (!sessionName || sessionName.length > 120 || !timePattern.test(startTime)) {
      throw new Error(`Session ${index + 1} needs a name and valid start time.`);
    }
    if (session.id !== undefined && !uuidPattern.test(String(session.id))) {
      throw new Error(`Session ${index + 1} has an invalid ID.`);
    }
    if (!Array.isArray(session.dates) || session.dates.length === 0) {
      throw new Error(`Select at least one date for ${sessionName}.`);
    }
    const dates = [...new Set(session.dates.map(String))];
    if (
      dates.some((date) => {
        if (!datePattern.test(date)) return true;
        const parsed = new Date(`${date}T00:00:00.000Z`);
        return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date;
      })
    ) {
      throw new Error(`${sessionName} has an invalid date.`);
    }
    if (session.schedule_id !== undefined && !uuidPattern.test(String(session.schedule_id))) {
      throw new Error(`Session ${index + 1} has an invalid schedule ID.`);
    }
    if (!Array.isArray(session.players)) {
      throw new Error(`Players for ${sessionName} are invalid.`);
    }

    return {
      ...(session.id ? { id: String(session.id) } : {}),
      ...(session.schedule_id ? { schedule_id: String(session.schedule_id) } : {}),
      name: sessionName,
      start_time: startTime,
      weekday:
        typeof session.weekday === "number" &&
        Number.isInteger(session.weekday) &&
        session.weekday >= 0 &&
        session.weekday <= 6
          ? session.weekday
          : undefined,
      schedule_name:
        typeof session.schedule_name === "string"
          ? session.schedule_name.trim()
          : undefined,
      first_week:
        typeof session.first_week === "string" ? session.first_week : null,
      last_week:
        typeof session.last_week === "string" ? session.last_week : null,
      dates,
      players: session.players.map((player, playerIndex) =>
        parsePlayer(player, `Player ${playerIndex + 1} in ${sessionName}`),
      ),
    };
  });

  const sessionKeys = new Set<string>();
  for (const session of sessions) {
    const key = `${session.name.toLowerCase()}|${session.start_time}`;
    if (sessionKeys.has(key)) {
      throw new Error(`Only one session can use ${session.name} at ${session.start_time}.`);
    }
    sessionKeys.add(key);
  }

  const extraPlayers = Array.isArray(value.extra_players)
    ? value.extra_players.map((player, index) =>
        parsePlayer(player, `Season invitee ${index + 1}`),
      )
    : [];
  const emails = sessions.flatMap((session) => {
    const sessionEmails = session.players.map((player) => player.email);
    if (new Set(sessionEmails).size !== sessionEmails.length) {
      throw new Error(`A player email is listed more than once in ${session.name}.`);
    }
    return sessionEmails;
  });
  const rosterEmails = new Set(emails);
  const extraEmails = extraPlayers.map((player) => player.email);
  if (
    new Set(extraEmails).size !== extraEmails.length ||
    extraEmails.some((email) => rosterEmails.has(email))
  ) {
    throw new Error("Season invitees must be unique and not already on a session roster.");
  }

  return {
    ...(value.season_id ? { season_id: String(value.season_id) } : {}),
    name,
    timeout_hours: timeout as number,
    daytime_start_hour: dayStart as number,
    daytime_end_hour: dayEnd as number,
    timezone,
    game_price_cents: gamePriceCents as number,
    global_claim_hours: globalClaimHours,
    gender_match_claim_hours: genderMatchClaimHours,
    claims_are_free: claimsAreFree,
    sessions,
    extra_players: extraPlayers,
  };
}

export async function POST(request: NextRequest) {
  try {
    const { context, response } = await authorizeAdmin();
    if (!context) return response;

    let input: BuilderInput;
    try {
      input = parseBuilderInput(await request.json());
    } catch (error) {
      return errorResponse(error, 400);
    }

    const people = new Map<string, PlayerInput>();
    for (const player of [
      ...input.sessions.flatMap((session) => session.players),
      ...input.extra_players,
    ]) {
      const previous = people.get(player.email);
      if (previous && previous.name.toLowerCase() !== player.name.toLowerCase()) {
        return errorResponse(
          new Error(`Use the same player name for ${player.email} throughout the season.`),
          400,
        );
      }
      if (previous && previous.gender !== player.gender) {
        return errorResponse(
          new Error(`Use the same gender for ${player.email} throughout the season.`),
          400,
        );
      }
      if (!previous) people.set(player.email, player);
    }

    const emails = [...people.keys()];
    const existingProfiles = emails.length
      ? await context.supabase
          .from("profiles")
          .select("id, email")
          .in("email", emails)
      : { data: [], error: null };
    if (existingProfiles.error) {
      throw new Error(`Could not look up players: ${existingProfiles.error.message}`);
    }

    const idsByEmail = new Map(
      (existingProfiles.data ?? []).flatMap((profile) =>
        profile.email
          ? [[profile.email.toLowerCase(), profile.id] as const]
          : [],
      ),
    );
    let serviceClient: ReturnType<typeof createServiceClient> | null = null;

    for (const [email, player] of people) {
      if (idsByEmail.has(email)) continue;
      serviceClient ??= createServiceClient();

      const { data, error } = await serviceClient.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: { full_name: player.name },
      });

      if (!error && data.user) {
        idsByEmail.set(email, data.user.id);
        continue;
      }

      const { data: matchingProfile, error: retryError } = await context.supabase
        .from("profiles")
        .select("id, email")
        .ilike("email", email.replace(/[\\%_]/g, "\\$&"))
        .maybeSingle();
      if (retryError) {
        throw new Error(`Could not look up ${email}: ${retryError.message}`);
      }
      if (matchingProfile?.email) {
        idsByEmail.set(matchingProfile.email.toLowerCase(), matchingProfile.id);
      } else {
        throw new Error(`Could not create or find ${email}: ${error?.message}`);
      }
    }

    const payload = {
      ...input,
      timezone_name: input.timezone,
      sessions: input.sessions.map((session) => ({
        ...session,
        players: session.players.map((player) => ({
          ...player,
          name: people.get(player.email)?.name ?? player.name,
          user_id: idsByEmail.get(player.email),
        })),
      })),
      extra_players: input.extra_players.map((player) => ({
        ...player,
        name: people.get(player.email)?.name ?? player.name,
        user_id: idsByEmail.get(player.email),
      })),
    };

    const { data, error } = await context.supabase.rpc("publish_season_with_timezone", {
      p_payload: payload,
      p_timezone_name: input.timezone,
    });
    if (error) throw new Error(`Could not publish season: ${error.message}`);

    serviceClient ??= createServiceClient();
    const seasonId =
      typeof data === "object" && data !== null && "season_id" in data
        ? String((data as { season_id: unknown }).season_id)
        : input.season_id;
    if (seasonId) {
      const { data: savedSessions, error: savedSessionsError } = await serviceClient
        .from("sessions")
        .select("id, name, start_time")
        .eq("season_id", seasonId)
        .is("archived_at", null);
      if (savedSessionsError) {
        throw new Error(`Could not reload saved sessions: ${savedSessionsError.message}`);
      }
      const sessionIdsByKey = new Map(
        (savedSessions ?? []).map((session) => [
          `${session.name.toLowerCase()}|${session.start_time.slice(0, 5)}`,
          session.id,
        ]),
      );

      const updatedScheduleIds = new Set<string>();
      for (const session of input.sessions) {
        const sessionId = session.id ?? sessionIdsByKey.get(
          `${session.name.toLowerCase()}|${session.start_time}`,
        );
        if (!sessionId) {
          throw new Error(`Could not identify the saved session ${session.name}.`);
        }
        const scheduleValues = {
          name: session.schedule_name || session.name,
          first_week: session.first_week ?? null,
          last_week: session.last_week ?? null,
        };
        const updateExistingSchedule = Boolean(
          session.schedule_id && !updatedScheduleIds.has(session.schedule_id),
        );
        if (updateExistingSchedule && session.schedule_id) {
          updatedScheduleIds.add(session.schedule_id);
        }
        const scheduleResult = updateExistingSchedule && session.schedule_id
          ? await serviceClient
              .from("season_schedules")
              .update(scheduleValues)
              .eq("id", session.schedule_id)
              .eq("season_id", seasonId)
              .select("id")
              .maybeSingle()
          : await serviceClient
              .from("season_schedules")
              .upsert(
                { season_id: seasonId, ...scheduleValues },
                { onConflict: "season_id,name" },
              )
              .select("id")
              .single();
        if (scheduleResult.error || !scheduleResult.data) {
          throw new Error(
            `Could not save the schedule for ${session.name}: ${scheduleResult.error?.message ?? "Schedule not found."}`,
          );
        }
        const { error: linkError } = await serviceClient
          .from("sessions")
          .update({ schedule_id: scheduleResult.data.id })
          .eq("id", sessionId)
          .eq("season_id", seasonId);
        if (linkError) {
          throw new Error(`Could not link ${session.name} to its schedule: ${linkError.message}`);
        }
      }
    }
    for (const [email, player] of people) {
      const userId = idsByEmail.get(email);
      if (!userId) continue;
      const { error: genderError } = await serviceClient
        .from("profiles")
        .update({
          gender_match: player.gender,
          onboarded: true,
          onboarded_at: new Date().toISOString(),
        })
        .eq("id", userId);
      if (genderError) {
        throw new Error(`Could not save gender for ${email}: ${genderError.message}`);
      }
    }

    return NextResponse.json(data);
  } catch (error) {
    return errorResponse(error);
  }
}
