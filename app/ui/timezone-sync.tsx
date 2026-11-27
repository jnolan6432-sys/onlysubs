"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

export function TimezoneSync() {
  useEffect(() => {
    const supabase = createClient();
    let userId: string | null = null;
    let lastSavedTimezone: string | null = null;
    let profileLoaded = false;
    let syncing = false;

    async function syncTimezone() {
      if (syncing) return;
      syncing = true;
      try {
        if (!profileLoaded) {
          const {
            data: { user },
            error: userError,
          } = await supabase.auth.getUser();
          if (userError) {
            if (userError.name === "AuthSessionMissingError") {
              profileLoaded = true;
              userId = null;
              return;
            }
            console.error(
              "Could not check the current user for timezone sync:",
              userError.message,
            );
            return;
          }
          userId = user?.id ?? null;
          lastSavedTimezone = null;
          profileLoaded = true;
          if (!userId) return;

          const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("timezone")
            .eq("id", userId)
            .maybeSingle();
          if (profileError) {
            profileLoaded = false;
            console.error("Could not load your saved timezone:", profileError.message);
            return;
          }
          lastSavedTimezone = profile?.timezone ?? null;
        }

        if (!userId) return;
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (!timezone || timezone === lastSavedTimezone) return;

        const { error } = await supabase
          .from("profiles")
          .update({ timezone })
          .eq("id", userId);
        if (error) {
          console.error("Could not sync your local timezone:", error.message);
          return;
        }

        lastSavedTimezone = timezone;
      } catch (error) {
        console.error("Could not sync your local timezone:", error);
      } finally {
        syncing = false;
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user.id ?? null;
      if (nextUserId === userId) return;
      userId = nextUserId;
      lastSavedTimezone = null;
      profileLoaded = false;
      window.setTimeout(() => void syncTimezone(), 0);
    });

    void syncTimezone();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void syncTimezone();
    };
    window.addEventListener("focus", syncTimezone);
    window.addEventListener("pointerdown", syncTimezone);
    window.addEventListener("keydown", syncTimezone);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", syncTimezone);
      window.removeEventListener("pointerdown", syncTimezone);
      window.removeEventListener("keydown", syncTimezone);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      subscription.unsubscribe();
    };
  }, []);

  return null;
}
