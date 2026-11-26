"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { parseRosterPaste, type RosterPlayer } from "@/lib/parse-roster-paste";

export type SeasonSummary = { id: string; name: string; is_published: boolean };

type InitialData = {
  season: {
    id: string; name: string; is_published: boolean; rules_pdf_url: string | null;
    rules_pdf_name: string | null; timeout_hours: number; daytime_start_hour: number;
    daytime_end_hour: number; timezone: string; game_price_cents: number;
    global_claim_hours: number | string; gender_match_claim_hours: number | string;
    claims_are_free: boolean;
  };
  sessions: Array<{
    id: string; name: string; start_time: string; weekday: number;
    dates: string[]; lockedDates: string[]; players: Array<RosterPlayer & { gender: "MMP" | "FMP" }>;
    games: Array<{ id: string; game_date: string }>;
  }>;
  extraPlayers: Array<RosterPlayer & { gender: "MMP" | "FMP" }>;
};

type SessionDraft = {
  id?: string; weekday: number; startTime: string; dates: string[];
  mmpText: string; fmpText: string;
};

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function dateOptions(weekday: number, saved: string[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const options = new Set(saved);
  const cursor = new Date(today);
  cursor.setDate(cursor.getDate() + ((weekday - cursor.getDay() + 7) % 7 || 7));
  const horizon = addMonths(cursor, 6);
  while (cursor <= horizon) {
    options.add(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 7);
  }
  return [...options].sort();
}

function formatDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(new Date(year, month - 1, day));
}

function formatTime(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(2020, 0, 1, hour, minute));
}

function blankSession(): SessionDraft {
  return { weekday: 2, startTime: "19:00", dates: [], mmpText: "", fmpText: "" };
}

