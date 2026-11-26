import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/admin";
import {
  dispatchSubQueueEvents,
  type SubQueueEvent,
} from "@/lib/sub-queue-notifications";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest, secret: string) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expected = Buffer.from(secret);
  const provided = Buffer.from(token);
  return (
    expected.length === provided.length &&
    timingSafeEqual(expected, provided)
  );
}

async function runWorker(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured." },
      { status: 503 },
    );
  }
  if (!isAuthorized(request, secret)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const serviceClient = createServiceClient();
    const { data, error } = await serviceClient.rpc("run_sub_queue_worker", {
      p_limit: 100,
    });
    if (error) throw new Error(`Queue worker failed: ${error.message}`);

    const events = (data?.events ?? []) as SubQueueEvent[];
    const notifications = await dispatchSubQueueEvents(serviceClient, events);
    const notificationFailures = notifications.filter((item) => item.error);

    return NextResponse.json({
      processed: data?.processed ?? 0,
      events: events.length,
      notifications,
      ...(notificationFailures.length
        ? { notificationFailures: notificationFailures.length }
        : {}),
    });
  } catch (caught) {
    const message =
      caught instanceof Error ? caught.message : "The queue worker failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return runWorker(request);
}

export async function POST(request: NextRequest) {
  return runWorker(request);
}
