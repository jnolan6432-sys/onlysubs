"use client";

import Link from "next/link";
import { useState } from "react";
import { SendInvitesButton } from "@/app/admin/ui/send-invites-button";

export type SeasonListItem = {
  id: string;
  name: string;
  is_published: boolean;
  sessionCount: number;
  gameDateCount: number;
  playerCount: number;
};

const deleteConfirmation =
  "Are you sure you want to delete this season? This will permanently remove all associated schedules and player commitments.";

export function SeasonsList({ initialSeasons }: { initialSeasons: SeasonListItem[] }) {
  const [seasons, setSeasons] = useState(initialSeasons);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function deleteSeason(seasonId: string) {
    if (!window.confirm(deleteConfirmation)) return;

    setDeletingId(seasonId);
    setErrors((current) => ({ ...current, [seasonId]: "" }));
    try {
      const response = await fetch(`/api/admin/seasons/${seasonId}`, {
        method: "DELETE",
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Could not delete the season.");
      }

      setSeasons((current) => current.filter((season) => season.id !== seasonId));
    } catch (caught) {
      setErrors((current) => ({
        ...current,
        [seasonId]:
          caught instanceof Error ? caught.message : "Could not delete the season.",
      }));
    } finally {
      setDeletingId(null);
    }
  }

  return seasons.length ? (
    <div className="mt-8 space-y-4">
      {seasons.map((season) => (
        <section
          className="flex flex-wrap items-center justify-between gap-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
          key={season.id}
        >
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                {season.name}
              </h2>
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                  season.is_published
                    ? "bg-teal-50 text-teal-800"
                    : "bg-amber-50 text-amber-800"
                }`}
              >
                {season.is_published ? "Published" : "Draft"}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-600">
              {season.sessionCount} sessions · {season.gameDateCount} game dates ·{" "}
              {season.playerCount} players
            </p>
            {errors[season.id] && (
              <p aria-live="polite" className="mt-2 text-sm text-red-700">
                {errors[season.id]}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              href={`/admin/seasons/${season.id}/edit`}
            >
              Edit Season
            </Link>
            <Link
              className="rounded-lg border border-blue-300 px-4 py-2.5 text-sm font-semibold text-blue-800 hover:bg-blue-50"
              href={`/admin/seasons/${season.id}`}
            >
              Add No-Games
            </Link>
            <SendInvitesButton seasonId={season.id} />
            <button
              className="rounded-lg border border-red-300 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
              disabled={deletingId === season.id}
              onClick={() => deleteSeason(season.id)}
              type="button"
            >
              {deletingId === season.id ? "Deleting..." : "Delete Season"}
            </button>
          </div>
        </section>
      ))}
    </div>
  ) : (
    <p className="mt-8 rounded-xl border border-slate-200 bg-white p-6 text-slate-600">
      No seasons have been created yet.{" "}
      <Link
        className="font-semibold text-teal-800 underline"
        href="/admin/seasons/new"
      >
        Build a new season
      </Link>
      .
    </p>
  );
}
