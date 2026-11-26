import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  _request: Request,
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
    return NextResponse.json({ error: "Sign in to claim a spot." }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("claim_game_spot", {
    p_game_id: gameId,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (data?.result === "closed") {
    return NextResponse.json(
      { error: "The game has already started." },
      { status: 409 },
    );
  }

  return NextResponse.json(data);
}
