"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { NotificationsButton } from "./notifications-button";
import { SignOutButton } from "./sign-out-button";
import { useRouter } from "next/navigation";
import {
  formatLeagueDate,
  wallClockToDate,
} from "@/lib/timezone-format";
import {
  calculateSeasonNetBalance,
  type SeasonLedgerRecord,
  type SeasonSettlementPayment,
} from "@/lib/season-settlements";

type Game = {
  id: string;
  gameDate: string;
  startTime: string;
  sessionId: string;
  status: "playing" | "available" | "unavailable";
  cancelled: boolean;
  fmpSlotsToFill: number;
  mmpSlotsToFill: number;
  timezone: string;
};

type Session = { id: string; name: string; startTime: string };
type Season = {
  id: string;
  name: string;
  rulesPdfUrl: string | null;
  rulesPdfName: string | null;
  timezone: string;
  gamePriceCents: number;
  globalClaimHours: number;
  genderMatchClaimHours: number;
  claimsAreFree: boolean;
  playerGender: "FMP" | "MMP" | null;
  ledgerEntries: SeasonLedgerRecord[];
  settlementPayments: SeasonSettlementPayment[];
  finalGameStartsAt: number | null;
  sessions: Session[];
  games: Game[];
};
type PendingPing = {
  id: string;
  gameId: string;
  gameDate: string;
  startTime: string;
  seasonName: string;
  expiresAt: string;
  timezone: string;
  globalClaimHours: number;
  genderMatchClaimHours: number;
};

type Week = {
  key: string;
  gamesByDay: Map<number, Game[]>;
};

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function startOfWeek(date: Date) {
  const result = new Date(date);
  const weekday = result.getUTCDay();
  result.setUTCDate(result.getUTCDate() - weekday);
  return result;
}

function weekKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function buildWeeks(season: Season): Week[] {
  const weeks = new Map<string, Week>();
  const sessionIds = new Set(season.sessions.map((session) => session.id));
  const rangedGames = season.games.filter(
    (game) => sessionIds.has(game.sessionId) && !game.cancelled,
  );
  for (const game of rangedGames) {
    const start = startOfWeek(parseDate(game.gameDate));
    const key = weekKey(start);
    let week = weeks.get(key);
    if (!week) {
      week = { key, gamesByDay: new Map() };
      weeks.set(key, week);
    }
    const weekday = parseDate(game.gameDate).getUTCDay();
    week.gamesByDay.set(weekday, [
      ...(week.gamesByDay.get(weekday) ?? []),
      game,
    ]);
  }
  for (const week of weeks.values()) {
    for (const games of week.gamesByDay.values()) {
      games.sort(
        (left, right) =>
          left.gameDate.localeCompare(right.gameDate) ||
          left.startTime.localeCompare(right.startTime),
      );
    }
  }
  if (!rangedGames.length) return [];
  const sortedDates = rangedGames.map((game) => parseDate(game.gameDate).getTime()).sort((left, right) => left - right);
  const first = startOfWeek(new Date(sortedDates[0]));
  const last = startOfWeek(new Date(sortedDates[sortedDates.length - 1]));
  const complete: Week[] = [];
  for (let cursor = first; cursor <= last; cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000)) {
    const key = weekKey(cursor);
    complete.push(weeks.get(key) ?? { key, gamesByDay: new Map() });
  }
  return complete;
}

const cardColors = {
  playing: {
    past: "border-green-300 bg-green-100 text-green-950",
    future: "border-green-400 bg-green-200 text-green-950",
  },
  available: {
    past: "border-yellow-300 bg-yellow-100 text-yellow-950",
    future: "border-yellow-400 bg-yellow-200 text-yellow-950",
  },
  unavailable: {
    past: "border-red-300 bg-red-100 text-red-950",
    future: "border-red-400 bg-red-200 text-red-950",
  },
} as const;

function formatCardTime(game: Game) {
  const date = wallClockToDate(game.gameDate, game.startTime, game.timezone);
  const parts = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: game.timezone,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const period = parts.find((part) => part.type === "dayPeriod")?.value;
  if (!hour || !period) return "";
  return `${hour}${minute && minute !== "00" ? `:${minute}` : ""}${period.toLowerCase()}`;
}

function formatCompactCardDate(value: string) {
  const [, month, day] = value.split("-");
  return `${month}/${day}`;
}

function formatPingRespondBy(ping: PendingPing) {
  const responseAt = new Date(new Date(ping.expiresAt).getTime() - 60_000);
  const parts = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: ping.timezone,
  }).formatToParts(responseAt);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const period = parts.find((part) => part.type === "dayPeriod")?.value;
  return `Respond by ${hour}:${minute ?? "00"}${period?.toUpperCase() ?? ""}`;
}

function formatPingGameTime(ping: PendingPing) {
  const date = wallClockToDate(ping.gameDate, ping.startTime, ping.timezone);
  const parts = new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
    timeZone: ping.timezone,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const period = parts.find((part) => part.type === "dayPeriod")?.value;
  return `${hour}${minute && minute !== "00" ? `:${minute}` : ""}${period?.toLowerCase() ?? ""}`;
}

function formatMoney(amountCents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amountCents / 100);
}

