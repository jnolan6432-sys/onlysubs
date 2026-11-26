"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdminGameCancelButton({
  gameId,
  cancelled,
}: {
  gameId: string;
  cancelled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggleCancellation() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/games/${gameId}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cancelled: !cancelled }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not update game.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update game.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span>
      <button
        className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-200 disabled:opacity-50"
        disabled={busy}
        onClick={toggleCancellation}
        type="button"
      >
        {busy ? "Saving..." : cancelled ? "Restore game" : "Cancel game"}
      </button>
      {error && <span className="block text-xs text-red-700">{error}</span>}
    </span>
  );
}
