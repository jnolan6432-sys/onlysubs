"use client";

import { useState } from "react";

export function SendInvitesButton({ seasonId }: { seasonId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function sendInvites() {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(
        `/api/admin/seasons/${seasonId}/invites`,
        { method: "POST" },
      );
      const result = await response.json();
      if (!response.ok && !result.message) {
        throw new Error(result.error || "Could not send invites.");
      }
      if (result.failed?.length) {
        setError(
          `${result.message} ${result.failed
            .map((item: { email: string; error: string }) => `${item.email}: ${item.error}`)
            .join("; ")}`,
        );
      } else {
        setMessage(result.message);
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not send invites.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className="rounded-lg bg-teal-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-900 disabled:cursor-wait disabled:opacity-60"
        disabled={busy}
        onClick={sendInvites}
        type="button"
      >
        {busy ? "Sending..." : "Send Invites"}
      </button>
      {(message || error) && (
        <p
          aria-live="polite"
          className={`mt-2 max-w-md text-sm ${error ? "text-red-700" : "text-teal-800"}`}
        >
          {error || message}
        </p>
      )}
    </div>
  );
}
