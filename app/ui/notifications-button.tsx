"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

function decodeVapidKey(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function NotificationsButton() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function enableNotifications() {
    setBusy(true);
    setMessage("");
    setError("");

    try {
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) {
        throw new Error("Set NEXT_PUBLIC_VAPID_PUBLIC_KEY to enable push.");
      }
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        throw new Error("Push notifications are not supported by this browser.");
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error("Allow notifications in your browser settings to continue.");
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeVapidKey(vapidKey),
        }));

      const supabase = createClient();
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();
      if (userError) throw userError;
      if (!user) throw new Error("Sign in before enabling notifications.");

      const { data: savedSubscriptions, error: queryError } = await supabase
        .from("push_subscriptions")
        .select("id, subscription_json")
        .eq("user_id", user.id);
      if (queryError) throw queryError;

      const existing = savedSubscriptions.find(
        (row) =>
          (row.subscription_json as PushSubscriptionJSON).endpoint ===
          subscription.endpoint,
      );
      const values = {
        user_id: user.id,
        subscription_json: subscription.toJSON(),
      };

      const { error: saveError } = existing
        ? await supabase
            .from("push_subscriptions")
            .update(values)
            .eq("id", existing.id)
        : await supabase.from("push_subscriptions").insert(values);
      if (saveError) throw saveError;

      setMessage("Notifications are enabled on this device.");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not enable notifications.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className="rounded-lg bg-teal-800 px-4 py-3 font-semibold text-white hover:bg-teal-900 disabled:cursor-wait disabled:opacity-60"
        disabled={busy}
        onClick={enableNotifications}
        type="button"
      >
        {busy ? "Enabling..." : "Enable notifications"}
      </button>
      {message && (
        <p aria-live="polite" className="mt-2 text-sm text-teal-800">
          {message}
        </p>
      )}
      {error && (
        <p aria-live="polite" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
