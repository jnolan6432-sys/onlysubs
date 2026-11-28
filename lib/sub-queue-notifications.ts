import "server-only";

import { sendNotification, setVapidDetails } from "web-push";
import type { PushSubscription } from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";

export type SubQueueEvent = {
  event: "ping" | "filled" | "exhausted" | "cancelled";
  request_id: string;
  recipient_user_id?: string | null;
  requester_id?: string;
  game_id?: string;
  game_date?: string;
  start_time?: string;
  season_name?: string;
  expires_at?: string;
  push_needed?: boolean;
  email_needed?: boolean;
};

type Delivery = {
  event: string;
  requestId: string;
  recipientUserId: string | null;
  pushSent: number;
  emailSent: boolean;
  error?: string;
};

const pingWeekdays = ["Sun", "Mon", "Tues", "Wed", "Thurs", "Fri", "Sat"];
const pingMonths = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatPingDate(gameDate: string | undefined) {
  if (!gameDate) return null;
  const [year, month, day] = gameDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.valueOf()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return `${pingWeekdays[date.getUTCDay()]} ${pingMonths[month - 1]} ${day}`;
}

async function sendPush(
  serviceClient: SupabaseClient,
  userId: string,
  payload: Record<string, unknown>,
) {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) {
    return { sent: 0, handled: false, error: "VAPID server keys are not configured." };
  }

  const { data: subscriptions, error: queryError } = await serviceClient
    .from("push_subscriptions")
    .select("id, subscription_json")
    .eq("user_id", userId);
  if (queryError) throw new Error(`Could not load push subscriptions: ${queryError.message}`);
  if (!subscriptions?.length) return { sent: 0, handled: true };

  setVapidDetails(subject, publicKey, privateKey);
  const results = await Promise.allSettled(
    subscriptions.map((subscription) =>
      sendNotification(
        subscription.subscription_json as PushSubscription,
        JSON.stringify(payload),
      ),
    ),
  );
  const staleIds = results.flatMap((result, index) =>
    result.status === "rejected" &&
    [404, 410].includes(Number(result.reason?.statusCode))
      ? [subscriptions[index].id]
      : [],
  );
  if (staleIds.length) {
    const { error: deleteError } = await serviceClient
      .from("push_subscriptions")
      .delete()
      .in("id", staleIds);
    if (deleteError) {
      throw new Error(`Could not remove expired push subscriptions: ${deleteError.message}`);
    }
  }

  const sent = results.filter((result) => result.status === "fulfilled").length;
  const rejected = results.filter((result) => result.status === "rejected");
  return {
    sent,
    handled: sent > 0 || rejected.length === staleIds.length,
    ...(sent === 0 && rejected.length > staleIds.length
      ? { error: "Push delivery failed for all active subscriptions." }
      : {}),
  };
}

async function sendAdminEmail(
  serviceClient: SupabaseClient,
  userId: string,
  event: SubQueueEvent,
) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    return { sent: false, error: "Email delivery is not configured." };
  }

  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select("email")
    .eq("id", userId)
    .single();
  if (profileError) throw new Error(`Could not load the season admin email: ${profileError.message}`);
  if (!profile.email) return { sent: false, error: "Season admin has no email address." };

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [profile.email],
      subject: `No substitute found for ${event.season_name ?? "your season"}`,
      text: `No substitute was found for ${event.game_date ?? "the game"} at ${
        event.start_time?.slice(0, 5) ?? "the scheduled time"
      } in ${event.season_name ?? "your season"}. The sub request has been exhausted.`,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    return { sent: false, error: `Email provider returned ${response.status}: ${detail}` };
  }
  return { sent: true };
}

export async function dispatchSubQueueEvents(
  serviceClient: SupabaseClient,
  events: SubQueueEvent[],
) {
  const deliveries: Delivery[] = [];

  for (const event of events) {
    const recipient = event.recipient_user_id ?? null;
    let pushSent = 0;
    let emailSent = false;
    const errors: string[] = [];

    try {
      if (event.event === "ping" && recipient) {
        if (!event.game_id) {
          throw new Error("Cannot verify a sub ping without its game ID.");
        }
        const { error: prepareError } = await serviceClient.rpc(
          "prepare_game_claim_phase",
          { p_game_id: event.game_id },
        );
        if (prepareError) {
          throw new Error(`Could not check the game's claim window: ${prepareError.message}`);
        }
        const { data: request, error: requestError } = await serviceClient
          .from("sub_requests")
          .select("status, current_pinged_user_id")
          .eq("id", event.request_id)
          .maybeSingle();
        if (requestError) {
          throw new Error(`Could not verify the pending sub ping: ${requestError.message}`);
        }
        if (
          request?.current_pinged_user_id === recipient &&
          ["searching_primary", "searching_fallback"].includes(request.status)
        ) {
          const pingDate = formatPingDate(event.game_date);
          if (!pingDate) throw new Error("Cannot format a sub ping without a valid game date.");
          const push = await sendPush(serviceClient, recipient, {
            title: "Sub request",
            body: `Sub in for ${pingDate}?`,
            url: event.game_id ? `/?game=${event.game_id}` : "/",
            requestId: event.request_id,
            actions: [
              { action: "accept", title: "Accept Spot" },
              { action: "pass", title: "Pass" },
            ],
          });
          pushSent = push.sent;
          if (push.error) errors.push(push.error);
          const { error: markError } = await serviceClient.rpc(
            "mark_sub_queue_notification",
            {
              p_request_id: event.request_id,
              p_recipient_user_id: recipient,
              p_event_type: "ping",
              p_delivered: push.handled,
            },
          );
          if (markError) errors.push(`Could not record ping delivery: ${markError.message}`);
        }
      } else if (event.event === "exhausted" && recipient) {
        if (event.email_needed !== false) {
          const email = await sendAdminEmail(serviceClient, recipient, event);
          emailSent = email.sent;
          if (email.error) errors.push(email.error);
          const { error: markError } = await serviceClient.rpc(
            "mark_sub_queue_notification",
            {
              p_request_id: event.request_id,
              p_recipient_user_id: recipient,
              p_event_type: "exhausted_email",
              p_delivered: email.sent,
            },
          );
          if (markError) errors.push(`Could not record admin email delivery: ${markError.message}`);
        }
      } else if (event.event === "filled" && recipient) {
        pushSent = 0;
      }
    } catch (caught) {
      errors.push(
        caught instanceof Error ? caught.message : "Notification delivery failed.",
      );
    }

    deliveries.push({
      event: event.event,
      requestId: event.request_id,
      recipientUserId: recipient,
      pushSent,
      emailSent,
      ...(errors.length ? { error: errors.join(" ") } : {}),
    });
  }

  return deliveries;
}