export function MasterAdmin({ seasons, initialData }: { seasons: SeasonSummary[]; initialData: InitialData | null }) {
  const router = useRouter();
  const [seasonId, setSeasonId] = useState(initialData?.season.id ?? "");
  const [name, setName] = useState(initialData?.season.name ?? "");
  const [sessions, setSessions] = useState<SessionDraft[]>(initialData
    ? initialData.sessions.map((session) => ({
        id: session.id,
        weekday: session.weekday,
        startTime: session.start_time.slice(0, 5),
        dates: session.dates,
        mmpText: session.players.filter((player) => player.gender === "MMP").map((player) => `${player.name}${player.name ? " <" : ""}${player.email}${player.name ? ">" : ""}`).join("\n"),
        fmpText: session.players.filter((player) => player.gender === "FMP").map((player) => `${player.name}${player.name ? " <" : ""}${player.email}${player.name ? ">" : ""}`).join("\n"),
      }))
    : [blankSession()]);
  const [extraText, setExtraText] = useState(initialData?.extraPlayers.map((player) => `${player.name}${player.name ? " <" : ""}${player.email}${player.name ? ">" : ""}`).join("\n") ?? "");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [rulesPdfFile, setRulesPdfFile] = useState<File | null>(null);
  const [removeRulesPdf, setRemoveRulesPdf] = useState(false);
  const [timeoutHours, setTimeoutHours] = useState(initialData?.season.timeout_hours ?? 2);
  const [dayStart, setDayStart] = useState(initialData?.season.daytime_start_hour ?? 8);
  const [dayEnd, setDayEnd] = useState(initialData?.season.daytime_end_hour ?? 22);
  const [timezone, setTimezone] = useState(initialData?.season.timezone ?? "America/Los_Angeles");
  const [gamePrice, setGamePrice] = useState(((initialData?.season.game_price_cents ?? 1200) / 100).toFixed(2));
  const [globalClaim, setGlobalClaim] = useState(Number(initialData?.season.global_claim_hours ?? 2));
  const [genderClaim, setGenderClaim] = useState(Number(initialData?.season.gender_match_claim_hours ?? 1));
  const [claimsFree, setClaimsFree] = useState(initialData?.season.claims_are_free ?? true);

  function updateSession(index: number, patch: Partial<SessionDraft>) {
    setSessions((current) => current.map((session, sessionIndex) => sessionIndex === index ? { ...session, ...patch } : session));
  }

  function selectSeason(nextId: string) {
    if (!nextId) {
      setSeasonId("");
      router.push("/admin");
      return;
    }
    router.push(`/admin?season=${encodeURIComponent(nextId)}`);
  }

  function parsedPlayers(text: string, gender: "MMP" | "FMP") {
    const parsed = parseRosterPaste(text);
    return { ...parsed, players: parsed.players.map((player) => ({ ...player, gender })) };
  }

  async function saveSeason() {
    setSaving(true); setError(""); setStatus("");
    try {
      if (!name.trim()) throw new Error("Enter a season name.");
      const priceMatch = /^\d+(?:\.\d{0,2})?$/.exec(gamePrice.trim());
      const gamePriceCents = priceMatch ? Math.round(Number(gamePrice) * 100) : NaN;
      if (!Number.isSafeInteger(gamePriceCents) || gamePriceCents < 0 || gamePriceCents > 100000) throw new Error("Enter a valid game price.");

      for (const session of sessions) {
        if (!session.dates.length) throw new Error("Select at least one date for every session.");
      }

      if (initialData && seasonId) {
        for (const initialSession of initialData.sessions) {
          const draft = sessions.find((session) => session.id === initialSession.id);
          if (!draft) continue;
          for (const game of initialSession.games) {
            if (!draft.dates.includes(game.game_date)) {
              await fetch(`/api/admin/games/${game.id}/cancel`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cancelled: true }),
              }).then(async (response) => {
                if (!response.ok) {
                  const result = await response.json();
                  throw new Error(result.error || "Could not cancel a removed game.");
                }
              });
            }
          }
        }
      }

      const sessionPayload = sessions.map((session) => {
        const mmp = parsedPlayers(session.mmpText, "MMP").players;
        const fmp = parsedPlayers(session.fmpText, "FMP").players;
        const first = session.dates.reduce((minimum, date) => date < minimum ? date : minimum, session.dates[0]);
        const last = session.dates.reduce((maximum, date) => date > maximum ? date : maximum, session.dates[0]);
        const autoName = `${weekdays[session.weekday]} ${formatTime(session.startTime)}`;
        return { id: session.id, name: autoName, start_time: session.startTime, weekday: session.weekday, schedule_name: autoName, first_week: first, last_week: last, dates: session.dates, players: [...mmp, ...fmp] };
      });
      const extra = parsedPlayers(extraText, "FMP").players;

      const response = await fetch("/api/admin/seasons", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ season_id: seasonId || undefined, name: name.trim(), timeout_hours: timeoutHours, daytime_start_hour: dayStart, daytime_end_hour: dayEnd, timezone, game_price_cents: gamePriceCents, global_claim_hours: globalClaim, gender_match_claim_hours: genderClaim, claims_are_free: claimsFree, sessions: sessionPayload, extra_players: extra }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not save the season.");
      const savedSeasonId = String(result.season_id ?? seasonId);

      if (rulesPdfFile) {
        const supabase = createClient();
        const storagePath = `${savedSeasonId}/${crypto.randomUUID()}.pdf`;
        const { error: uploadError } = await supabase.storage.from("season-docs").upload(storagePath, rulesPdfFile, { contentType: "application/pdf", upsert: false });
        if (uploadError) throw new Error(`Could not upload the season PDF: ${uploadError.message}`);
        const documentResponse = await fetch(`/api/admin/seasons/${savedSeasonId}/document`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ storage_path: storagePath, file_name: rulesPdfFile.name }),
        });
        const documentResult = await documentResponse.json();
        if (!documentResponse.ok) throw new Error(documentResult.error || "Could not save the season PDF.");
        setRulesPdfFile(null);
      } else if (removeRulesPdf && seasonId) {
        const documentResponse = await fetch(`/api/admin/seasons/${seasonId}/document`, { method: "DELETE" });
        const documentResult = await documentResponse.json();
        if (!documentResponse.ok) throw new Error(documentResult.error || "Could not remove the season PDF.");
        setRemoveRulesPdf(false);
      }

      setStatus("Saved");
      router.push(`/admin?season=${encodeURIComponent(savedSeasonId)}`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the season.");
    } finally {
      setSaving(false);
    }
  }

  async function sendInvites() {
    if (!seasonId) return;
    setSending(true); setStatus(""); setError("");
    try {
      const response = await fetch(`/api/admin/seasons/${seasonId}/invites`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not send invites.");
      setStatus(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send invites.");
    } finally { setSending(false); }
  }

  async function deleteSeason() {
    if (!seasonId || !window.confirm("Delete this season and all associated schedules and commitments?")) return;
    const response = await fetch(`/api/admin/seasons/${seasonId}`, { method: "DELETE" });
    if (response.ok) router.push("/admin"); else setError((await response.json()).error || "Could not delete the season.");
  }

  async function resetStats() {
    if (!seasonId || !window.confirm("Reset responsiveness scores for every player in this season?")) return;
    const response = await fetch(`/api/admin/seasons/${seasonId}/reset-stats`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not reset scores."); else setStatus("Responsiveness scores reset");
  }

  return (
    <main className="min-h-screen bg-slate-50 font-mono text-[13px] text-slate-900">
      <div className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-slate-300 bg-white px-4">
        <button className="font-bold" type="button" onClick={() => router.push("/")}>OnlySubs</button>
        <select aria-label="Season" className="h-8 min-w-64 border border-slate-300 bg-white px-2" value={seasonId} onChange={(event) => selectSeason(event.target.value)}>
          <option value="">New season</option>
          {seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}
        </select>
        <input aria-label="Season name" className="h-8 min-w-72 border border-slate-300 px-2" value={name} onChange={(event) => setName(event.target.value)} placeholder="Season name" />
        {seasonId && <span className="border border-slate-300 px-2 py-1 text-[11px]">{initialData?.season.is_published ? "Published" : "Draft"}</span>}
        <div className="ml-auto flex gap-2">
          <Link className="flex h-8 items-center border border-slate-300 px-3 hover:bg-slate-50" href="/">Player view</Link>
          <button className="h-8 border border-slate-400 px-3 disabled:opacity-50" disabled={saving} onClick={saveSeason} type="button">{saving ? "Saving" : "Save"}</button>
          <button className="h-8 border border-slate-800 bg-slate-800 px-3 text-white disabled:opacity-50" disabled={!seasonId || sending} onClick={sendInvites} type="button">{sending ? "Sending" : "Send invites"}</button>
        </div>
      </div>

      <div className="px-4 py-3">
        {error && <p className="mb-2 border-l-2 border-red-600 px-2 py-1 text-red-700">{error}</p>}
        {status && <p className="mb-2 border-l-2 border-emerald-600 px-2 py-1 text-emerald-800">{status}</p>}

        {sessions.map((session, sessionIndex) => {
          const savedDates = initialData?.sessions.find((item) => item.id === session.id)?.dates ?? [];
          const options = dateOptions(session.weekday, savedDates);
          const mmp = parsedPlayers(session.mmpText, "MMP");
          const fmp = parsedPlayers(session.fmpText, "FMP");
          return (
            <section className="mb-2 border border-slate-300 bg-white" key={session.id ?? sessionIndex}>
              <div className="grid grid-cols-[180px_120px_1fr_auto] items-end gap-2 border-b border-slate-200 p-2">
                <label>Day<select className="mt-1 block h-8 w-full border border-slate-300 px-2" value={session.weekday} onChange={(event) => updateSession(sessionIndex, { weekday: Number(event.target.value) })}>{weekdays.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label>
                <label>Time<input className="mt-1 block h-8 w-full border border-slate-300 px-2" type="time" value={session.startTime} onChange={(event) => updateSession(sessionIndex, { startTime: event.target.value })} /></label>
                <details className="relative"><summary className="flex h-8 cursor-pointer list-none items-center border border-slate-300 px-2">Dates ({session.dates.length} selected)</summary><div className="absolute z-10 mt-1 max-h-72 w-80 overflow-auto border border-slate-300 bg-white p-2 shadow-md"><div className="mb-2 flex gap-3"><button type="button" className="underline" onClick={() => updateSession(sessionIndex, { dates: options })}>Select all</button><button type="button" className="underline" onClick={() => updateSession(sessionIndex, { dates: [] })}>Clear</button></div>{options.map((date) => <label className="flex py-1" key={date}><input className="mr-2" type="checkbox" checked={session.dates.includes(date)} onChange={(event) => updateSession(sessionIndex, { dates: event.target.checked ? [...session.dates, date].sort() : session.dates.filter((value) => value !== date) })} /><span>{formatDate(date)}</span></label>)}</div></details>
                {sessions.length > 1 && <button className="h-8 border border-slate-300 px-2 text-red-700" type="button" onClick={() => setSessions((current) => current.filter((_, index) => index !== sessionIndex))}>Remove</button>}
              </div>
              <div className="grid grid-cols-2 gap-2 p-2">
                {[{ label: "MMPs", gender: "MMP" as const, text: session.mmpText, result: mmp }, { label: "FMPs", gender: "FMP" as const, text: session.fmpText, result: fmp }].map((box) => (
                  <div key={box.label}><label className="block">{box.label}<textarea className="mt-1 h-28 w-full resize-y border border-slate-300 p-2" value={box.text} onChange={(event) => updateSession(sessionIndex, box.gender === "MMP" ? { mmpText: event.target.value } : { fmpText: event.target.value })} /></label><p>{box.result.players.length} {box.result.players.length === 1 ? "player" : "players"} parsed</p>{box.result.unparsedLines.length > 0 && <p className="text-red-700">Unparsed: {box.result.unparsedLines.join(" | ")}</p>}<div className="mt-1 max-h-20 overflow-auto border-t border-slate-200">{box.result.players.slice(0, 8).map((player) => <div className="grid grid-cols-[1fr_1fr]" key={player.email}><span>{player.name || "(name blank)"}</span><span>{player.email}</span></div>)}</div></div>
                ))}
              </div>
            </section>
          );
        })}

        <button className="mb-3 h-8 border border-slate-400 px-3" type="button" onClick={() => setSessions((current) => [...current, blankSession()])}>+ Add session</button>

        <section className="mb-2 border border-slate-300 bg-white p-2"><label className="block">Additional season invitees (pool-only)<textarea className="mt-1 h-24 w-full border border-slate-300 p-2" value={extraText} onChange={(event) => setExtraText(event.target.value)} /></label></section>

        <section className="border border-slate-300 bg-white">
          <button className="h-9 w-full px-3 text-left" type="button" onClick={() => setSettingsOpen((open) => !open)}>Settings {settingsOpen ? "[-]" : "[+]"}</button>
          {settingsOpen && <div className="border-t border-slate-200 p-3">
            <div className="mb-3 flex items-center gap-3"><label>Rules PDF<input className="ml-2" type="file" accept="application/pdf" onChange={(event) => setRulesPdfFile(event.target.files?.[0] ?? null)} /></label>{initialData?.season.rules_pdf_url && <button className="border border-slate-300 px-2 py-1" type="button" onClick={() => setRemoveRulesPdf(true)}>Remove</button>}<a className="underline" href={initialData?.season.rules_pdf_url ?? undefined} target="_blank">{initialData?.season.rules_pdf_name ?? ""}</a></div>
            <button className="border border-slate-300 px-2 py-1" type="button" onClick={() => setAdvancedOpen((open) => !open)}>Advanced settings {advancedOpen ? "[-]" : "[+]"}</button>
            {advancedOpen && <div className="mt-3 grid grid-cols-4 gap-3"><label>Timeout hours<input className="block h-8 w-full border px-2" type="number" min={1} max={168} value={timeoutHours} onChange={(e) => setTimeoutHours(Number(e.target.value))} /></label><label>Day start<input className="block h-8 w-full border px-2" type="number" min={0} max={23} value={dayStart} onChange={(e) => setDayStart(Number(e.target.value))} /></label><label>Day end<input className="block h-8 w-full border px-2" type="number" min={0} max={23} value={dayEnd} onChange={(e) => setDayEnd(Number(e.target.value))} /></label><label>Timezone<input className="block h-8 w-full border px-2" value={timezone} onChange={(e) => setTimezone(e.target.value)} /></label><label>Game price<input className="block h-8 w-full border px-2" value={gamePrice} onChange={(e) => setGamePrice(e.target.value)} /></label><label>Global claim hours<input className="block h-8 w-full border px-2" type="number" value={globalClaim} onChange={(e) => setGlobalClaim(Number(e.target.value))} /></label><label>Gender claim hours<input className="block h-8 w-full border px-2" type="number" value={genderClaim} onChange={(e) => setGenderClaim(Number(e.target.value))} /></label><label>Claims free<select className="block h-8 w-full border px-2" value={claimsFree ? "yes" : "no"} onChange={(e) => setClaimsFree(e.target.value === "yes")}><option value="yes">Yes</option><option value="no">No</option></select></label></div>}
            <div className="mt-4 flex gap-2"><button className="border border-slate-400 px-2 py-1" disabled={!seasonId} type="button" onClick={resetStats}>Reset responsiveness score</button><button className="border border-red-500 px-2 py-1 text-red-700" disabled={!seasonId} type="button" onClick={deleteSeason}>Delete season</button></div>
          </div>}
        </section>
      </div>
    </main>
  );
}
