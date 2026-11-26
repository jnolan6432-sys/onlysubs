import { NextRequest, NextResponse } from "next/server";
import { authorizeAdmin, errorResponse } from "@/lib/admin-api";
import { createServiceClient } from "@/lib/admin";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ seasonId: string }> },
) {
  try {
    const { response } = await authorizeAdmin();
    if (response) return response;
    const { seasonId } = await params;
    if (!uuidPattern.test(seasonId)) {
      return NextResponse.json({ error: "Invalid season." }, { status: 400 });
    }
    const body = await request.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof body.session_id !== "string" ||
      typeof body.game_date !== "string"
    ) {
      return NextResponse.json({ error: "Choose a session and game date." }, { status: 400 });
    }
    if (!uuidPattern.test(body.session_id) || !/^\d{4}-\d{2}-\d{2}$/.test(body.game_date)) {
      return NextResponse.json({ error: "Invalid game date or session." }, { status: 400 });
    }

    const serviceClient = createServiceClient();
    const { data: session, error: sessionError } = await serviceClient
      .from("sessions")
      .select("id, season_id, start_time")
      .eq("id", body.session_id)
      .eq("season_id", seasonId)
      .maybeSingle();
    if (sessionError) throw new Error(sessionError.message);
    if (!session) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    const { data: game, error: gameError } = await serviceClient
      .from("games")
      .insert({
        season_id: seasonId,
        session_id: session.id,
        game_date: body.game_date,
        start_time: session.start_time,
      })
      .select("id")
      .single();
    if (gameError) {
      return NextResponse.json({ error: gameError.message }, { status: 400 });
    }
    return NextResponse.json({ game_id: game.id });
  } catch (error) {
    return errorResponse(error);
  }
}
