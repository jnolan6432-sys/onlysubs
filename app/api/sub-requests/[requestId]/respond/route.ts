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
  { params }: { params: Promise<{ requestId: string }> },
) {
  const { requestId } = await params;
  if (!uuidPattern.test(requestId)) {
    return NextResponse.json({ error: "Invalid substitute request." }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Sign in to respond." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid response." }, { status: 400 });
  }
  const action =
    typeof payload === "object" && payload !== null
      ? (payload as { action?: unknown }).action
      : null;
  if (action !== "accept" && action !== "pass") {
    return NextResponse.json({ error: "Choose accept or pass." }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("respond_to_sub_ping", {
    p_request_id: requestId,
    p_action: action,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const events = (data?.events ?? []) as SubQueueEvent[];
  let notifications: Awaited<ReturnType<typeof dispatchSubQueueEvents>> = [];
  let notificationError: string | undefined;
  try {
    notifications = await dispatchSubQueueEvents(createServiceClient(), events);
  } catch (caught) {
    notificationError =
      caught instanceof Error ? caught.message : "Notification delivery failed.";
  }

  return NextResponse.json({
    result: data?.result,
    notifications,
    ...(notificationError ? { notificationError } : {}),
  });
}
