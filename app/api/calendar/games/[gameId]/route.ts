import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/admin";
import {
  dispatchSubQueueEvents,
  type SubQueueEvent,
} from "@/lib/sub-queue-notifications";
import { createClient } from "@/lib/supabase/server";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const { gameId } = await params;
  if (!uuidPattern.test(gameId)) {
    return NextResponse.json({ error: "Invalid game." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Sign in to update your calendar." }, { status: 401 });
  }

  const playerTimezone = request.headers.get("x-player-timezone");
  if (playerTimezone) {
    try {
      if (playerTimezone.length > 100) throw new RangeError();
      new Intl.DateTimeFormat("en", { timeZone: playerTimezone });
    } catch {
      return NextResponse.json(
        { error: "Invalid player timezone." },
        { status: 400 },
      );
    }

    const { error: timezoneError } = await supabase
      .from("profiles")
      .update({ timezone: playerTimezone })
      .eq("id", user.id);
    if (timezoneError) {
      return NextResponse.json(
        { error: `Could not update your local timezone: ${timezoneError.message}` },
        { status: 500 },
      );
    }
  }

  const serviceClientForCommitment = createServiceClient();
  const { data: gameMembership, error: membershipError } = await serviceClientForCommitment
    .from("games")
    .select("season_id")
    .eq("id", gameId)
    .maybeSingle();
  if (membershipError) {
    return NextResponse.json(
      { error: `Could not load the game: ${membershipError.message}` },
      { status: 500 },
    );
  }
  if (gameMembership) {
    const { data: membership } = await serviceClientForCommitment
      .from("season_pool_members")
      .select("user_id")
      .eq("season_id", gameMembership.season_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membership) {
      const { error: commitmentError } = await serviceClientForCommitment
        .from("game_commitments")
        .upsert(
          { game_id: gameId, user_id: user.id, status: "unavailable" },
          { onConflict: "game_id,user_id", ignoreDuplicates: true },
        );
      if (
        commitmentError &&
        !commitmentError.message.includes("duplicate") &&
        commitmentError.code !== "23505"
      ) {
        return NextResponse.json(
          { error: `Could not create your game commitment: ${commitmentError.message}` },
          { status: 500 },
        );
      }
    }
  }

  const { data, error } = await supabase.rpc("update_game_commitment", {
    p_game_id: gameId,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const result = data as {
    status: string;
    sub_request_id: string | null;
    reactivated_request_id: string | null;
    queue_request_id: string | null;
  };
  const queueRequestId =
    result.sub_request_id ?? result.queue_request_id;
  if (!queueRequestId) {
    return NextResponse.json({
      ...result,
      notifications: [],
    });
  }

  let serviceClient: ReturnType<typeof createServiceClient>;
  try {
    serviceClient = createServiceClient();
  } catch (caught) {
    return NextResponse.json({
      ...result,
      queueError:
        caught instanceof Error
          ? `The request was updated, but the queue worker is not configured: ${caught.message}`
          : "The request was updated, but the queue worker is not configured.",
      notifications: [],
    });
  }

  const { data: workerResult, error: processError } = await serviceClient.rpc(
    "run_sub_queue_worker",
    { p_limit: 100 },
  );
  if (processError) {
    return NextResponse.json({
      ...result,
      queueError: `The request was updated, but the queue could not be advanced: ${processError.message}`,
      notifications: [],
    });
  }

  const events = (workerResult?.events ?? []) as SubQueueEvent[];
  const event = events.find(
    (item) => item.request_id === queueRequestId,
  );
  const { data: updatedRequest, error: requestError } = await serviceClient
    .from("sub_requests")
    .select("status")
    .eq("id", queueRequestId)
    .maybeSingle();
  if (requestError) {
    return NextResponse.json({
      ...result,
      queueError: `The request was updated, but its queue status could not be checked: ${requestError.message}`,
      notifications: [],
    });
  }
  const queueEvent =
    event ??
    (updatedRequest?.status === "paused"
      ? { event: "paused", request_id: queueRequestId }
      : undefined);
  try {
    const notifications = await dispatchSubQueueEvents(
      serviceClient,
      events,
    );
    return NextResponse.json({
      ...result,
      queue_event: queueEvent,
      notifications,
    });
  } catch (caught) {
    return NextResponse.json({
      ...result,
      queue_event: queueEvent,
      queueError:
        caught instanceof Error
          ? `The request was updated, but notifications could not be sent: ${caught.message}`
          : "The request was updated, but notifications could not be sent.",
      notifications: [],
    });
  }
}
