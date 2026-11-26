"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  formatLeagueDate,
  formatZonedDateTime,
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

function buildWeeks(season: Season): Week[] {
  const weeks = new Map<string, Week>();
  const sessionIds = new Set(season.sessions.map((session) => session.id));
  for (const game of season.games) {
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
  return [...weeks.values()]
    .filter((week) => [...week.gamesByDay.values()].some((games) =>
      games.some((game) => sessionIds.has(game.sessionId)),
    ))
    .sort((left, right) => left.key.localeCompare(right.key));
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

const weekdayNames = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

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
}: {
  seasons: Season[];
  pendingPings: PendingPing[];
  serverNow: string;
  userId: string;
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
  const [pingActionGameId, setPingActionGameId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const calendarScrollRef = useRef<HTMLDivElement>(null);
  const autoScrollAttempted = useRef(false);

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
  const visiblePendingPings = pendingPings.filter((ping) => {
    const startsAt = wallClockToDate(
      ping.gameDate,
      ping.startTime,
      ping.timezone,
    ).getTime();
    return (
      now <
      startsAt -
        (ping.globalClaimHours + ping.genderMatchClaimHours) * 60 * 60 * 1000
    );
  });
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
      setPingActionGameId(null);
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
    const activePing = visiblePendingPings.find(
      (ping) => ping.gameId === game.id,
    );
    const needsClaimAction =
      game.status === "available" && canClaim;
    const needsAttention = Boolean(activePing || needsClaimAction);
    const attentionPulseClass = activePing
      ? "ring-2 ring-offset-1 ring-teal-400 motion-safe:ring-4 motion-safe:ring-offset-2 motion-safe:animate-pulse"
      : needsClaimAction
        ? "ring-2 ring-offset-1 ring-amber-400 motion-safe:ring-4 motion-safe:ring-offset-2 motion-safe:animate-pulse"
        : "";
    const attentionDotClass = activePing
      ? "bg-teal-600"
      : "bg-amber-500";
    const commitmentLocked = now >= genderClaimStartsAt || now >= startsAt;
    const content = (
      <div className="flex min-h-28 flex-col">
        <div className="grid grid-cols-3 items-center gap-1 text-xs font-semibold sm:text-sm">
          <span className="text-left">
            {formatLeagueDate(game.gameDate, game.timezone, {
              month: "short",
              day: "numeric",
            }).replace(" ", "")}
          </span>
          <span className="text-center">
            {formatLeagueDate(game.gameDate, game.timezone, {
              weekday: "long",
            })}
          </span>
          <span className="text-right">{timeLabel}</span>
        </div>
        <span className="flex flex-1 items-center justify-center py-2 text-base font-bold uppercase tracking-wide">
          {game.status}
        </span>
        <span className="text-center text-[11px] font-medium leading-tight sm:text-xs">
          need {game.fmpSlotsToFill} FMPs, {game.mmpSlotsToFill} MMPs
        </span>
      </div>
    );

    return (
      <div className="space-y-2" key={game.id}>
        {game.cancelled ? (
          <div className="flex h-32 items-center justify-center rounded-lg border border-slate-300 bg-slate-200 p-3 text-sm font-bold text-slate-700">
            No game
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
                  ? "Active sub ping. Click to accept or pass."
                  : needsClaimAction
                    ? "Open claim window. Click to claim or set unavailable."
                    : "Click to change availability."
              }`}
              className={`relative h-32 w-full rounded-lg border p-2 text-left transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-teal-700 disabled:cursor-not-allowed disabled:opacity-60 ${cardColors[game.status][startsAt > now ? "future" : "past"]} ${attentionPulseClass}`}
              disabled={
                busy ||
                (commitmentLocked && !activePing && !needsClaimAction)
              }
              onClick={() => {
                if (activePing) {
                  setPingActionGameId((current) =>
                    current === game.id ? null : game.id,
                  );
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
            {needsAttention && (
              <span
                aria-label={activePing ? "Sub ping requires response" : "Claim action required"}
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
            {activePing && pingActionGameId === game.id && (
              <div className="mt-2 flex flex-wrap gap-2 rounded-lg border border-teal-200 bg-teal-50 p-2">
                <button
                  className="rounded-lg bg-green-700 px-3 py-2 text-sm font-semibold text-white hover:bg-green-800"
                  disabled={busy}
                  onClick={() => respondToPing(activePing.id, "accept")}
                  type="button"
                >
                  Accept Spot
                </button>
                <button
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  disabled={busy}
                  onClick={() => respondToPing(activePing.id, "pass")}
                  type="button"
                >
                  Pass
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {message && (
        <p aria-live="polite" className="mb-5 rounded-lg bg-teal-50 p-4 text-sm text-teal-900">
          {message}
        </p>
      )}
      {error && (
        <p aria-live="polite" className="mb-5 rounded-lg bg-red-50 p-4 text-sm text-red-800">
          {error}
        </p>
      )}
      {visiblePendingPings.length > 0 && (
        <section
          aria-label="Pending substitute requests"
          className="mb-8 rounded-xl border-2 border-teal-700 bg-teal-50 p-4 shadow-sm"
        >
          <h2 className="text-xl font-bold text-teal-950">You&apos;ve been pinged for a game</h2>
          <div className="mt-2 space-y-1">
            {visiblePendingPings.map((ping) => (
                <p className="text-sm font-medium text-teal-950" key={ping.id}>
                  {ping.seasonName} ·{" "}
                  {formatLeagueDate(ping.gameDate, ping.timezone, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                  })}{" "}
                  · Respond before {formatZonedDateTime(ping.expiresAt, ping.timezone)}
                </p>
              ))}
          </div>
        </section>
      )}
      <div
        className="mt-4 min-h-0 flex-1 overflow-auto rounded-xl border border-slate-200 bg-white"
        ref={calendarScrollRef}
      >
      {seasons.map((season) => {
        const weeks = weekGroups.get(season.id) ?? [];
        const sessionIds = new Set(season.sessions.map((session) => session.id));
        const dayColumns = [...new Set(
          season.games
            .filter((game) => sessionIds.has(game.sessionId))
            .map((game) => parseDate(game.gameDate).getUTCDay()),
        )].sort((left, right) => left - right);
        const finalGame = season.games
          .filter((game) => !game.cancelled)
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
          <section className="mt-8" key={season.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-semibold text-slate-900">{season.name}</h2>
              {season.rulesPdfUrl && (
                <a
                  className="inline-flex items-center gap-2 rounded-lg border border-teal-700 px-3 py-2 text-sm font-semibold text-teal-800 hover:bg-teal-50"
                  href={season.rulesPdfUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <svg
                    aria-hidden="true"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    viewBox="0 0 24 24"
                  >
                    <path
                      d="M7 3.75h7l4.25 4.5v12A.75.75 0 0 1 17.5 21h-10a.75.75 0 0 1-.75-.75v-16A.5.5 0 0 1 7 3.75Z"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path d="M14 4v5h4M8.5 14h7m-7 3h7" strokeLinecap="round" />
                  </svg>
                  Rules
                </a>
              )}
            </div>
            {weeks.length === 0 ? (
              <p className="m-4 rounded-lg bg-slate-50 p-5 text-slate-600">
                No game dates have been added yet.
              </p>
            ) : (
                <table className="w-full min-w-[720px] table-fixed border-separate border-spacing-0 text-left">
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
                      <Fragment key={`${season.id}-${week.key}`}>
                        <tr
                          className="align-top"
                          data-next-game={
                            week.key === upcomingWeekKey ? "true" : undefined
                          }
                        >
                          {dayColumns.map((weekday) => {
                            const games = (week.gamesByDay.get(weekday) ?? [])
                              .filter((game) => sessionIds.has(game.sessionId));
                            return (
                              <td
                                className="border-b border-slate-100 p-2 align-top"
                                key={weekday}
                              >
                                {games.length ? (
                                  <div className="space-y-2">
                                    {games.map((game) => renderGame(season.id, game))}
                                  </div>
                                ) : null}
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
