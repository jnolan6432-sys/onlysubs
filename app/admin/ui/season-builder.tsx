"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type PlayerDraft = { name: string; email: string; gender: "FMP" | "MMP" };
type SessionDraft = {
  id?: string;
  name: string;
  startTime: string;
  weekday: number;
  scheduleName: string;
  firstWeek: string;
  lastWeek: string;
  dates: string[];
  lockedDates: string[];
  players: PlayerDraft[];
};
type BuilderValue = {
  seasonId?: string;
  name: string;
  rulesPdfUrl: string | null;
  rulesPdfName: string | null;
  timeoutHours: number;
  daytimeStartHour: number;
  daytimeEndHour: number;
  timezone: string;
  gamePriceCents: number;
  globalClaimHours: number;
  genderMatchClaimHours: number;
  claimsAreFree: boolean;
  sessions: SessionDraft[];
  extraPlayers: PlayerDraft[];
};

const blankPlayer = (gender: "FMP" | "MMP" = "FMP"): PlayerDraft => ({
  name: "",
  email: "",
  gender,
});
const leagueTimezones = [
  ["America/Los_Angeles", "Pacific (Los Angeles)"],
  ["America/Denver", "Mountain (Denver)"],
  ["America/Phoenix", "Mountain (Phoenix)"],
  ["America/Chicago", "Central (Chicago)"],
  ["America/New_York", "Eastern (New York)"],
  ["America/Anchorage", "Alaska (Anchorage)"],
  ["Pacific/Honolulu", "Hawaii (Honolulu)"],
] as const;
const blankSession = (): SessionDraft => ({
  name: "",
  startTime: "19:00",
  weekday: 2,
  scheduleName: "Main schedule",
  firstWeek: "",
  lastWeek: "",
  dates: [],
  lockedDates: [],
  players: [],
});

const newBuilder = (): BuilderValue => ({
  name: "",
  rulesPdfUrl: null,
  rulesPdfName: null,
  timeoutHours: 2,
  daytimeStartHour: 8,
  daytimeEndHour: 22,
  timezone: "America/Los_Angeles",
  gamePriceCents: 1200,
  globalClaimHours: 2,
  genderMatchClaimHours: 1,
  claimsAreFree: true,
  sessions: [blankSession()],
  extraPlayers: [],
});

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(year, month - 1, day));
}

function parsePriceCents(value: string) {
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value.trim());
  if (!match) return null;

  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= 100_000 ? cents : null;
}

function getScheduleDates(
  session: SessionDraft,
) {
  if (!session.firstWeek || !session.lastWeek) return session.dates;
  const start = new Date(`${session.firstWeek}T00:00:00.000Z`);
  const end = new Date(`${session.lastWeek}T00:00:00.000Z`);
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf()) || end < start) {
    return session.dates;
  }
  const startOfWeek = new Date(start);
  startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay());
  const startOffset = session.weekday;
  const dates: string[] = [];
  for (
    let cursor = new Date(startOfWeek);
    cursor <= end;
    cursor = new Date(cursor.valueOf() + 7 * 24 * 60 * 60 * 1000)
  ) {
    const date = new Date(cursor.valueOf() + startOffset * 24 * 60 * 60 * 1000);
    if (date >= start && date <= end) dates.push(date.toISOString().slice(0, 10));
  }
  return dates.length ? [...new Set([...session.dates, ...dates])].sort() : session.dates;
}