export function CalendarDashboard({
  seasons: initialSeasons,
  pendingPings: initialPendingPings,
  serverNow,
  userId,
  fullName,
  isAdmin,
  deepLinkGameId,
}: {
  seasons: Season[];
  pendingPings: PendingPing[];
  serverNow: string;
  userId: string;
  fullName: string;
  isAdmin: boolean;
  deepLinkGameId: string | null;
}) {
  const router = useRouter();
  const [seasons, setSeasons] = useState(initialSeasons);
  const [pendingPings, setPendingPings] = useState(initialPendingPings);
  const [syncedSeasons, setSyncedSeasons] = useState(initialSeasons);
  const [syncedPendingPings, setSyncedPendingPings] =
    useState(initialPendingPings);
  const [now, setNow] = useState(() => new Date(serverNow).getTime());
  const [confirmGame, setConfirmGame] = useState<{
    seasonId: string;
    game: Game;
  } | null>(null);
  const [claimGame, setClaimGame] = useState<{
    seasonId: string;
    game: Game;
  } | null>(null);
  const [expandedSettlementSeasonIds, setExpandedSettlementSeasonIds] =
    useState<string[]>([]);
  const [confirmSettlementSeasonId, setConfirmSettlementSeasonId] =
    useState<string | null>(null);
  const [busySettlementSeasonId, setBusySettlementSeasonId] =
    useState<string | null>(null);
  const [busyGameId, setBusyGameId] = useState<string | null>(null);
  const [pingModal, setPingModal] = useState<PendingPing | null>(null);
  const [, setError] = useState("");
  const [, setMessage] = useState("");
  const calendarScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollAttempted = useRef(false);
  const gearRef = useRef<HTMLDivElement>(null);
  const [gearOpen, setGearOpen] = useState(false);
  const [highlightedGameId, setHighlightedGameId] = useState<string | null>(null);

  if (initialSeasons !== syncedSeasons) {
    setSyncedSeasons(initialSeasons);
    setSeasons(initialSeasons);
  }
  if (initialPendingPings !== syncedPendingPings) {
    setSyncedPendingPings(initialPendingPings);
    setPendingPings(initialPendingPings);
  }

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "sub-request-response") {
        setMessage(
          event.data.ok
            ? "Your response was recorded."
            : event.data.result?.error || "Could not respond to the sub request.",
        );
        setPendingPings([]);
        router.refresh();
      }
    };
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", handleMessage);
  }, [router]);

  const weekGroups = useMemo(
    () => new Map(seasons.map((season) => [season.id, buildWeeks(season)])),
    [seasons],
  );
  const dayColumns = useMemo(
    () => [...new Set(seasons.flatMap((season) => {
      const sessionIds = new Set(season.sessions.map((session) => session.id));
      return season.games
        .filter((game) => sessionIds.has(game.sessionId) && !game.cancelled)
        .map((game) => parseDate(game.gameDate).getUTCDay());
    }))].sort((left, right) => left - right),
    [seasons],
  );
  const nextGameId = useMemo(() => {
    const upcomingGames = seasons.flatMap((season) =>
      season.games
        .filter((game) => !game.cancelled)
        .map((game) => ({
          seasonId: season.id,
          game,
          startsAt: wallClockToDate(
            game.gameDate,
            game.startTime,
            game.timezone,
          ).getTime(),
        }))
        .filter((item) => item.startsAt >= now),
    );
    upcomingGames.sort((left, right) => left.startsAt - right.startsAt);
    const first = upcomingGames[0];
    return first ? `${first.seasonId}:${first.game.id}` : null;
  }, [now, seasons]);
  const activePings = pendingPings.filter((ping) =>
    new Date(ping.expiresAt).getTime() > now,
  );
  const scrollAndHighlightGame = useCallback((gameId: string) => {
    const target = calendarScrollRef.current?.querySelector<HTMLElement>(
      `[data-game-id="${CSS.escape(gameId)}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    setHighlightedGameId(gameId);
    window.setTimeout(() => setHighlightedGameId((current) => current === gameId ? null : current), 2200);
  }, []);

  useEffect(() => {
    if (!deepLinkGameId) return;
    const timer = window.setTimeout(() => scrollAndHighlightGame(deepLinkGameId), 300);
    return () => window.clearTimeout(timer);
  }, [deepLinkGameId, seasons, scrollAndHighlightGame]);

  const claimSeason = claimGame
    ? seasons.find((season) => season.id === claimGame.seasonId)
    : null;
  const claimStartsAt = claimGame
    ? wallClockToDate(
        claimGame.game.gameDate,
        claimGame.game.startTime,
        claimGame.game.timezone,
      ).getTime()
    : 0;
  const claimWindowOpen =
    Boolean(claimGame && claimSeason) &&
    now >=
      claimStartsAt -
        ((claimSeason?.globalClaimHours ?? 0) +
          (claimSeason?.genderMatchClaimHours ?? 0)) *
          60 *
          60 *
          1000 &&
    now < claimStartsAt;

  useEffect(() => {
    if (!gearOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!gearRef.current?.contains(event.target as Node)) setGearOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setGearOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [gearOpen]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [router]);
  useEffect(() => {
    if (autoScrollAttempted.current) return;
    const scrollArea = calendarScrollRef.current;
    const target = scrollArea?.querySelector<HTMLElement>(
      '[data-next-game="true"]',
    );
    if (!scrollArea || !target) return;

    autoScrollAttempted.current = true;
    window.requestAnimationFrame(() => {
      const top =
        target.getBoundingClientRect().top -
        scrollArea.getBoundingClientRect().top +
        scrollArea.scrollTop -
        48;
      scrollArea.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
  }, [nextGameId, seasons]);

  function applyGameResult(
    seasonId: string,
    gameId: string,
    status: Game["status"],
  ) {
    setSeasons((current) =>
      current.map((season) =>
        season.id !== seasonId
          ? season
          : {
              ...season,
              games: season.games.map((game) =>
                game.id === gameId
                  ? { ...game, status }
                  : game,
              ),
            },
      ),
    );
  }

  async function changeCommitment(seasonId: string, game: Game) {
    setBusyGameId(game.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/calendar/games/${game.id}`, {
        method: "POST",
        headers: {
          "x-player-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update this game.");

      applyGameResult(
        seasonId,
        game.id,
        result.status,
      );
      if (result.sub_request_id) {
        if (result.queue_event?.event === "paused") {
          setMessage(
            "No eligible subs are available right now. Your request is paused and will resume when someone becomes available.",
          );
        } else if (result.queue_event?.event === "exhausted") {
          setMessage("No eligible subs were found. The season admin has been notified.");
        } else if (result.queueError) {
          setMessage(result.queueError);
        } else {
          const pingDelivery = result.notifications?.find(
            (delivery: { event: string }) => delivery.event === "ping",
          );
          if (pingDelivery?.error) {
            setMessage(`Your request is open, but the sub could not be notified: ${pingDelivery.error}`);
          } else if (pingDelivery?.pushSent) {
            setMessage(
              `Your sub request is open. ${pingDelivery.pushSent} push notification${pingDelivery.pushSent === 1 ? "" : "s"} sent.`,
            );
          } else {
            setMessage("Your sub request is open. The in-app ping is waiting for the selected player.");
          }
        }
      } else if (result.reactivated_request_id) {
        if (result.queueError) {
          setMessage(result.queueError);
        } else {
          const pingDelivery = result.notifications?.find(
            (delivery: { event: string }) => delivery.event === "ping",
          );
          setMessage(
            pingDelivery?.error
              ? `You are available, but a sub could not be notified: ${pingDelivery.error}`
              : "You are available for this game. The sub queue has resumed.",
          );
        }
      } else if (result.status === "available") {
        setMessage("You are available for this game.");
      } else if (result.status === "unavailable") {
        setMessage("You are unavailable for this game.");
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not update this game.",
      );
    } finally {
      setBusyGameId(null);
      setConfirmGame(null);
    }
  }

  async function respondToPing(requestId: string, action: "accept" | "pass") {
    setError("");
    setMessage("");
    const ping = pendingPings.find((item) => item.id === requestId);
    if (ping) setBusyGameId(ping.gameId);
    try {
      const response = await fetch(
        `/api/sub-requests/${requestId}/respond`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not respond to the ping.");
      setPendingPings((current) =>
        current.filter((ping) => ping.id !== requestId),
      );
      setPingModal(null);
      const notificationFailure = result.notificationError ||
        result.notifications?.find(
          (item: { error?: string }) => item.error,
        )?.error;
      setMessage(
        result.result === "claim_phase"
          ? "The claim window has opened. This ping is no longer active."
          : result.result === "expired"
          ? "This ping expired before your response. The queue moved on."
          : action === "accept"
            ? `You accepted the game. Your calendar is updated.${
                notificationFailure
                  ? ` The requester could not be notified: ${notificationFailure}`
                  : ""
              }`
            : `You passed on the game.${
                notificationFailure
                  ? ` The next player could not be notified: ${notificationFailure}`
                  : ""
              }`,
      );
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not respond to the ping.",
      );
    } finally {
      setBusyGameId(null);
    }
  }

  async function claimSpot(seasonId: string, game: Game) {
    setBusyGameId(game.id);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/calendar/games/${game.id}/claim`,
        { method: "POST" },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not claim this spot.");
      }

      setSeasons((current) =>
        current.map((season) =>
          season.id !== seasonId
            ? season
            : {
                ...season,
                games: season.games.map((item) =>
                  item.id !== game.id
                    ? item
                    : {
                        ...item,
                        status: "playing",
                        fmpSlotsToFill: Math.max(
                          0,
                          item.fmpSlotsToFill -
                            (result.needed_gender === "FMP" ? 1 : 0),
                        ),
                        mmpSlotsToFill: Math.max(
                          0,
                          item.mmpSlotsToFill -
                            (result.needed_gender === "MMP" ? 1 : 0),
                        ),
                      },
                ),
              },
        ),
      );
      setMessage(
        result.claims_are_free
          ? "You claimed the spot. Your calendar is updated."
          : `You claimed the spot and are committing to pay $${(
              result.game_price_cents / 100
            ).toFixed(2)}.`,
      );
      setPendingPings((current) =>
        current.filter((ping) => ping.gameId !== game.id),
      );
      setClaimGame(null);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not claim this spot.");
    } finally {
      setBusyGameId(null);
    }
  }

  async function confirmSeasonPayments(seasonId: string) {
    setBusySettlementSeasonId(seasonId);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/seasons/${seasonId}/settlements/confirm`,
        { method: "POST" },
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not confirm your payments.");
      }

      const paidAt = new Date().toISOString();
      setSeasons((current) =>
        current.map((season) =>
          season.id !== seasonId
            ? season
            : {
                ...season,
                settlementPayments: season.settlementPayments.map((payment) =>
                  payment.debtorId === userId
                    ? { ...payment, isPaid: true, paidAt }
                    : payment,
                ),
              },
        ),
      );
      setConfirmSettlementSeasonId(null);
      setMessage("Your payments are marked as sent. Creditors can now see the update.");
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not confirm your payments.",
      );
    } finally {
      setBusySettlementSeasonId(null);
    }
  }

  function renderPostSeasonCards(season: Season) {
    const netBalance = calculateSeasonNetBalance(userId, season.ledgerEntries);
    const completedTransactions = season.ledgerEntries.length > 0;
    const payments = season.settlementPayments;
    const outgoingPayments = payments.filter(
      (payment) => payment.debtorId === userId,
    );
    const incomingPayments = payments.filter(
      (payment) => payment.creditorId === userId,
    );
    const allOutgoingPaid = outgoingPayments.every((payment) => payment.isPaid);
    const allIncomingPaid = incomingPayments.every((payment) => payment.isPaid);
    const finalGameStarted =
      season.finalGameStartsAt !== null && now >= season.finalGameStartsAt;
    const isSettled =
      finalGameStarted &&
      (netBalance === 0 ||
        (payments.length > 0 && allOutgoingPaid && allIncomingPaid));
    const isExpanded = expandedSettlementSeasonIds.includes(season.id);
    const balanceText = !finalGameStarted
      ? netBalance < 0
        ? `You owe ${formatMoney(-netBalance)} so far`
        : netBalance > 0
          ? `You are owed ${formatMoney(netBalance)} so far`
          : completedTransactions
            ? "You've broken even so far"
            : "Your season balance will show here once you buy or sell a spot"
      : netBalance < 0
        ? `You owe ${formatMoney(-netBalance)}`
        : netBalance > 0
          ? `You are owed ${formatMoney(netBalance)}`
          : "No payments required: you're all settled up!";
    const stateColor = isSettled
      ? "border-green-300 bg-green-100 text-green-950"
      : isExpanded && finalGameStarted
        ? "border-yellow-300 bg-yellow-100 text-yellow-950"
        : "border-red-300 bg-red-100 text-red-950";
    const needsSettlementAction =
      finalGameStarted &&
      !isSettled &&
      outgoingPayments.some((payment) => !payment.isPaid);
    const settlementPulseClass =
      needsSettlementAction
        ? isExpanded
          ? "ring-2 ring-offset-1 ring-yellow-400 motion-safe:ring-4 motion-safe:ring-offset-2 motion-safe:animate-pulse"
          : "ring-2 ring-offset-1 ring-red-400 motion-safe:ring-4 motion-safe:ring-offset-2 motion-safe:animate-pulse"
        : "";
    const settlementDotClass =
      needsSettlementAction
        ? isExpanded
          ? "bg-yellow-500"
          : "bg-red-500"
        : "";
    const exchangeItems = season.ledgerEntries.flatMap((entry) => {
      if (
        entry.originalRegularPlayerId !== userId &&
        entry.substitutePlayerId !== userId
      ) {
        return [];
      }
      const date = formatLeagueDate(entry.gameDate, season.timezone, {
        month: "numeric",
        day: "numeric",
      });
      if (entry.wasFreeClaim) {
        return [
          `${date} ${
            entry.substitutePlayerId === userId
              ? "Claimed"
              : `Claimed by ${entry.substitutePlayerName}`
          }`,
        ];
      }
      return [
        `${date} ${
          entry.originalRegularPlayerId === userId
            ? `Sold to ${entry.substitutePlayerName}`
            : `Bought from ${entry.originalRegularPlayerName}`
        }`,
      ];
    });

    return (
      <>
        <div
          aria-label="Exchange Log"
          className="min-h-44 rounded-lg border border-slate-300 bg-slate-200 p-4 text-slate-700"
        >
          <h3 className="font-bold text-slate-800">Exchange Log</h3>
          {exchangeItems.length ? (
            <ul className="mt-3 space-y-2 text-sm">
              {exchangeItems.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-600">
              No sub exchanges to display.
            </p>
          )}
        </div>
        <div
          className={`relative min-h-44 rounded-lg border p-4 ${stateColor} ${settlementPulseClass}`}
          data-state={
            isSettled ? "green" : isExpanded && finalGameStarted ? "yellow" : "red"
          }
        >
          {needsSettlementAction && (
            <span
              aria-label="Payment action required"
              className="absolute right-2 top-2 h-3 w-3 rounded-full"
              role="status"
            >
              <span
                className={`absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping ${settlementDotClass}`}
              />
              <span
                className={`relative inline-flex h-3 w-3 rounded-full ${settlementDotClass}`}
              />
            </span>
          )}
          {isSettled ? (
            <>
              <h3 className="font-bold">Settle Up</h3>
              <p className="mt-3 text-sm font-medium">{balanceText}</p>
            </>
          ) : !finalGameStarted ? (
            <>
              <h3 className="font-bold">Settle Up</h3>
              <p className="mt-3 text-sm font-medium">{balanceText}</p>
            </>
          ) : !isExpanded ? (
            <button
              className="h-full min-h-32 w-full text-left focus:outline-none focus:ring-2 focus:ring-red-700"
              onClick={() =>
                setExpandedSettlementSeasonIds((current) =>
                  current.includes(season.id)
                    ? current
                    : [...current, season.id],
                )
              }
              type="button"
            >
              <span className="block font-bold">Settle Up</span>
              <span className="mt-3 block text-sm font-medium">{balanceText}</span>
              <span className="mt-3 block text-xs font-semibold uppercase tracking-wide">
                View payment details
              </span>
            </button>
          ) : (
            <>
              <h3 className="font-bold">Settle Up</h3>
              <p className="mt-2 text-sm font-semibold">{balanceText}</p>
              <ul className="mt-3 space-y-2 text-sm font-bold">
                {outgoingPayments.map((payment) => (
                  <li key={`${payment.debtorId}-${payment.creditorId}`}>
                    {payment.isPaid ? "Paid" : "Pay"} {payment.creditorName}{" "}
                    {formatMoney(payment.amountCents)}
                  </li>
                ))}
                {incomingPayments.map((payment) => (
                  <li key={`${payment.debtorId}-${payment.creditorId}`}>
                    {payment.isPaid
                      ? `${payment.debtorName} says they paid you`
                      : `${payment.debtorName} owes you`}{" "}
                    {formatMoney(payment.amountCents)}
                  </li>
                ))}
              </ul>
              {outgoingPayments.some((payment) => !payment.isPaid) && (
                <button
                  className="mt-4 rounded-lg bg-yellow-800 px-3 py-2 text-sm font-semibold text-white hover:bg-yellow-900"
                  onClick={() => setConfirmSettlementSeasonId(season.id)}
                  type="button"
                >
                  Confirm payments sent
                </button>
              )}
              {incomingPayments.length > 0 && (
                <p className="mt-4 text-xs text-slate-700">
                  Payment status updates automatically when each debtor confirms.
                </p>
              )}
            </>
          )}
        </div>
      </>
    );
  }

  function renderGame(seasonId: string, game: Game) {
    const busy = busyGameId === game.id;
    const season = seasons.find((item) => item.id === seasonId);
    const openSlots = game.fmpSlotsToFill + game.mmpSlotsToFill;
    const startsAt = wallClockToDate(
      game.gameDate,
      game.startTime,
      game.timezone,
    ).getTime();
    const timeLabel = formatCardTime(game);
    const globalClaimStartsAt =
      startsAt - (season?.globalClaimHours ?? 0) * 60 * 60 * 1000;
    const genderClaimStartsAt =
      globalClaimStartsAt -
      (season?.genderMatchClaimHours ?? 0) * 60 * 60 * 1000;
    const inGlobalClaimWindow = now >= globalClaimStartsAt && now < startsAt;
    const inGenderClaimWindow =
      now >= genderClaimStartsAt && now < globalClaimStartsAt;
    const hasGenderMatchSlot =
      season?.playerGender === "FMP"
        ? game.fmpSlotsToFill > 0
        : season?.playerGender === "MMP" && game.mmpSlotsToFill > 0;
    const canClaim =
      game.status !== "playing" &&
      openSlots > 0 &&
      (inGlobalClaimWindow || (inGenderClaimWindow && hasGenderMatchSlot));
    const activePing = activePings.find(
      (ping) => ping.gameId === game.id,
    );
    const needsClaimAction =
      game.status === "available" && canClaim;
    const attentionPulseClass = activePing
      ? "ring-2 ring-offset-1 ring-yellow-400 motion-safe:ring-4 motion-safe:ring-offset-2 motion-safe:animate-pulse"
      : needsClaimAction
        ? "ring-2 ring-offset-1 ring-amber-400 motion-safe:ring-4 motion-safe:ring-offset-2 motion-safe:animate-pulse"
        : "";
    const attentionDotClass = "bg-amber-500";
    const commitmentLocked = now >= genderClaimStartsAt || now >= startsAt;
    const needsText = [
      game.fmpSlotsToFill > 0
        ? `${game.fmpSlotsToFill} FMP${game.fmpSlotsToFill === 1 ? "" : "s"}`
        : "",
      game.mmpSlotsToFill > 0
        ? `${game.mmpSlotsToFill} MMP${game.mmpSlotsToFill === 1 ? "" : "s"}`
        : "",
    ].filter(Boolean).join(", ");
    const bottomText = activePing ? formatPingRespondBy(activePing) : needsText ? `need ${needsText}` : "";
    const compactPingText = activePing
      ? formatPingRespondBy(activePing)
          .replace(/^Respond /, "")
          .replace(/([AP])M$/, (_match, period: string) => period.toLowerCase())
      : "";
    const content = (
      <div className="flex h-full min-w-0 flex-col overflow-hidden">
        <div className="flex min-w-0 shrink-0 items-baseline justify-between gap-1 whitespace-nowrap pr-1 text-[clamp(11px,11cqi,14px)] font-semibold leading-tight">
          <span className="calendar-card-date-full min-w-0 truncate text-left">
            {formatLeagueDate(game.gameDate, game.timezone, {
              month: "short",
              day: "numeric",
            })}
          </span>
          <span className="calendar-card-date-compact shrink-0 text-left">{formatCompactCardDate(game.gameDate)}</span>
          <span className={`calendar-card-time-full shrink-0 text-right ${activePing ? "pr-2" : ""}`}>{timeLabel}</span>
          <span className={`calendar-card-time-compact shrink-0 text-right ${activePing ? "pr-2" : ""}`}>{timeLabel.replace(/m$/, "")}</span>
        </div>
        <span className="flex min-h-0 min-w-0 flex-1 items-center justify-center truncate whitespace-nowrap text-center text-[clamp(13px,14cqi,22px)] font-bold uppercase leading-none tracking-tight">{game.status}</span>
        <span className="flex min-h-[1.25em] min-w-0 shrink-0 items-end justify-center truncate whitespace-nowrap text-center text-[clamp(10px,9.5cqi,13px)] font-medium leading-tight">
          {activePing ? <><span className="calendar-card-ping-full">{bottomText}</span><span className="calendar-card-ping-compact">{compactPingText}</span></> : bottomText}
        </span>
      </div>
    );

    return (
      <div className="space-y-2 [container-type:inline-size]" data-game-id={game.id} key={game.id}>
        {game.cancelled ? (
          <div className="flex aspect-[1/0.85] min-h-[84px] w-full min-w-0 flex-col overflow-hidden rounded-lg border border-slate-300 bg-slate-200 p-2 text-slate-600 [container-type:inline-size]">
            <span className="calendar-card-date-full shrink-0 truncate whitespace-nowrap text-[clamp(11px,11cqi,14px)] font-semibold leading-tight">{formatLeagueDate(game.gameDate, game.timezone, { month: "short", day: "numeric" })}</span>
            <span className="calendar-card-date-compact shrink-0 whitespace-nowrap text-[clamp(11px,11cqi,14px)] font-semibold leading-tight">{formatCompactCardDate(game.gameDate)}</span>
            <span className="flex min-h-0 flex-1 items-center justify-center truncate whitespace-nowrap text-[clamp(11px,10cqi,14px)] font-semibold leading-none">No game</span>
            <span aria-hidden="true" className="min-h-[1.25em] shrink-0" />
          </div>
        ) : (
          <div className="relative">
            <button
              aria-label={`${formatLeagueDate(game.gameDate, game.timezone, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}, ${game.status}, ${game.fmpSlotsToFill} FMPs and ${game.mmpSlotsToFill} MMPs needed. ${
                activePing
                  ? "Active sub ping. Click to respond."
                  : needsClaimAction
                    ? "Open claim window. Click to claim or set unavailable."
                    : "Click to change availability."
              }`}
              className={`relative flex aspect-[1/0.85] min-h-[84px] w-full min-w-0 flex-col overflow-hidden rounded-lg border p-2 text-left transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-teal-700 disabled:cursor-not-allowed disabled:opacity-60 ${cardColors[game.status][startsAt > now ? "future" : "past"]} ${attentionPulseClass} ${highlightedGameId === game.id ? "ring-4 ring-yellow-400" : ""}`}
              disabled={
                busy ||
                (commitmentLocked && !activePing && !needsClaimAction)
              }
              onClick={() => {
                if (activePing) {
                  setPingModal(activePing);
                } else if (needsClaimAction) {
                  setClaimGame({ seasonId, game });
                } else if (game.status === "playing") {
                  setConfirmGame({ seasonId, game });
                } else {
                  changeCommitment(seasonId, game);
                }
              }}
              type="button"
            >
              {content}
            </button>
            {activePing && <span aria-label="Active sub ping" className="absolute right-1 top-1 z-10 h-1.5 w-1.5 rounded-full bg-yellow-500 motion-safe:animate-pulse" role="status" />}
            {needsClaimAction && !activePing && (
              <span
                aria-label="Claim action required"
                className="absolute right-2 top-2 h-3 w-3 rounded-full"
                role="status"
              >
                <span
                  className={`absolute inline-flex h-full w-full rounded-full opacity-75 motion-safe:animate-ping ${attentionDotClass}`}
                />
                <span
                  className={`relative inline-flex h-3 w-3 rounded-full ${attentionDotClass}`}
                />
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="relative z-20 flex min-h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3" style={{ paddingTop: "env(safe-area-inset-top)", paddingLeft: "max(0.75rem, env(safe-area-inset-left))", paddingRight: "max(0.75rem, env(safe-area-inset-right))" }}>
        <span className="font-bold text-slate-900">OnlySubs</span>
        {seasons[0] && <span className="min-w-0 flex-1 truncate text-sm text-slate-600">{seasons[0].name}</span>}
        <div ref={gearRef} className="relative">
          <button aria-expanded={gearOpen} aria-label="Open menu" className="flex h-9 w-9 items-center justify-center border border-slate-300 text-lg" onClick={() => setGearOpen((open) => !open)} type="button">&#9881;</button>
          {gearOpen && <div className="absolute right-0 top-10 w-56 border border-slate-300 bg-white p-2 shadow-lg">
            {seasons.filter((season) => season.rulesPdfUrl).map((season) => <a key={season.id} className="block px-2 py-2 hover:bg-slate-50" href={season.rulesPdfUrl ?? undefined} rel="noopener noreferrer" target="_blank">Rules - {season.name}</a>)}
            {isAdmin && <Link className="block px-2 py-2 hover:bg-slate-50" href="/admin">Admin</Link>}
            <NotificationsButton compact />
            <SignOutButton compact />
          </div>}
        </div>
      </header>
      {dayColumns.length > 0 && <div className="shrink-0 border-b border-slate-200 bg-white">
        <table className="w-full table-fixed border-separate border-spacing-0 px-2 text-left">
          <thead><tr>{dayColumns.map((weekday) => <th className="calendar-day-label py-1 text-center text-xs font-semibold text-slate-700" key={weekday}><span className="calendar-day-long">{weekdayNames[weekday]}</span><span className="calendar-day-short">{weekdayNames[weekday].slice(0, 3)}</span></th>)}</tr></thead>
        </table>
      </div>}
      <div
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-white"
        ref={calendarScrollRef}
      >
      {seasons.map((season) => {
        const weeks = weekGroups.get(season.id) ?? [];
        const sessionIds = new Set(season.sessions.map((session) => session.id));
        const finalGame = season.games
          .filter((game) => sessionIds.has(game.sessionId) && !game.cancelled)
          .reduce<Game | null>((latest, game) => {
            if (!latest) return game;
            const gameStart = wallClockToDate(
              game.gameDate,
              game.startTime,
              game.timezone,
            ).getTime();
            const latestStart = wallClockToDate(
              latest.gameDate,
              latest.startTime,
              latest.timezone,
            ).getTime();
            return gameStart > latestStart ? game : latest;
          }, null);
        const finalGameWeekKey = finalGame
          ? weekKey(startOfWeek(parseDate(finalGame.gameDate)))
          : null;
        const upcomingGame = season.games.find(
          (game) => `${season.id}:${game.id}` === nextGameId,
        );
        const upcomingWeekKey = upcomingGame
          ? weekKey(startOfWeek(parseDate(upcomingGame.gameDate)))
          : null;
        return (
          <section key={season.id}>
            {weeks.length === 0 ? (
              <p className="m-4 rounded-lg bg-slate-50 p-5 text-slate-600">
                No game dates have been added yet.
              </p>
            ) : (
                <table className="w-full table-fixed border-separate border-spacing-0 px-2 text-left">
                  <tbody>
                    {weeks.map((week) => (
                      <Fragment key={`${season.id}-${week.key}`}>
                        <tr
                          className="align-top"
                          data-next-game={
                            week.key === upcomingWeekKey ? "true" : undefined
                          }
                        >
                          {dayColumns.map((weekday) => {
                            const games = (week.gamesByDay.get(weekday) ?? [])
                              .filter((game) => sessionIds.has(game.sessionId) && !game.cancelled);
                            return (
                              <td
                                className="border-b border-slate-100 p-2 align-top"
                                key={weekday}
                              >
                                {games.length ? (
                                  <div className="space-y-2">
                                    {games.map((game) => renderGame(season.id, game))}
                                  </div>
                                ) : (
                                  (() => {
                                    const noGameDate = new Date(parseDate(week.key).getTime() + weekday * 24 * 60 * 60 * 1000);
                                    const noGameKey = noGameDate.toISOString().slice(0, 10);
                                    return (
                                      <div className="flex aspect-[1/0.85] min-h-[84px] w-full min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-100 p-2 text-slate-500 [container-type:inline-size]">
                                        <span className="calendar-card-date-full shrink-0 truncate whitespace-nowrap text-[clamp(11px,11cqi,14px)] font-semibold leading-tight">{formatLeagueDate(noGameKey, "UTC", { month: "short", day: "numeric" })}</span>
                                        <span className="calendar-card-date-compact shrink-0 whitespace-nowrap text-[clamp(11px,11cqi,14px)] font-semibold leading-tight">{formatCompactCardDate(noGameKey)}</span>
                                        <span className="flex min-h-0 flex-1 items-center justify-center truncate whitespace-nowrap text-[clamp(11px,10cqi,14px)] font-semibold leading-none">No game</span>
                                        <span aria-hidden="true" className="min-h-[1.25em] shrink-0" />
                                      </div>
                                    );
                                  })()
                                )}
                              </td>
                            );
                          })}
                        </tr>
                        {finalGameWeekKey === week.key && (
                          <tr>
                            <td
                              className="border-b border-slate-100 p-3"
                              colSpan={dayColumns.length}
                            >
                              <div className="grid gap-3 md:grid-cols-2">
                                {renderPostSeasonCards(season)}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
            )}
          </section>
        );
      })}
      </div>

      <footer className="flex min-h-12 shrink-0 items-center border-t border-slate-200 bg-white px-3" style={{ paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "max(0.75rem, env(safe-area-inset-left))", paddingRight: "max(0.75rem, env(safe-area-inset-right))" }}>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{fullName}</span>
        <button
          className="h-9 border border-slate-300 px-3 disabled:text-slate-400"
          disabled={activePings.length === 0}
          onClick={() => {
            const soonest = [...activePings].sort((left, right) =>
              new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime(),
            )[0];
            if (soonest) scrollAndHighlightGame(soonest.gameId);
          }}
          type="button"
        >
          {activePings.length} active ping{activePings.length === 1 ? "" : "s"}
        </button>
      </footer>

      {pingModal && (
        <div
          aria-labelledby="active-ping-title"
          aria-modal="true"
          className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/50 p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPingModal(null);
          }}
          role="dialog"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900" id="active-ping-title">
              Respond to sub ping
            </h2>
            <p className="mt-3 leading-6 text-slate-700">
              {formatLeagueDate(pingModal.gameDate, pingModal.timezone, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })} at {formatPingGameTime(pingModal)}
            </p>
            <p className="mt-2 text-sm font-semibold text-yellow-800">
              {formatPingRespondBy(pingModal)}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded-lg border border-slate-300 px-4 py-2.5 font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setPingModal(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="rounded-lg border border-slate-300 px-4 py-2.5 font-semibold text-slate-700 hover:bg-slate-50"
                disabled={busyGameId === pingModal.gameId}
                onClick={() => respondToPing(pingModal.id, "pass")}
                type="button"
              >
                Pass
              </button>
              <button
                className="rounded-lg bg-green-700 px-4 py-2.5 font-semibold text-white hover:bg-green-800 disabled:opacity-60"
                disabled={busyGameId === pingModal.gameId}
                onClick={() => respondToPing(pingModal.id, "accept")}
                type="button"
              >
                Accept Spot
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmGame && (
        <div
          aria-labelledby="sub-request-title"
          aria-modal="true"
          className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/50 p-5"
          role="dialog"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900" id="sub-request-title">
              Request a substitute?
            </h2>
            <p className="mt-3 leading-6 text-slate-700">
              Mark yourself unavailable for{" "}
              {formatLeagueDate(confirmGame.game.gameDate, confirmGame.game.timezone, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}
              ? This will immediately notify the sub list to fill your spot.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded-lg border border-slate-300 px-4 py-2.5 font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setConfirmGame(null)}
                type="button"
              >
                Keep me playing
              </button>
              <button
                className="rounded-lg bg-red-700 px-4 py-2.5 font-semibold text-white hover:bg-red-800 disabled:opacity-60"
                disabled={busyGameId === confirmGame.game.id}
                onClick={() =>
                  changeCommitment(confirmGame.seasonId, confirmGame.game)
                }
                type="button"
              >
                {busyGameId === confirmGame.game.id ? "Sending..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
      {claimGame && (
        <div
          aria-labelledby="claim-spot-title"
          aria-modal="true"
          className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/50 p-5"
          role="dialog"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-xl font-semibold text-slate-900" id="claim-spot-title">
              Claim this spot?
            </h2>
            <p className="mt-3 leading-6 text-slate-700">
              You are committing to play on{" "}
              {formatLeagueDate(claimGame.game.gameDate, claimGame.game.timezone, {
                weekday: "long",
                month: "long",
                day: "numeric",
              })}.
              {!claimSeason?.claimsAreFree && (
                <>
                  {" "}You are also committing to pay $
                  {(
                    (claimSeason?.gamePriceCents ?? 0) / 100
                  ).toFixed(2)}{" "}
                  for the spot.
                </>
              )}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded-lg border border-slate-300 px-4 py-2.5 font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setClaimGame(null)}
                type="button"
              >
                Not now
              </button>
              <button
                className="rounded-lg border border-red-300 px-4 py-2.5 font-semibold text-red-700 hover:bg-red-50 disabled:opacity-60"
                disabled={busyGameId === claimGame.game.id || !claimWindowOpen}
                onClick={() => {
                  setClaimGame(null);
                  void changeCommitment(claimGame.seasonId, claimGame.game);
                }}
                type="button"
              >
                Set Unavailable
              </button>
              <button
                className="rounded-lg bg-amber-600 px-4 py-2.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
                disabled={
                  busyGameId === claimGame.game.id || !claimWindowOpen
                }
                onClick={() => claimSpot(claimGame.seasonId, claimGame.game)}
                type="button"
              >
                {busyGameId === claimGame.game.id
                  ? "Claiming..."
                  : claimWindowOpen
                    ? "Confirm Claim"
                    : "Claim Window Closed"}
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmSettlementSeasonId && (
        <div
          aria-labelledby="confirm-settlement-title"
          aria-modal="true"
          className="fixed inset-0 z-30 flex items-center justify-center bg-slate-950/50 p-5"
          role="dialog"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2
              className="text-xl font-semibold text-slate-900"
              id="confirm-settlement-title"
            >
              Confirm payments sent?
            </h2>
            <p className="mt-3 leading-6 text-slate-700">
              Confirm that you have sent all outstanding payments for this season.
              Creditors will be notified that you marked them paid.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                className="rounded-lg border border-slate-300 px-4 py-2.5 font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => setConfirmSettlementSeasonId(null)}
                type="button"
              >
                Not yet
              </button>
              <button
                className="rounded-lg bg-green-700 px-4 py-2.5 font-semibold text-white hover:bg-green-800 disabled:opacity-60"
                disabled={
                  busySettlementSeasonId === confirmSettlementSeasonId
                }
                onClick={() =>
                  void confirmSeasonPayments(confirmSettlementSeasonId)
                }
                type="button"
              >
                {busySettlementSeasonId === confirmSettlementSeasonId
                  ? "Saving..."
                  : "Confirm Sent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
