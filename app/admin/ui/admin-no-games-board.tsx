"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { wallClockToDate } from "@/lib/timezone-format";

type Session = {
  id: string;
  name: string;
  startTime: string;
  games: Array<{
    id: string;
    game_date: string;
    start_time: string;
    cancelled_at: string | null;
  }>;
};

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(date: Date) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() - result.getUTCDay());
  return result;
}

function formatCardDate(value: string) {
  const date = parseDate(value);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date).replace(" ", "");
}

export function AdminNoGamesBoard({
  seasonId,
  seasonName,
  timezone,
  sessions,
}: {
  seasonId: string;
  seasonName: string;
  timezone: string;
  sessions: Session[];
}) {
  const [draftSessions, setDraftSessions] = useState(sessions);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrolled = useRef(false);

  const range = useMemo(() => {
    const dates = draftSessions.flatMap((session) =>
      session.games.map((game) => game.game_date),
    );
    if (!dates.length) return null;
    const sorted = [...dates].sort();
    return {
      first: parseDate(sorted[0]),
      last: parseDate(sorted[sorted.length - 1]),
    };
  }, [draftSessions]);

  const dayColumns = useMemo(
    () =>
      [...new Set(
        draftSessions.flatMap((session) =>
          session.games.map((game) => parseDate(game.game_date).getUTCDay()),
        ),
      )].sort((left, right) => left - right),
    [draftSessions],
  );

  const weeks = useMemo(() => {
    if (!range) return [];
    const result: Date[] = [];
    const cursor = startOfWeek(range.first);
    const end = startOfWeek(range.last);
    while (cursor <= end) {
      result.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return result;
  }, [range]);

  useEffect(() => {
    if (autoScrolled.current) return;
    const nextWeek = weeks.find((week) =>
      dayColumns.some((weekday) => {
        const date = new Date(week);
        date.setUTCDate(date.getUTCDate() + weekday);
        const value = dateKey(date);
        return draftSessions.some((session) =>
          session.games.some((game) => game.game_date === value),
        );
      }),
    );
    if (!nextWeek) return;
    autoScrolled.current = true;
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-week="${dateKey(nextWeek)}"]`,
    );
    if (!row || !scrollRef.current) return;
    window.requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({
        top: Math.max(0, row.offsetTop - 48),
        behavior: "smooth",
      });
    });
  }, [dayColumns, draftSessions, weeks]);

  async function toggleGame(
    session: Session,
    date: string,
    existingGame: Session["games"][number] | undefined,
  ) {
    const key = `${session.id}:${date}`;
    setBusyKey(key);
    setError("");
    try {
      let response: Response;
      if (existingGame) {
        response = await fetch(`/api/admin/games/${existingGame.id}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cancelled: !existingGame.cancelled_at }),
        });
      } else {
        response = await fetch(`/api/admin/seasons/${seasonId}/games`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: session.id, game_date: date }),
        });
      }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update the game.");

      setDraftSessions((current) =>
        current.map((item) => {
          if (item.id !== session.id) return item;
          if (existingGame) {
            return {
              ...item,
              games: item.games.map((game) =>
                game.id === existingGame.id
                  ? {
                      ...game,
                      cancelled_at: existingGame.cancelled_at
                        ? null
                        : new Date().toISOString(),
                    }
                  : game,
              ),
            };
          }
          return {
            ...item,
            games: [
              ...item.games,
              {
                id: String(result.game_id),
                game_date: date,
                start_time: session.startTime,
                cancelled_at: null,
              },
            ].sort((left, right) => left.game_date.localeCompare(right.game_date)),
          };
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the game.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="mt-5 flex h-[calc(100dvh-11rem)] min-h-[32rem] flex-col">
      <div className="shrink-0">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-teal-700">
          Add No-Games
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          {seasonName}
        </h1>
      </div>
      {error && (
        <p className="mt-3 shrink-0 rounded-lg bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      <div
        className="mt-4 min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white"
        ref={scrollRef}
      >
        {weeks.length === 0 ? (
          <p className="p-6 text-slate-600">No game dates have been added to this season.</p>
        ) : (
          <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0">
            <thead>
              <tr>
                {dayColumns.map((weekday) => (
                  <th
                    className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 p-3 text-center text-sm font-semibold text-slate-700"
                    key={weekday}
                  >
                    {weekdayNames[weekday]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeks.map((week) => (
                <tr data-week={dateKey(week)} key={dateKey(week)}>
                  {dayColumns.map((weekday) => {
                    const date = new Date(week);
                    date.setUTCDate(date.getUTCDate() + weekday);
                    const value = dateKey(date);
                    const matching = draftSessions
                      .flatMap((session) =>
                        session.games
                          .filter((game) => game.game_date === value)
                          .map((game) => ({ session, game })),
                      );
                    const first = matching[0];
                    const session =
                      first?.session ??
                      draftSessions.find((candidate) =>
                        candidate.games.some(
                          (game) =>
                            parseDate(game.game_date).getUTCDay() === weekday,
                        ),
                      );
                    const existingGame = first?.game;
                    if (!session) return <td className="border-b border-slate-100 p-2" key={weekday} />;
                    const isNoGame = !existingGame || Boolean(existingGame.cancelled_at);
                    const startsAt = wallClockToDate(
                      value,
                      session.startTime,
                      timezone,
                    ).getTime();
                    const future = startsAt >= Date.now();
                    const key = `${session.id}:${value}`;
                    return (
                      <td className="border-b border-slate-100 p-2 align-top" key={weekday}>
                        <button
                          className={
                            isNoGame
                              ? "flex h-32 w-full items-center justify-center rounded-lg border border-slate-300 bg-slate-200 text-sm font-bold text-slate-700 hover:bg-slate-300"
                              : `h-32 w-full rounded-lg border p-2 text-left ${future ? "border-blue-400 bg-blue-200 text-blue-950" : "border-blue-300 bg-blue-100 text-blue-950"}`
                          }
                          disabled={busyKey === key}
                          onClick={() => toggleGame(session, value, existingGame)}
                          type="button"
                        >
                          {isNoGame ? (
                            "No game"
                          ) : (
                            <span className="flex h-full flex-col">
                              <span className="grid grid-cols-3 text-xs font-semibold">
                                <span>{formatCardDate(value)}</span>
                                <span className="text-center">{weekdayNames[weekday]}</span>
                                <span className="text-right">
                                  {new Intl.DateTimeFormat("en", {
                                    hour: "numeric",
                                    minute: "2-digit",
                                    timeZoneName: "short",
                                    timeZone: timezone,
                                  }).format(new Date(startsAt))}
                                </span>
                              </span>
                              <span className="flex flex-1 items-center justify-center text-base font-bold">
                                GAME
                              </span>
                            </span>
                          )}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