function DatePicker({
  dates,
  lockedDates,
  onChange,
}: {
  dates: string[];
  lockedDates: string[];
  onChange: (dates: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => {
    const first = dates[0];
    if (first) {
      const [year, monthNumber, day] = first.split("-").map(Number);
      return new Date(year, monthNumber - 1, day);
    }
    return new Date();
  });
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const leadingDays = firstDay.getDay();
  const dayCount = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const cells = Array.from({ length: leadingDays + dayCount }, (_, index) =>
    index < leadingDays ? null : index - leadingDays + 1,
  );
  const monthLabel = new Intl.DateTimeFormat("en", {
    month: "long",
    year: "numeric",
  }).format(month);

  function toggleDate(value: string) {
    if (lockedDates.includes(value)) return;
    onChange(
      dates.includes(value)
        ? dates.filter((date) => date !== value)
        : [...dates, value].sort(),
    );
  }

  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-800">Game dates</p>
      <button
        aria-expanded={open}
        className="w-full rounded-lg border border-slate-300 px-4 py-3 text-left text-sm text-slate-700 hover:bg-slate-50"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {dates.length
          ? `${dates.length} date${dates.length === 1 ? "" : "s"} selected`
          : "Choose game dates"}
      </button>
      {open && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <button
              aria-label="Previous month"
              className="rounded-md px-3 py-1 text-slate-700 hover:bg-slate-100"
              onClick={() =>
                setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
              }
              type="button"
            >
              ‹
            </button>
            <p aria-live="polite" className="font-semibold text-slate-900">
              {monthLabel}
            </p>
            <button
              aria-label="Next month"
              className="rounded-md px-3 py-1 text-slate-700 hover:bg-slate-100"
              onClick={() =>
                setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
              }
              type="button"
            >
              ›
            </button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-slate-500">
            {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((weekday) => (
              <span className="py-2" key={weekday}>
                {weekday}
              </span>
            ))}
            {cells.map((day, index) => {
              if (!day) return <span aria-hidden="true" key={`empty-${index}`} />;
              const date = new Date(month.getFullYear(), month.getMonth(), day);
              const value = dateKey(date);
              const selected = dates.includes(value);
              const locked = selected && lockedDates.includes(value);
              return (
                <button
                  aria-label={`${displayDate(value)}${locked ? ", has game activity and cannot be removed" : ""}`}
                  aria-pressed={selected}
                  className={`rounded-lg py-2 text-sm transition ${
                    selected
                      ? "bg-teal-800 font-semibold text-white"
                      : "text-slate-700 hover:bg-teal-50"
                  } ${locked ? "cursor-not-allowed ring-2 ring-amber-400" : ""}`}
                  key={value}
                  onClick={() => toggleDate(value)}
                  title={locked ? "This date has game activity and cannot be removed." : undefined}
                  type="button"
                >
                  {day}
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {dates.map((date) => (
              <span
                className="rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-900"
                key={date}
              >
                {displayDate(date)}
                {lockedDates.includes(date) ? " · in use" : ""}
              </span>
            ))}
          </div>
          {lockedDates.some((date) => dates.includes(date)) && (
            <p className="mt-3 text-xs text-amber-800">
              Dates with commitments or substitute requests are retained.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function SeasonBuilder({
  initialValue,
}: {
  initialValue?: BuilderValue;
}) {
  const [value, setValue] = useState<BuilderValue>(
    () => initialValue ?? newBuilder(),
  );
  const [gamePriceInput, setGamePriceInput] = useState(
    () => ((initialValue ?? newBuilder()).gamePriceCents / 100).toFixed(2),
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [rulesPdfFile, setRulesPdfFile] = useState<File | null>(null);
  const [removeRulesPdf, setRemoveRulesPdf] = useState(false);
  const router = useRouter();

  function updateSession(index: number, patch: Partial<SessionDraft>) {
    setValue((current) => ({
      ...current,
      sessions: current.sessions.map((session, sessionIndex) =>
        sessionIndex === index ? { ...session, ...patch } : session,
      ),
    }));
  }

  function updatePlayer(
    sessionIndex: number,
    playerIndex: number,
    patch: Partial<PlayerDraft>,
  ) {
    const session = value.sessions[sessionIndex];
    updateSession(sessionIndex, {
      players: session.players.map((player, index) =>
        index === playerIndex ? { ...player, ...patch } : player,
      ),
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const scheduleSessions = value.sessions.map((session) => ({
      ...session,
      dates: getScheduleDates(session),
    }));
    const incompleteSession = value.sessions.findIndex(
      (session, index) => scheduleSessions[index].dates.length === 0,
    );
    if (incompleteSession >= 0) {
      setError(`Select at least one date for session ${incompleteSession + 1}.`);
      return;
    }
    const gamePriceCents = parsePriceCents(gamePriceInput);
    if (gamePriceCents === null) {
      setError("Enter a valid game price with up to two decimal places (maximum $1,000).");
      return;
    }
    if (
      rulesPdfFile &&
      (rulesPdfFile.size === 0 ||
        rulesPdfFile.size > 10 * 1024 * 1024 ||
        !rulesPdfFile.name.toLowerCase().endsWith(".pdf"))
    ) {
      setError("Choose a valid PDF file no larger than 10 MB.");
      return;
    }

    setSaving(true);
    try {
      let documentCleanupWarning: string | undefined;
      const response = await fetch("/api/admin/seasons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          season_id: value.seasonId,
          name: value.name,
          timeout_hours: value.timeoutHours,
          daytime_start_hour: value.daytimeStartHour,
          daytime_end_hour: value.daytimeEndHour,
          timezone: value.timezone,
          game_price_cents: gamePriceCents,
          global_claim_hours: value.globalClaimHours,
          gender_match_claim_hours: value.genderMatchClaimHours,
          claims_are_free: value.claimsAreFree,
          sessions: scheduleSessions.map((session) => ({
            id: session.id,
            name: session.name,
            start_time: session.startTime,
            weekday: session.weekday,
            schedule_name: session.scheduleName,
            first_week: session.firstWeek || null,
            last_week: session.lastWeek || null,
            dates: session.dates,
            players: session.players,
          })),
          extra_players: value.extraPlayers,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not publish the season.");
      }

      const seasonId = String(result.season_id);
      setValue((current) => ({ ...current, seasonId }));
      if (rulesPdfFile) {
        const storagePath = `${seasonId}/${crypto.randomUUID()}.pdf`;
        const supabase = createClient();
        const { error: uploadError } = await supabase.storage
          .from("season-docs")
          .upload(storagePath, rulesPdfFile, {
            contentType: "application/pdf",
            upsert: false,
          });
        if (uploadError) {
          throw new Error(`Could not upload the season PDF: ${uploadError.message}`);
        }
        try {
          const documentResponse = await fetch(
            `/api/admin/seasons/${seasonId}/document`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                storage_path: storagePath,
                file_name: rulesPdfFile.name,
              }),
            },
          );
          const documentResult = await documentResponse.json();
          if (!documentResponse.ok) {
            throw new Error(documentResult.error || "Could not save the season PDF.");
          }
          setValue((current) => ({
            ...current,
            rulesPdfUrl: documentResult.rules_pdf_url,
            rulesPdfName: documentResult.rules_pdf_name,
          }));
          setRulesPdfFile(null);
          setRemoveRulesPdf(false);
          documentCleanupWarning = documentResult.cleanup_warning;
        } catch (caught) {
          const { error: cleanupError } = await supabase.storage
            .from("season-docs")
            .remove([storagePath]);
          const reason =
            caught instanceof Error ? caught.message : "Could not save the season PDF.";
          throw new Error(
            cleanupError
              ? `${reason} The uploaded file could not be cleaned up: ${cleanupError.message}`
              : reason,
          );
        }
      } else if (removeRulesPdf && value.rulesPdfUrl) {
        const documentResponse = await fetch(
          `/api/admin/seasons/${seasonId}/document`,
          { method: "DELETE" },
        );
        const documentResult = await documentResponse.json();
        if (!documentResponse.ok) {
          throw new Error(documentResult.error || "Could not remove the season PDF.");
        }
        setValue((current) => ({
          ...current,
          rulesPdfUrl: null,
          rulesPdfName: null,
        }));
        setRemoveRulesPdf(false);
        documentCleanupWarning = documentResult.cleanup_warning;
      }

      if (documentCleanupWarning) {
        setError(documentCleanupWarning);
        return;
      }

      const retainedGames = Number(result.retained_games ?? 0);
      router.push(
        `/admin/seasons/${seasonId}${
          retainedGames ? `?retainedGames=${retainedGames}` : ""
        }`,
      );
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not publish the season.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-8" onSubmit={submit}>
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-teal-700">
          Season builder
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          {value.seasonId ? "Edit season" : "Build a new season"}
        </h1>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <label className="block text-sm font-medium text-slate-800" htmlFor="season-name">
          Season name
        </label>
        <input
          autoComplete="off"
          className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
          id="season-name"
          maxLength={120}
          onChange={(event) =>
            setValue((current) => ({ ...current, name: event.target.value }))
          }
          placeholder="Bend Winter Indoor 26/27"
          required
          value={value.name}
        />
      </section>

      <div className="space-y-5">
        {value.sessions.map((session, sessionIndex) => (
          <section
            className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
            key={session.id ?? sessionIndex}
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                Session {sessionIndex + 1}
              </h2>
              {value.sessions.length > 1 && (
                <button
                  className="text-sm font-medium text-red-700 hover:underline"
                  onClick={() =>
                    setValue((current) => ({
                      ...current,
                      sessions: current.sessions.filter(
                        (_, index) => index !== sessionIndex,
                      ),
                    }))
                  }
                  type="button"
                >
                  Remove session
                </button>
              )}
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-800" htmlFor={`schedule-name-${sessionIndex}`}>
                  Schedule name
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3"
                  id={`schedule-name-${sessionIndex}`}
                  maxLength={120}
                  onChange={(event) =>
                    updateSession(sessionIndex, { scheduleName: event.target.value })
                  }
                  placeholder="Main 2026 Schedule"
                  required
                  value={session.scheduleName}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-800" htmlFor={`session-weekday-${sessionIndex}`}>
                  Day of week
                </label>
                <select
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3"
                  id={`session-weekday-${sessionIndex}`}
                  onChange={(event) =>
                    updateSession(sessionIndex, { weekday: Number(event.target.value) })
                  }
                  value={session.weekday}
                >
                  {["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((day, weekday) => (
                    <option key={day} value={weekday}>{day}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-800" htmlFor={`schedule-first-${sessionIndex}`}>
                  First week
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3"
                  id={`schedule-first-${sessionIndex}`}
                  onChange={(event) =>
                    updateSession(sessionIndex, { firstWeek: event.target.value })
                  }
                  type="date"
                  value={session.firstWeek}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-800" htmlFor={`schedule-last-${sessionIndex}`}>
                  Last week
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3"
                  id={`schedule-last-${sessionIndex}`}
                  onChange={(event) =>
                    updateSession(sessionIndex, { lastWeek: event.target.value })
                  }
                  type="date"
                  value={session.lastWeek}
                />
              </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label
                  className="block text-sm font-medium text-slate-800"
                  htmlFor={`session-name-${sessionIndex}`}
                >
                  Session name
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                  id={`session-name-${sessionIndex}`}
                  maxLength={120}
                  onChange={(event) =>
                    updateSession(sessionIndex, { name: event.target.value })
                  }
                  placeholder="S1 Tuesday nights"
                  required
                  value={session.name}
                />
              </div>
              <div>
                <label
                  className="block text-sm font-medium text-slate-800"
                  htmlFor={`session-time-${sessionIndex}`}
                >
                  Game start time
                </label>
                <input
                  className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-100"
                  id={`session-time-${sessionIndex}`}
                  onChange={(event) =>
                    updateSession(sessionIndex, { startTime: event.target.value })
                  }
                  required
                  type="time"
                  value={session.startTime}
                />
              </div>
            </div>

            <DatePicker
              dates={session.dates}
              lockedDates={session.lockedDates}
              onChange={(dates) => updateSession(sessionIndex, { dates })}
            />

            <div className="space-y-3">
              <h3 className="text-sm font-semibold text-slate-800">Regular players</h3>
              {session.players.map((player, playerIndex) => (
                <div
                  className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_100px_auto]"
                  key={`${sessionIndex}-${playerIndex}`}
                >
                  <label className="sr-only" htmlFor={`player-name-${sessionIndex}-${playerIndex}`}>
                    Player name
                  </label>
                  <input
                    autoComplete="name"
                    className="min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                    id={`player-name-${sessionIndex}-${playerIndex}`}
                    maxLength={120}
                    onChange={(event) =>
                      updatePlayer(sessionIndex, playerIndex, {
                        name: event.target.value,
                      })
                    }
                    placeholder="Player Name"
                    required
                    value={player.name}
                  />
                  <label className="sr-only" htmlFor={`player-email-${sessionIndex}-${playerIndex}`}>
                    Player email
                  </label>
                  <input
                    autoComplete="email"
                    className="min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                    id={`player-email-${sessionIndex}-${playerIndex}`}
                    onChange={(event) =>
                      updatePlayer(sessionIndex, playerIndex, {
                        email: event.target.value,
                      })
                    }
                    placeholder="Player Email"
                    required
                    type="email"
                    value={player.email}
                  />
                  <label className="sr-only" htmlFor={`player-gender-${sessionIndex}-${playerIndex}`}>
                    Player gender
                  </label>
                  <select
                    className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-semibold"
                    id={`player-gender-${sessionIndex}-${playerIndex}`}
                    onChange={(event) =>
                      updatePlayer(sessionIndex, playerIndex, {
                        gender: event.target.value as "FMP" | "MMP",
                      })
                    }
                    value={player.gender}
                  >
                    <option value="FMP">FMP</option>
                    <option value="MMP">MMP</option>
                  </select>
                  <button
                    aria-label={`Remove ${player.name || "player"}`}
                    className="rounded-md px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                    onClick={() =>
                      updateSession(sessionIndex, {
                        players: session.players.filter(
                          (_, index) => index !== playerIndex,
                        ),
                      })
                    }
                    type="button"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <div className="flex flex-wrap gap-4">
                <button
                  className="text-sm font-semibold text-teal-800 hover:underline"
                  onClick={() =>
                    updateSession(sessionIndex, {
                      players: [...session.players, blankPlayer("FMP")],
                    })
                  }
                  type="button"
                >
                  + Add FMP
                </button>
                <button
                  className="text-sm font-semibold text-teal-800 hover:underline"
                  onClick={() =>
                    updateSession(sessionIndex, {
                      players: [...session.players, blankPlayer("MMP")],
                    })
                  }
                  type="button"
                >
                  + Add MMP
                </button>
              </div>
            </div>
          </section>
        ))}
        <button
          className="rounded-lg border border-dashed border-teal-700 px-4 py-3 text-sm font-semibold text-teal-800 hover:bg-teal-50"
          onClick={() =>
            setValue((current) => ({
              ...current,
              sessions: [...current.sessions, blankSession()],
            }))
          }
          type="button"
        >
          + Add another schedule / session
        </button>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="text-lg font-semibold text-slate-900">Additional season invitees</h2>
        <p className="mt-1 text-sm text-slate-600">
          These players join the season pool without being assigned as session regulars.
        </p>
        <div className="mt-4 space-y-3">
          {value.extraPlayers.map((player, index) => (
            <div
              className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_1fr_100px_auto]"
              key={index}
            >
              <label className="sr-only" htmlFor={`extra-name-${index}`}>Player name</label>
              <input
                autoComplete="name"
                className="min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                id={`extra-name-${index}`}
                maxLength={120}
                onChange={(event) =>
                  setValue((current) => ({
                    ...current,
                    extraPlayers: current.extraPlayers.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, name: event.target.value } : item,
                    ),
                  }))
                }
                placeholder="Player Name"
                required
                value={player.name}
              />
              <label className="sr-only" htmlFor={`extra-email-${index}`}>Player email</label>
              <input
                autoComplete="email"
                className="min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                id={`extra-email-${index}`}
                onChange={(event) =>
                  setValue((current) => ({
                    ...current,
                    extraPlayers: current.extraPlayers.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, email: event.target.value } : item,
                    ),
                  }))
                }
                placeholder="Player Email"
                required
                type="email"
                value={player.email}
              />
              <label className="sr-only" htmlFor={`extra-gender-${index}`}>Player gender</label>
              <select
                className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-semibold"
                id={`extra-gender-${index}`}
                onChange={(event) =>
                  setValue((current) => ({
                    ...current,
                    extraPlayers: current.extraPlayers.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, gender: event.target.value as "FMP" | "MMP" }
                        : item,
                    ),
                  }))
                }
                value={player.gender}
              >
                <option value="FMP">FMP</option>
                <option value="MMP">MMP</option>
              </select>
              <button
                aria-label={`Remove ${player.name || "invitee"}`}
                className="rounded-md px-3 py-2 text-sm text-red-700 hover:bg-red-50"
                onClick={() =>
                  setValue((current) => ({
                    ...current,
                    extraPlayers: current.extraPlayers.filter(
                      (_, itemIndex) => itemIndex !== index,
                    ),
                  }))
                }
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            className="text-sm font-semibold text-teal-800 hover:underline"
            onClick={() =>
              setValue((current) => ({
                ...current,
                extraPlayers: [...current.extraPlayers, blankPlayer()],
              }))
            }
            type="button"
          >
            + Add another season invitee
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <h2 className="text-lg font-semibold text-slate-900">
          Season Overview &amp; Rules (PDF)
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Upload an optional PDF with season details, game rules, or etiquette. Maximum size: 10 MB.
        </p>
        {rulesPdfFile ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-slate-800">{rulesPdfFile.name}</span>
            <button
              className="text-red-700 hover:underline"
              onClick={() => setRulesPdfFile(null)}
              type="button"
            >
              Clear selection
            </button>
          </div>
        ) : value.rulesPdfUrl && !removeRulesPdf ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <a
              className="font-medium text-teal-800 underline"
              href={value.rulesPdfUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {value.rulesPdfName || "View current season PDF"}
            </a>
            <button
              className="text-red-700 hover:underline"
              onClick={() => setRemoveRulesPdf(true)}
              type="button"
            >
              Remove PDF
            </button>
          </div>
        ) : removeRulesPdf ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="text-amber-800">The current PDF will be removed when you save.</span>
            <button
              className="text-teal-800 hover:underline"
              onClick={() => setRemoveRulesPdf(false)}
              type="button"
            >
              Undo
            </button>
          </div>
        ) : null}
        <label className="mt-4 block text-sm font-medium text-slate-800" htmlFor="season-rules-pdf">
          {value.rulesPdfUrl && !removeRulesPdf ? "Replace PDF" : "Choose PDF"}
        </label>
        <input
          accept=".pdf,application/pdf"
          className="mt-2 block w-full text-sm text-slate-700 file:mr-4 file:rounded-lg file:border-0 file:bg-teal-50 file:px-4 file:py-2 file:font-semibold file:text-teal-800 hover:file:bg-teal-100"
          id="season-rules-pdf"
          onChange={(event) => {
            setRulesPdfFile(event.target.files?.[0] ?? null);
            setRemoveRulesPdf(false);
          }}
          type="file"
        />
      </section>

      <details className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <summary className="cursor-pointer font-semibold text-slate-900">
          Advanced Settings
        </summary>
        <div className="mt-5 grid gap-5 sm:grid-cols-3">
          <div>
            <label className="block text-sm font-medium text-slate-800" htmlFor="game-price">
              Game Price ($)
            </label>
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              id="game-price"
              inputMode="decimal"
              onChange={(event) => setGamePriceInput(event.target.value)}
              required
              type="text"
              value={gamePriceInput}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-800" htmlFor="global-claim-hours">
              Global Claim Window (hours before game start)
            </label>
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              id="global-claim-hours"
              max="168"
              min="0.25"
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  globalClaimHours: Number(event.target.value),
                }))
              }
              required
              step="0.25"
              type="number"
              value={value.globalClaimHours}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-800" htmlFor="gender-claim-hours">
              Gender Match Claim Window (hours before Global Claim Window)
            </label>
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              id="gender-claim-hours"
              max="168"
              min="0"
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  genderMatchClaimHours: Number(event.target.value),
                }))
              }
              required
              step="0.25"
              type="number"
              value={value.genderMatchClaimHours}
            />
          </div>
          <label className="flex items-start gap-3 text-sm text-slate-800 sm:col-span-3">
            <input
              checked={value.claimsAreFree}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-teal-700"
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  claimsAreFree: event.target.checked,
                }))
              }
              type="checkbox"
            />
            <span>
              <span className="block font-medium">Claims are free</span>
              <span className="text-slate-600">
                Claimed spots carry no financial credit or debt when enabled.
              </span>
            </span>
          </label>
          <div>
            <label className="block text-sm font-medium text-slate-800" htmlFor="timeout-hours">
              Response timeout (hours)
            </label>
            <input
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              id="timeout-hours"
              max={168}
              min={1}
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  timeoutHours: Number(event.target.value),
                }))
              }
              required
              type="number"
              value={value.timeoutHours}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-800" htmlFor="daytime-start">
              Daytime window starts
            </label>
            <select
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              id="daytime-start"
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  daytimeStartHour: Number(event.target.value),
                }))
              }
              value={value.daytimeStartHour}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {new Intl.DateTimeFormat("en", {
                    hour: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(Date.UTC(2020, 0, 1, hour)))}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-800" htmlFor="daytime-end">
              Daytime window ends
            </label>
            <select
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              id="daytime-end"
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  daytimeEndHour: Number(event.target.value),
                }))
              }
              value={value.daytimeEndHour}
            >
              {Array.from({ length: 24 }, (_, hour) => (
                <option key={hour} value={hour}>
                  {new Intl.DateTimeFormat("en", {
                    hour: "numeric",
                    timeZone: "UTC",
                  }).format(new Date(Date.UTC(2020, 0, 1, hour)))}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-3">
            <label className="block text-sm font-medium text-slate-800" htmlFor="season-timezone">
              League Timezone
            </label>
            <select
              className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
              id="season-timezone"
              onChange={(event) =>
                setValue((current) => ({
                  ...current,
                  timezone: event.target.value,
                }))
              }
              value={value.timezone}
            >
              {!leagueTimezones.some(([timezone]) => timezone === value.timezone) && (
                <option value={value.timezone}>{value.timezone}</option>
              )}
              {leagueTimezones.map(([timezone, label]) => (
                <option key={timezone} value={timezone}>
                  {label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Game dates and start times are shown in this timezone.
            </p>
          </div>
          {value.daytimeStartHour >= value.daytimeEndHour && (
            <p className="text-sm text-red-700 sm:col-span-3">
              The daytime window end must be later than its start.
            </p>
          )}
        </div>
      </details>

      {error && (
        <p aria-live="polite" className="rounded-lg bg-red-50 p-4 text-sm text-red-800">
          {error}
        </p>
      )}
      <button
        className="w-full rounded-lg bg-teal-800 px-5 py-3.5 font-semibold text-white hover:bg-teal-900 disabled:cursor-wait disabled:opacity-60 sm:w-auto"
        disabled={saving}
        type="submit"
      >
        {saving ? "Publishing..." : value.seasonId ? "Save Changes" : "Publish Season"}
      </button>
    </form>
  );
}
