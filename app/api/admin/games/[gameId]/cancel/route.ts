import { NextRequest, NextResponse } from "next/server";
import { authorizeAdmin } from "@/lib/admin-api";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ gameId: string }> },
) {
  const { context, response } = await authorizeAdmin();
  if (!context) return response;

  const { gameId } = await params;
  if (!uuidPattern.test(gameId)) {
    return NextResponse.json({ error: "Invalid game." }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as { cancelled?: unknown }).cancelled !== "boolean"
  ) {
    return NextResponse.json({ error: "Choose whether to cancel the game." }, {
      status: 400,
    });
  }

  const { error } = await context.supabase.rpc("set_game_cancelled", {
    p_game_id: gameId,
    p_cancelled: (payload as { cancelled: boolean }).cancelled,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ game_id: gameId, cancelled: (payload as { cancelled: boolean }).cancelled });
}
