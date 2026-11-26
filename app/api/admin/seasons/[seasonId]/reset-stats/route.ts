import { NextResponse } from "next/server";
import { authorizeAdmin, errorResponse } from "@/lib/admin-api";
import { createServiceClient } from "@/lib/admin";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  try {
    const { context, response } = await authorizeAdmin();
    if (!context) return response;

    const { seasonId } = await params;
    if (!uuidPattern.test(seasonId)) {
      return NextResponse.json({ error: "The season ID is invalid." }, { status: 400 });
    }

    const serviceClient = createServiceClient();
    const { data: season, error: seasonError } = await serviceClient
      .from("seasons")
      .select("id")
      .eq("id", seasonId)
      .maybeSingle();
    if (seasonError) throw new Error(`Could not load season: ${seasonError.message}`);
    if (!season) return NextResponse.json({ error: "Season not found." }, { status: 404 });

    const { error } = await serviceClient
      .from("player_season_stats")
      .update({ pings_received: 0, pings_answered_in_time: 0 })
      .eq("season_id", seasonId);
    if (error) throw new Error(`Could not reset responsiveness scores: ${error.message}`);

    return NextResponse.json({ reset: true });
  } catch (error) {
    return errorResponse(error);
  }
}
